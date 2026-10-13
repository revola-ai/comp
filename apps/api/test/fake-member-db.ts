import { fakeClient, type FakeClient } from './fake-member-db-client';

/**
 * An in-memory stand-in for the User, Member and ApiKey tables that models
 * what the offboarding race depends on: `SELECT ... FOR UPDATE` row locks held
 * until the transaction ends, the ApiKey -> Member foreign key (an insert
 * needs the member row; deleting a member sets createdByMemberId to NULL), the
 * user cascade, and transaction rollback: every write inside `$transaction`
 * is journaled and undone if the transaction throws. Tests pause or fail an
 * operation to force an interleaving or a failure mid-transaction.
 */

export type FakeMember = {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  isActive: boolean;
  deactivated: boolean;
};

export type FakeUser = { id: string; banned: boolean | null };

export type FakeApiKey = {
  id: string;
  organizationId: string;
  createdByMemberId: string | null;
  organizationOwned: boolean;
  isActive: boolean;
  createdAt: Date;
  expiresAt: null;
};

type Generated = 'id' | 'isActive' | 'createdAt' | 'expiresAt';

export type FakeOperation =
  | 'apiKey.create'
  | 'apiKey.updateMany'
  | 'member.update'
  | 'member.delete'
  | 'user.update'
  | 'user.delete';

/** Undo steps of the writes made so far in one transaction; null outside one. */
export type Journal = Array<() => void> | null;

/** Puts a row back exactly as it was, dropping columns a write added. */
function restore<Row extends object>({
  row,
  previous,
}: {
  row: Row;
  previous: Row;
}): void {
  for (const key of Object.keys(row)) {
    if (!(key in previous)) Reflect.deleteProperty(row, key);
  }
  Object.assign(row, previous);
}

export class FakeMemberDb {
  readonly members = new Map<string, FakeMember>();
  readonly users = new Map<string, FakeUser>();
  readonly keys: FakeApiKey[] = [];
  readonly lockLog: string[] = [];
  private readonly locks = new Map<string, Promise<void>>();
  private readonly pauses = new Map<FakeOperation, Promise<void>>();
  private readonly failures = new Map<FakeOperation, Error>();
  private keySequence = 0;

  addMember(
    member: Omit<FakeMember, 'isActive' | 'deactivated' | 'role'> & {
      role?: string;
    },
  ): void {
    if (!this.users.has(member.userId)) {
      this.users.set(member.userId, { id: member.userId, banned: null });
    }
    this.members.set(member.id, {
      role: 'admin',
      ...member,
      isActive: true,
      deactivated: false,
    });
  }

  addKey(key: Omit<FakeApiKey, Generated>): FakeApiKey {
    return this.insertKey({ key, journal: null });
  }

  /** Keys that would still authenticate as personal keys of this member. */
  usableKeysOf(memberId: string): FakeApiKey[] {
    const member = this.members.get(memberId);
    if (!member || member.deactivated || !member.isActive) return [];
    return this.keys.filter(
      (key) => key.createdByMemberId === memberId && key.isActive,
    );
  }

  /** Calls outside a transaction (better-auth's adapter reads and writes). */
  private get autocommit(): FakeClient {
    return fakeClient({ db: this, held: [], journal: null });
  }

  get member() {
    return this.autocommit.member;
  }

  get user() {
    return this.autocommit.user;
  }

  /** Prisma also exposes each model under its schema name (db.User, db.Member). */
  get Member() {
    return this.member;
  }

  get User() {
    return this.user;
  }

  /** Holds the next call of `operation` until `until` resolves. */
  pauseNext({
    operation,
    until,
  }: {
    operation: FakeOperation;
    until: Promise<void>;
  }): void {
    this.pauses.set(operation, until);
  }

  /** Makes the next call of `operation` throw `error` without writing. */
  failNext({
    operation,
    error,
  }: {
    operation: FakeOperation;
    error: Error;
  }): void {
    this.failures.set(operation, error);
  }

  /** Runs a table operation as an async call, honouring pauses and failures. */
  async step<T>({
    operation,
    run,
  }: {
    operation: FakeOperation | null;
    run: () => T;
  }): Promise<T> {
    const pause = operation ? this.pauses.get(operation) : undefined;
    if (operation) this.pauses.delete(operation);
    await pause;
    const failure = operation ? this.failures.get(operation) : undefined;
    if (operation) this.failures.delete(operation);
    if (failure) throw failure;
    return run();
  }

  async $transaction<T>(run: (tx: FakeClient) => Promise<T>): Promise<T> {
    const held: Array<() => void> = [];
    const journal: Array<() => void> = [];
    try {
      return await run(fakeClient({ db: this, held, journal }));
    } catch (error) {
      for (const undo of journal.reverse()) undo();
      throw error;
    } finally {
      for (const release of held) release();
    }
  }

  async lock({
    id,
    held,
  }: {
    id: string;
    held: Array<() => void>;
  }): Promise<void> {
    while (this.locks.has(id)) await this.locks.get(id);
    let release: () => void = () => undefined;
    this.locks.set(
      id,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    this.lockLog.push(id);
    held.push(() => {
      this.locks.delete(id);
      release();
    });
  }

  insertKey({
    key,
    journal,
  }: {
    key: Omit<FakeApiKey, Generated>;
    journal: Journal;
  }): FakeApiKey {
    const row = {
      ...key,
      id: `apk_${++this.keySequence}`,
      isActive: true,
      createdAt: new Date(),
      expiresAt: null,
    };
    this.keys.push(row);
    journal?.push(() => this.keys.splice(this.keys.indexOf(row), 1));
    return row;
  }

  setKeysActive({
    rows,
    isActive,
    journal,
  }: {
    rows: FakeApiKey[];
    isActive: boolean;
    journal: Journal;
  }): void {
    for (const row of rows) {
      const previous = row.isActive;
      row.isActive = isActive;
      journal?.push(() => {
        row.isActive = previous;
      });
    }
  }

  updateMemberRow({
    id,
    data,
    journal,
  }: {
    id: string;
    data: Partial<FakeMember>;
    journal: Journal;
  }): FakeMember {
    const member = this.members.get(id);
    if (!member) throw new Error(`P2025: member ${id} not found`);
    const previous = { ...member };
    Object.assign(member, data);
    journal?.push(() => restore({ row: member, previous }));
    return member;
  }

  updateUserRow({
    id,
    data,
    journal,
  }: {
    id: string;
    data: Partial<FakeUser>;
    journal: Journal;
  }): FakeUser {
    const user = this.users.get(id);
    if (!user) throw new Error(`P2025: user ${id} not found`);
    const previous = { ...user };
    Object.assign(user, data);
    journal?.push(() => restore({ row: user, previous }));
    return user;
  }

  deleteMemberRow({ id, journal }: { id: string; journal: Journal }) {
    const member = this.members.get(id);
    if (!member) throw new Error(`P2025: member ${id} not found`);
    this.members.delete(id);
    const orphaned = this.keys.filter((key) => key.createdByMemberId === id);
    for (const key of orphaned) key.createdByMemberId = null;
    journal?.push(() => {
      this.members.set(id, member);
      for (const key of orphaned) key.createdByMemberId = id;
    });
    return member;
  }

  /** Deletes a user and, as the Member.userId cascade does, its memberships. */
  deleteUserRow({ id, journal }: { id: string; journal: Journal }): void {
    const user = this.users.get(id);
    if (!user) throw new Error(`P2025: user ${id} not found`);
    for (const member of [...this.members.values()]) {
      if (member.userId === id)
        this.deleteMemberRow({ id: member.id, journal });
    }
    this.users.delete(id);
    journal?.push(() => this.users.set(id, user));
  }
}

/** A promise the test resolves to let a paused transaction continue. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

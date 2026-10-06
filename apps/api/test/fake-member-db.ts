/**
 * An in-memory stand-in for the Member and ApiKey tables that models what the
 * offboarding race depends on: `SELECT ... FOR UPDATE` row locks held until the
 * transaction ends, the ApiKey -> Member foreign key (an insert needs the
 * member row; deleting a member sets createdByMemberId to NULL), and the user
 * cascade. Tests pause a transaction while it holds a lock to force an
 * interleaving.
 */

export type FakeMember = {
  id: string;
  organizationId: string;
  userId: string;
  isActive: boolean;
  deactivated: boolean;
};

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

type KeyWhere = {
  createdByMemberId?: { in: string[] };
  organizationOwned?: boolean;
  isActive?: boolean;
};

/** Runs a synchronous table operation as an async database call. */
function settled<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

export class FakeMemberDb {
  readonly members = new Map<string, FakeMember>();
  readonly users = new Set<string>();
  readonly keys: FakeApiKey[] = [];
  readonly lockLog: string[] = [];
  private readonly locks = new Map<string, Promise<void>>();
  private readonly pauses = new Map<string, Promise<void>>();
  private keySequence = 0;

  addMember(member: Omit<FakeMember, 'isActive' | 'deactivated'>): void {
    this.users.add(member.userId);
    this.members.set(member.id, {
      ...member,
      isActive: true,
      deactivated: false,
    });
  }

  addKey(key: Omit<FakeApiKey, Generated>): FakeApiKey {
    const row = {
      ...key,
      id: `apk_${++this.keySequence}`,
      isActive: true,
      createdAt: new Date(),
      expiresAt: null,
    };
    this.keys.push(row);
    return row;
  }

  /** Keys that would still authenticate as personal keys of this member. */
  usableKeysOf(memberId: string): FakeApiKey[] {
    const member = this.members.get(memberId);
    if (!member || member.deactivated || !member.isActive) return [];
    return this.keys.filter(
      (key) => key.createdByMemberId === memberId && key.isActive,
    );
  }

  /** Calls outside a transaction (better-auth's adapter reads). */
  get member() {
    return this.transactionClient([]).member;
  }

  get user() {
    return this.transactionClient([]).user;
  }

  /** Holds the next call of `operation` (e.g. 'apiKey.create') until `until` resolves. */
  pauseNext({
    operation,
    until,
  }: {
    operation: 'apiKey.create' | 'apiKey.updateMany';
    until: Promise<void>;
  }): void {
    this.pauses.set(operation, until);
  }

  private afterPause<T>({
    operation,
    run,
  }: {
    operation: string;
    run: () => T;
  }): Promise<T> {
    const pause = this.pauses.get(operation);
    this.pauses.delete(operation);
    return (pause ?? Promise.resolve()).then(() => settled(run));
  }

  async $transaction<T>(run: (tx: FakeTx) => Promise<T>): Promise<T> {
    const held: Array<() => void> = [];
    try {
      return await run(this.transactionClient(held));
    } finally {
      for (const release of held) release();
    }
  }

  private async lock(id: string, held: Array<() => void>): Promise<void> {
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

  private matchingKeys(where: KeyWhere): FakeApiKey[] {
    return this.keys.filter(
      (key) =>
        (!where.createdByMemberId ||
          (key.createdByMemberId !== null &&
            where.createdByMemberId.in.includes(key.createdByMemberId))) &&
        (where.organizationOwned === undefined ||
          key.organizationOwned === where.organizationOwned) &&
        (where.isActive === undefined || key.isActive === where.isActive),
    );
  }

  private deleteMemberRow(id: string): FakeMember {
    const member = this.members.get(id);
    if (!member) throw new Error(`P2025: member ${id} not found`);
    this.members.delete(id);
    for (const key of this.keys) {
      if (key.createdByMemberId === id) key.createdByMemberId = null;
    }
    return member;
  }

  private transactionClient(held: Array<() => void>) {
    const queryRaw = async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<FakeMember[]> => {
      const sql = strings.join('?');
      if (!sql.includes('FOR UPDATE')) throw new Error(`unexpected SQL ${sql}`);
      const [value] = values;
      const ids = sql.includes('"userId" =')
        ? [...this.members.values()]
            .filter((member) => member.userId === value)
            .map((member) => member.id)
        : (value as string[]);
      for (const id of [...ids].sort()) await this.lock(id, held);
      return ids.flatMap((id) => {
        const member = this.members.get(id);
        return member ? [{ ...member }] : [];
      });
    };
    return {
      $queryRaw: queryRaw,
      apiKey: {
        create: ({ data }: { data: Omit<FakeApiKey, Generated> }) =>
          this.afterPause({
            operation: 'apiKey.create',
            run: () => {
              const creator = data.createdByMemberId;
              if (creator && !this.members.has(creator)) {
                throw new Error(
                  'P2003: foreign key violation on createdByMemberId',
                );
              }
              return this.addKey({
                organizationId: data.organizationId,
                createdByMemberId: creator ?? null,
                organizationOwned: data.organizationOwned ?? false,
              });
            },
          }),
        updateMany: ({
          where,
          data,
        }: {
          where: KeyWhere;
          data: { isActive: boolean };
        }) =>
          this.afterPause({
            operation: 'apiKey.updateMany',
            run: () => {
              const rows = this.matchingKeys(where);
              for (const row of rows) row.isActive = data.isActive;
              return { count: rows.length };
            },
          }),
      },
      member: {
        findUnique: ({ where }: { where: { id: string } }) =>
          settled(() => this.members.get(where.id) ?? null),
        findMany: ({ where }: { where: { organizationId?: string } }) =>
          settled(() =>
            [...this.members.values()].filter(
              (member) =>
                !where.organizationId ||
                member.organizationId === where.organizationId,
            ),
          ),
        update: ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<FakeMember>;
        }) =>
          settled(() => {
            const member = this.members.get(where.id);
            if (!member) throw new Error(`P2025: member ${where.id} not found`);
            Object.assign(member, data);
            return member;
          }),
        delete: ({ where }: { where: { id: string } }) =>
          settled(() => this.deleteMemberRow(where.id)),
        deleteMany: ({ where }: { where: { organizationId?: string } }) =>
          settled(() => {
            const rows = [...this.members.values()].filter(
              (member) => member.organizationId === where.organizationId,
            );
            for (const row of rows) this.deleteMemberRow(row.id);
            return { count: rows.length };
          }),
      },
      user: {
        findUnique: ({ where }: { where: { id: string } }) =>
          settled(() => (this.users.has(where.id) ? { id: where.id } : null)),
        delete: ({ where }: { where: { id: string } }) =>
          settled(() => {
            for (const member of [...this.members.values()]) {
              if (member.userId === where.id) this.deleteMemberRow(member.id);
            }
            this.users.delete(where.id);
            return { id: where.id };
          }),
      },
    };
  }
}

export type FakeTx = ReturnType<FakeMemberDb['transactionClient']>;

/** A promise the test resolves to let a paused transaction continue. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

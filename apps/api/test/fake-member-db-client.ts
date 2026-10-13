import type {
  FakeApiKey,
  FakeMember,
  FakeMemberDb,
  FakeUser,
  Journal,
} from './fake-member-db';

/**
 * The Prisma-shaped client FakeMemberDb hands out: autocommit outside a
 * transaction (journal null), journaled inside one. Only the calls the
 * offboarding code and better-auth's adapter make are modelled.
 */

type KeyWhere = {
  createdByMemberId?: { in: string[] };
  organizationOwned?: boolean;
  isActive?: boolean;
};

type MemberWhere = {
  id?: string | { in: string[] };
  organizationId?: string;
  userId?: string;
};

type UserWhere = { id?: string | { in: string[] } };

function idMatches(where: string | { in: string[] } | undefined, id: string) {
  if (where === undefined) return true;
  return typeof where === 'string' ? where === id : where.in.includes(id);
}

function keysMatching({
  keys,
  where,
}: {
  keys: FakeApiKey[];
  where: KeyWhere;
}) {
  return keys.filter(
    (key) =>
      (!where.createdByMemberId ||
        (key.createdByMemberId !== null &&
          where.createdByMemberId.in.includes(key.createdByMemberId))) &&
      (where.organizationOwned === undefined ||
        key.organizationOwned === where.organizationOwned) &&
      (where.isActive === undefined || key.isActive === where.isActive),
  );
}

function membersMatching({
  db,
  where,
}: {
  db: FakeMemberDb;
  where: MemberWhere | undefined;
}): FakeMember[] {
  return [...db.members.values()].filter(
    (member) =>
      idMatches(where?.id, member.id) &&
      (where?.organizationId === undefined ||
        member.organizationId === where.organizationId) &&
      (where?.userId === undefined || member.userId === where.userId),
  );
}

function usersMatching({
  db,
  where,
}: {
  db: FakeMemberDb;
  where: UserWhere | undefined;
}): FakeUser[] {
  return [...db.users.values()].filter((user) => idMatches(where?.id, user.id));
}

function onlyMember({
  db,
  where,
}: {
  db: FakeMemberDb;
  where: MemberWhere;
}): FakeMember {
  const [member] = membersMatching({ db, where });
  if (!member)
    throw new Error(`P2025: member ${JSON.stringify(where)} not found`);
  return member;
}

export function fakeClient({
  db,
  held,
  journal,
}: {
  db: FakeMemberDb;
  held: Array<() => void>;
  journal: Journal;
}) {
  const step = db.step.bind(db);
  return {
    $queryRaw: async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<FakeMember[]> => {
      const sql = strings.join('?');
      if (!sql.includes('FOR UPDATE')) throw new Error(`unexpected SQL ${sql}`);
      const ids = values[0] as string[];
      const memberIds = sql.includes('"userId" = ANY')
        ? [...db.members.values()]
            .filter((member) => ids.includes(member.userId))
            .map((member) => member.id)
        : ids;
      for (const id of [...memberIds].sort()) await db.lock({ id, held });
      return memberIds.flatMap((id) => {
        const member = db.members.get(id);
        return member ? [{ ...member }] : [];
      });
    },
    apiKey: {
      create: ({
        data,
      }: {
        data: Omit<FakeApiKey, 'id' | 'isActive' | 'createdAt' | 'expiresAt'>;
      }) =>
        step({
          operation: 'apiKey.create',
          run: () => {
            const creator = data.createdByMemberId;
            if (creator && !db.members.has(creator)) {
              throw new Error(
                'P2003: foreign key violation on createdByMemberId',
              );
            }
            return db.insertKey({
              key: {
                organizationId: data.organizationId,
                createdByMemberId: creator ?? null,
                organizationOwned: data.organizationOwned ?? false,
              },
              journal,
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
        step({
          operation: 'apiKey.updateMany',
          run: () => {
            const rows = keysMatching({ keys: db.keys, where });
            db.setKeysActive({ rows, isActive: data.isActive, journal });
            return { count: rows.length };
          },
        }),
    },
    member: {
      findUnique: ({ where }: { where: { id: string } }) =>
        step({ operation: null, run: () => db.members.get(where.id) ?? null }),
      findFirstOrThrow: ({ where }: { where: MemberWhere }) =>
        step({
          operation: null,
          run: () => ({ ...onlyMember({ db, where }) }),
        }),
      findMany: ({ where }: { where?: MemberWhere }) =>
        step({ operation: null, run: () => membersMatching({ db, where }) }),
      update: ({
        where,
        data,
      }: {
        where: MemberWhere;
        data: Partial<FakeMember>;
      }) =>
        step({
          operation: 'member.update',
          run: () => {
            const { id } = onlyMember({ db, where });
            return { ...db.updateMemberRow({ id, data, journal }) };
          },
        }),
      updateMany: ({
        where,
        data,
      }: {
        where?: MemberWhere;
        data: Partial<FakeMember>;
      }) =>
        step({
          operation: 'member.update',
          run: () => {
            const rows = membersMatching({ db, where });
            for (const { id } of rows)
              db.updateMemberRow({ id, data, journal });
            return { count: rows.length };
          },
        }),
      delete: ({ where }: { where: MemberWhere }) =>
        step({
          operation: 'member.delete',
          run: () =>
            db.deleteMemberRow({ id: onlyMember({ db, where }).id, journal }),
        }),
      deleteMany: ({ where }: { where?: MemberWhere }) =>
        step({
          operation: 'member.delete',
          run: () => {
            const rows = membersMatching({ db, where });
            for (const { id } of rows) db.deleteMemberRow({ id, journal });
            return { count: rows.length };
          },
        }),
    },
    user: {
      findUnique: ({ where }: { where: { id: string } }) =>
        step({ operation: null, run: () => db.users.get(where.id) ?? null }),
      findMany: ({ where }: { where?: UserWhere }) =>
        step({ operation: null, run: () => usersMatching({ db, where }) }),
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeUser>;
      }) =>
        step({
          operation: 'user.update',
          run: () => ({ ...db.updateUserRow({ id: where.id, data, journal }) }),
        }),
      updateMany: ({
        where,
        data,
      }: {
        where?: UserWhere;
        data: Partial<FakeUser>;
      }) =>
        step({
          operation: 'user.update',
          run: () => {
            const rows = usersMatching({ db, where });
            for (const { id } of rows) db.updateUserRow({ id, data, journal });
            return { count: rows.length };
          },
        }),
      delete: ({ where }: { where: { id: string } }) =>
        step({
          operation: 'user.delete',
          run: () => {
            db.deleteUserRow({ id: where.id, journal });
            return { id: where.id };
          },
        }),
      deleteMany: ({ where }: { where?: UserWhere }) =>
        step({
          operation: 'user.delete',
          run: () => {
            const rows = usersMatching({ db, where });
            for (const { id } of rows) db.deleteUserRow({ id, journal });
            return { count: rows.length };
          },
        }),
    },
  };
}

export type FakeClient = ReturnType<typeof fakeClient>;

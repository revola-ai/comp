import type { Prisma, PrismaClient } from '@db';
import {
  type InTransaction,
  revokeCreatedApiKeys,
  revokeKeysOfUsers,
} from './api-key-access-loss';
import { lockMembersById } from './api-key-member-lock';
import {
  memberUpdateOverrides,
  userUpdateOverrides,
} from './api-key-revoking-updates';

/**
 * The Prisma client better-auth writes through. better-auth deletes Member rows
 * itself (/organization/remove-member, /organization/leave, organization
 * deletion) and Users with their memberships (/admin/remove-user). Each such
 * delete here runs in one transaction that locks the affected member rows,
 * revokes their personal API keys, then deletes. Revocation therefore happens
 * only when better-auth actually deletes, after its own checks, and rolls back
 * with the delete if the delete fails. Deactivations and bans revoke the same
 * way (api-key-revoking-updates.ts); role changes do not revoke.
 *
 * better-auth's Prisma adapter reaches a model as `db[modelName]`, where the
 * name comes from its config: `user.modelName: 'User'` gives `db.User`, the
 * organization plugin's default gives `db.member`. Prisma exposes every model
 * under both casings, so the model is matched case-insensitively; a write
 * through any spelling revokes. Interactive transactions opened through this
 * client hand out a transaction client with the same behaviour.
 *
 * The database triggers of migrations 20261013120100 and 20261013130000
 * enforce the same rule for writes that bypass this client.
 */

type Tx = Prisma.TransactionClient;

async function revokeMemberKeys({
  tx,
  memberIds,
}: {
  tx: Tx;
  memberIds: string[];
}): Promise<void> {
  if (memberIds.length === 0) return;
  await lockMembersById({ tx, memberIds });
  await revokeCreatedApiKeys({ tx, memberIds });
}

function memberDeleteOverrides(inTransaction: InTransaction) {
  return {
    delete: (args: Prisma.MemberDeleteArgs) =>
      inTransaction(async (tx) => {
        const member = await tx.member.findUnique({
          where: args.where,
          select: { id: true },
        });
        await revokeMemberKeys({ tx, memberIds: member ? [member.id] : [] });
        return tx.member.delete(args);
      }),
    deleteMany: (args?: Prisma.MemberDeleteManyArgs) =>
      inTransaction(async (tx) => {
        const members = await tx.member.findMany({
          where: args?.where,
          select: { id: true },
        });
        const memberIds = members.map((member) => member.id);
        await revokeMemberKeys({ tx, memberIds });
        return tx.member.deleteMany(args);
      }),
  };
}

function userDeleteOverrides(inTransaction: InTransaction) {
  return {
    delete: (args: Prisma.UserDeleteArgs) =>
      inTransaction(async (tx) => {
        const user = await tx.user.findUnique({
          where: args.where,
          select: { id: true },
        });
        await revokeKeysOfUsers({ tx, userIds: user ? [user.id] : [] });
        return tx.user.delete(args);
      }),
    deleteMany: (args?: Prisma.UserDeleteManyArgs) =>
      inTransaction(async (tx) => {
        const users = await tx.user.findMany({
          where: args?.where,
          select: { id: true },
        });
        const userIds = users.map((user) => user.id);
        await revokeKeysOfUsers({ tx, userIds });
        return tx.user.deleteMany(args);
      }),
  };
}

/** `delegate` with some methods replaced; the rest are bound to it. */
function overrideMethods<Delegate extends object>({
  delegate,
  overrides,
}: {
  delegate: Delegate;
  overrides: Partial<Record<PropertyKey, unknown>>;
}): Delegate {
  return new Proxy(delegate, {
    get(target, property) {
      if (property in overrides) return overrides[property];
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Prisma accepts `db.member` and `db.Member` alike; so does the override. */
function interceptedModel(property: PropertyKey): 'member' | 'user' | null {
  if (typeof property !== 'string') return null;
  const model = property.toLowerCase();
  return model === 'member' || model === 'user' ? model : null;
}

type TransactionMethod = (first: unknown, ...rest: unknown[]) => unknown;

function revokingClient<Client extends Tx>({
  client,
  inTransaction,
}: {
  client: Client;
  inTransaction: InTransaction;
}): Client {
  return new Proxy(client, {
    get(target, property) {
      const model = interceptedModel(property);
      if (model === 'member') {
        const delegate = target.member;
        return overrideMethods({
          delegate,
          overrides: {
            ...memberDeleteOverrides(inTransaction),
            ...memberUpdateOverrides({ delegate, inTransaction }),
          },
        });
      }
      if (model === 'user') {
        const delegate = target.user;
        return overrideMethods({
          delegate,
          overrides: {
            ...userDeleteOverrides(inTransaction),
            ...userUpdateOverrides({ delegate, inTransaction }),
          },
        });
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property !== '$transaction') return value.bind(target);
      const transaction: TransactionMethod = value.bind(target);
      return (first: unknown, ...rest: unknown[]) => {
        if (typeof first !== 'function') return transaction(first, ...rest);
        const run: (tx: Tx) => unknown = (tx) =>
          first(
            revokingClient({ client: tx, inTransaction: (work) => work(tx) }),
          );
        return transaction(run, ...rest);
      };
    },
  });
}

export function withApiKeyRevokingDeletes(client: PrismaClient): PrismaClient {
  return revokingClient({
    client,
    inTransaction: (work) => client.$transaction(work),
  });
}

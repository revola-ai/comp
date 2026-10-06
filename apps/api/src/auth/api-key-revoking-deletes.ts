import type { Prisma, PrismaClient } from '@db';
import { lockMembersById, lockMembersOfUser } from './api-key-member-lock';
import { revokeCreatedApiKeys } from './api-key-offboarding';

/**
 * The Prisma client better-auth writes through. better-auth deletes Member rows
 * itself (/organization/remove-member, /organization/leave, organization
 * deletion) and Users with their memberships (/admin/remove-user). Each such
 * delete here runs in one transaction that locks the affected member rows,
 * revokes their personal API keys, then deletes. Revocation therefore happens
 * only when better-auth actually deletes, after its own checks (a refused
 * leave revokes nothing), and there is no moment where the member is gone but
 * its keys still work. Every other call passes through unchanged.
 */

function deleteMember({
  client,
  args,
}: {
  client: PrismaClient;
  args: Prisma.MemberDeleteArgs;
}) {
  return client.$transaction(async (tx) => {
    const member = await tx.member.findUnique({
      where: args.where,
      select: { id: true },
    });
    if (member) {
      await lockMembersById({ tx, memberIds: [member.id] });
      await revokeCreatedApiKeys({ tx, memberIds: [member.id] });
    }
    return tx.member.delete(args);
  });
}

function deleteMembers({
  client,
  args,
}: {
  client: PrismaClient;
  args?: Prisma.MemberDeleteManyArgs;
}) {
  return client.$transaction(async (tx) => {
    const members = await tx.member.findMany({
      where: args?.where,
      select: { id: true },
    });
    const memberIds = members.map((member) => member.id);
    if (memberIds.length > 0) {
      await lockMembersById({ tx, memberIds });
      await revokeCreatedApiKeys({ tx, memberIds });
    }
    return tx.member.deleteMany(args);
  });
}

function deleteUser({
  client,
  args,
}: {
  client: PrismaClient;
  args: Prisma.UserDeleteArgs;
}) {
  return client.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: args.where,
      select: { id: true },
    });
    if (user) {
      const members = await lockMembersOfUser({ tx, userId: user.id });
      const memberIds = members.map((member) => member.id);
      if (memberIds.length > 0) await revokeCreatedApiKeys({ tx, memberIds });
    }
    return tx.user.delete(args);
  });
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

export function withApiKeyRevokingDeletes(client: PrismaClient): PrismaClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'member') {
        return overrideMethods({
          delegate: target.member,
          overrides: {
            delete: (args: Prisma.MemberDeleteArgs) =>
              deleteMember({ client: target, args }),
            deleteMany: (args?: Prisma.MemberDeleteManyArgs) =>
              deleteMembers({ client: target, args }),
          },
        });
      }
      if (property === 'user') {
        return overrideMethods({
          delegate: target.user,
          overrides: {
            delete: (args: Prisma.UserDeleteArgs) =>
              deleteUser({ client: target, args }),
          },
        });
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

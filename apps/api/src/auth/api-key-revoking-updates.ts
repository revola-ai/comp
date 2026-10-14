import type { Prisma } from '@db';
import {
  bansUser,
  type InTransaction,
  memberAccessChange,
  cutsAccess,
  revokeKeysCutOffBy,
  revokeKeysOfUsers,
} from './api-key-access-loss';

/**
 * Member and User updates on the client better-auth writes through. A
 * deactivation or a ban (/admin/ban-user, /admin/update-user) runs in one
 * transaction that locks the affected members, revokes their personal keys,
 * then writes; a failed write rolls the revocation back. Updates that cannot
 * end access, role changes (/organization/update-member-role) included, pass
 * straight through to `delegate`: a personal key is bounded by its creator's
 * current roles at every use (api-key-effective-scopes.ts).
 */

type MemberDelegate = Prisma.TransactionClient['member'];
type UserDelegate = Prisma.TransactionClient['user'];

export function memberUpdateOverrides({
  delegate,
  inTransaction,
}: {
  delegate: MemberDelegate;
  inTransaction: InTransaction;
}) {
  return {
    update: (args: Prisma.MemberUpdateArgs) => {
      const change = memberAccessChange(args.data);
      if (!cutsAccess(change)) return delegate.update(args);
      return inTransaction(async (tx) => {
        const member = await tx.member.findUnique({
          where: args.where,
          select: { id: true },
        });
        const memberIds = member ? [member.id] : [];
        await revokeKeysCutOffBy({ tx, memberIds, change });
        return tx.member.update(args);
      });
    },
    updateMany: (args: Prisma.MemberUpdateManyArgs) => {
      const change = memberAccessChange(args.data);
      if (!cutsAccess(change)) return delegate.updateMany(args);
      return inTransaction(async (tx) => {
        const members = await tx.member.findMany({
          where: args.where,
          select: { id: true },
        });
        const memberIds = members.map((member) => member.id);
        await revokeKeysCutOffBy({ tx, memberIds, change });
        return tx.member.updateMany(args);
      });
    },
  };
}

export function userUpdateOverrides({
  delegate,
  inTransaction,
}: {
  delegate: UserDelegate;
  inTransaction: InTransaction;
}) {
  return {
    update: (args: Prisma.UserUpdateArgs) => {
      if (!bansUser(args.data)) return delegate.update(args);
      return inTransaction(async (tx) => {
        const user = await tx.user.findUnique({
          where: args.where,
          select: { id: true },
        });
        await revokeKeysOfUsers({ tx, userIds: user ? [user.id] : [] });
        return tx.user.update(args);
      });
    },
    updateMany: (args: Prisma.UserUpdateManyArgs) => {
      if (!bansUser(args.data)) return delegate.updateMany(args);
      return inTransaction(async (tx) => {
        const users = await tx.user.findMany({
          where: args.where,
          select: { id: true },
        });
        const userIds = users.map((user) => user.id);
        await revokeKeysOfUsers({ tx, userIds });
        return tx.user.updateMany(args);
      });
    },
  };
}

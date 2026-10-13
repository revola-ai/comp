import { db, type Prisma } from '@db';
import {
  type MemberAccessChange,
  revokeCreatedApiKeys,
  revokeKeysCutOffBy,
} from './api-key-access-loss';
import { lockMembersById } from './api-key-member-lock';

/**
 * API-key revocation on offboarding.
 *
 * A personal key (`organizationOwned = false`) belongs to the member who
 * created it and must stop working when that member is removed, deactivated
 * or loses a role (see api-key-access-loss.ts). Each helper locks the member
 * row first (the same lock key creation takes, see api-key-member-lock.ts),
 * then revokes and changes the membership in the same transaction; deleting a
 * member would otherwise null `createdByMemberId` (onDelete: SetNull) and
 * orphan the key.
 */

/**
 * Applies a membership change in one transaction that first locks the member
 * and revokes its personal keys when `change` cuts its access. `apply` makes
 * the change itself with the transaction client; if it throws, the
 * revocation rolls back with it.
 */
export function changeMemberRevokingApiKeys<T>({
  memberId,
  organizationId,
  change,
  apply,
}: {
  memberId: string;
  organizationId?: string;
  change: MemberAccessChange;
  apply: (tx: Prisma.TransactionClient) => Promise<T>;
}): Promise<T> {
  return db.$transaction(async (tx) => {
    await revokeKeysCutOffBy({
      tx,
      memberIds: [memberId],
      organizationId,
      change,
    });
    return apply(tx);
  });
}

/**
 * Deactivate a member and revoke their personal API keys atomically.
 * `offboardDate` is written only when given (null clears it).
 */
export async function deactivateMemberAndRevokeApiKeys({
  memberId,
  organizationId,
  offboardDate,
}: {
  memberId: string;
  organizationId?: string;
  offboardDate?: Date | null;
}): Promise<void> {
  const change = { deactivated: true, isActive: false };
  await changeMemberRevokingApiKeys({
    memberId,
    organizationId,
    change,
    apply: (tx) =>
      tx.member.update({
        where: organizationId
          ? { id: memberId, organizationId }
          : { id: memberId },
        data: {
          ...change,
          ...(offboardDate !== undefined ? { offboardDate } : {}),
        },
      }),
  });
}

/** Revoke a member's personal API keys, then delete the member, atomically. */
export async function deleteMemberAndRevokeApiKeys({
  memberId,
  organizationId,
}: {
  memberId: string;
  organizationId: string;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockMembersById({ tx, memberIds: [memberId] });
    await revokeCreatedApiKeys({ tx, memberIds: [memberId] });
    await tx.member.delete({ where: { id: memberId, organizationId } });
  });
}

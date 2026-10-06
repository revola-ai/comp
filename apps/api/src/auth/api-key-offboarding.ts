import { db, type Prisma } from '@db';
import { lockMembersById } from './api-key-member-lock';

/**
 * API-key revocation on offboarding.
 *
 * A personal key (`organizationOwned = false`) belongs to the member who
 * created it and must stop working when that member is removed or
 * deactivated. Each helper locks the member row first (the same lock key
 * creation takes, see api-key-member-lock.ts), then revokes and changes the
 * membership in the same transaction; deleting a member would otherwise null
 * `createdByMemberId` (onDelete: SetNull) and orphan the key.
 */

const PERSONAL_ACTIVE_KEYS = { organizationOwned: false, isActive: true };
const REVOKED = { isActive: false };

type RevokingClient = Pick<Prisma.TransactionClient, 'apiKey'>;

/** Revoke the active personal keys created by the given members. */
export function revokeCreatedApiKeys({
  tx,
  memberIds,
}: {
  tx: RevokingClient;
  memberIds: string[];
}) {
  return tx.apiKey.updateMany({
    where: { createdByMemberId: { in: memberIds }, ...PERSONAL_ACTIVE_KEYS },
    data: REVOKED,
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
  await db.$transaction(async (tx) => {
    await lockMembersById({ tx, memberIds: [memberId] });
    await revokeCreatedApiKeys({ tx, memberIds: [memberId] });
    await tx.member.update({
      where: organizationId
        ? { id: memberId, organizationId }
        : { id: memberId },
      data: {
        deactivated: true,
        isActive: false,
        ...(offboardDate !== undefined ? { offboardDate } : {}),
      },
    });
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

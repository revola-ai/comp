import { db } from '@db';

/**
 * API-key revocation on offboarding.
 *
 * A personal key (`organizationOwned = false`) belongs to the member who
 * created it and must stop working when that member is removed or
 * deactivated. Revocation runs in the same transaction as the membership
 * change; deleting a member would otherwise null `createdByMemberId`
 * (onDelete: SetNull) and turn the key into an owner-attributed legacy key.
 */

const PERSONAL_ACTIVE_KEYS = { organizationOwned: false, isActive: true };
const REVOKED = { isActive: false };

/** Revoke the active personal keys created by the given members. */
export function revokeCreatedApiKeys({ memberIds }: { memberIds: string[] }) {
  return db.apiKey.updateMany({
    where: { createdByMemberId: { in: memberIds }, ...PERSONAL_ACTIVE_KEYS },
    data: REVOKED,
  });
}

/**
 * Revoke the active personal keys a user created, in one organization or in
 * every organization they belong to.
 */
export function revokeApiKeysOfUser({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId?: string;
}) {
  return db.apiKey.updateMany({
    where: {
      createdBy: {
        is: organizationId ? { userId, organizationId } : { userId },
      },
      ...PERSONAL_ACTIVE_KEYS,
    },
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
  await db.$transaction([
    revokeCreatedApiKeys({ memberIds: [memberId] }),
    db.member.update({
      where: organizationId
        ? { id: memberId, organizationId }
        : { id: memberId },
      data: {
        deactivated: true,
        isActive: false,
        ...(offboardDate !== undefined ? { offboardDate } : {}),
      },
    }),
  ]);
}

/** Revoke a member's personal API keys, then delete the member, atomically. */
export async function deleteMemberAndRevokeApiKeys({
  memberId,
  organizationId,
}: {
  memberId: string;
  organizationId: string;
}): Promise<void> {
  await db.$transaction([
    revokeCreatedApiKeys({ memberIds: [memberId] }),
    db.member.delete({ where: { id: memberId, organizationId } }),
  ]);
}

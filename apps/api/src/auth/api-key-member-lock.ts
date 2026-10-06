import type { Prisma } from '@db';

/**
 * Member row locks shared by API-key creation and every removal or
 * deactivation path. Both take `SELECT ... FOR UPDATE` on the creating
 * member's row inside their transaction, so they serialize: a removal that
 * locks first commits before the creation can read the (now missing or
 * deactivated) member and refuse; a creation that locks first commits its key
 * before the removal revokes the member's keys. Rows are locked in id order so
 * two multi-row lockers cannot deadlock.
 */

export type LockedMember = {
  id: string;
  organizationId: string;
  isActive: boolean;
  deactivated: boolean;
};

type LockingClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Locks the given member rows; returns the ones that still exist. */
export function lockMembersById({
  tx,
  memberIds,
}: {
  tx: LockingClient;
  memberIds: string[];
}): Promise<LockedMember[]> {
  return tx.$queryRaw<LockedMember[]>`
    SELECT "id", "organizationId", "isActive", "deactivated"
    FROM "Member"
    WHERE "id" = ANY(${memberIds})
    ORDER BY "id"
    FOR UPDATE`;
}

/** Locks every membership row of a user; returns them. */
export function lockMembersOfUser({
  tx,
  userId,
}: {
  tx: LockingClient;
  userId: string;
}): Promise<LockedMember[]> {
  return tx.$queryRaw<LockedMember[]>`
    SELECT "id", "organizationId", "isActive", "deactivated"
    FROM "Member"
    WHERE "userId" = ${userId}
    ORDER BY "id"
    FOR UPDATE`;
}

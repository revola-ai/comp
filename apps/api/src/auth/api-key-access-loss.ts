import type { Prisma } from '@db';
import { lockMembersById, lockMembersOfUsers } from './api-key-member-lock';

/**
 * When a membership change ends a member's personal API keys.
 *
 * A personal key stops working for good once its creator's membership ends:
 * deactivating (`deactivated: true`) or marking inactive (`isActive: false`)
 * revokes, as do removing the member and banning the user (elsewhere). The
 * rule is mirrored by the database triggers of migrations 20261013120100 and
 * 20261013130000. A role change does not revoke: at every use a personal key
 * is bounded by its creator's current roles (api-key-effective-scopes.ts), so
 * a promotion keeps it working and a demotion or a custom-role edit narrows
 * it at once. Revocation is final: reactivating brings no key back.
 */

export type MemberAccessChange = {
  isActive?: boolean;
  deactivated?: boolean;
};

const PERSONAL_ACTIVE_KEYS = { organizationOwned: false, isActive: true };

/** Revoke the active personal keys created by the given members. */
export function revokeCreatedApiKeys({
  tx,
  memberIds,
}: {
  tx: Pick<Prisma.TransactionClient, 'apiKey'>;
  memberIds: string[];
}) {
  return tx.apiKey.updateMany({
    where: { createdByMemberId: { in: memberIds }, ...PERSONAL_ACTIVE_KEYS },
    data: { isActive: false },
  });
}

/** A Prisma scalar update is the value or `{ set: value }`. */
function scalarUpdate(value: unknown): unknown {
  if (value && typeof value === 'object' && 'set' in value) return value.set;
  return value;
}

/** The access-relevant part of a Member update's `data`. */
export function memberAccessChange(data: unknown): MemberAccessChange {
  if (!data || typeof data !== 'object') return {};
  const isActive = scalarUpdate(Reflect.get(data, 'isActive'));
  const deactivated = scalarUpdate(Reflect.get(data, 'deactivated'));
  return {
    ...(typeof isActive === 'boolean' ? { isActive } : {}),
    ...(typeof deactivated === 'boolean' ? { deactivated } : {}),
  };
}

/** Whether a User update's `data` bans the user. */
export function bansUser(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return scalarUpdate(Reflect.get(data, 'banned')) === true;
}

/** Whether `change` ends the member's access. */
export function cutsAccess(change: MemberAccessChange): boolean {
  return change.isActive === false || change.deactivated === true;
}

/** Runs `work` atomically: in a new transaction, or in the one already open. */
export type InTransaction = <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;

/** Locks every membership of the given users and revokes their personal keys. */
export async function revokeKeysOfUsers({
  tx,
  userIds,
}: {
  tx: Prisma.TransactionClient;
  userIds: string[];
}): Promise<void> {
  if (userIds.length === 0) return;
  const members = await lockMembersOfUsers({ tx, userIds });
  const memberIds = members.map((member) => member.id);
  if (memberIds.length > 0) await revokeCreatedApiKeys({ tx, memberIds });
}

/**
 * Locks the given members and, when `change` ends their access, revokes their
 * personal keys, inside the caller's transaction (before it applies the
 * change). With `organizationId`, members of other organizations are left
 * alone.
 */
export async function revokeKeysCutOffBy({
  tx,
  memberIds,
  organizationId,
  change,
}: {
  tx: Prisma.TransactionClient;
  memberIds: string[];
  organizationId?: string;
  change: MemberAccessChange;
}): Promise<void> {
  if (memberIds.length === 0 || !cutsAccess(change)) return;
  const members = await lockMembersById({ tx, memberIds });
  const cutOff = members
    .filter(
      (member) => !organizationId || member.organizationId === organizationId,
    )
    .map((member) => member.id);
  if (cutOff.length > 0) await revokeCreatedApiKeys({ tx, memberIds: cutOff });
}

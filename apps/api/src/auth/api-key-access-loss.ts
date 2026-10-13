import type { Prisma } from '@db';
import { lockMembersById, lockMembersOfUsers } from './api-key-member-lock';

/**
 * When a membership change ends a member's personal API keys.
 *
 * A personal key acts with scopes its creator held when minting it, so it
 * must not outlive a cut to the creator's access. The rule, mirrored by the
 * database triggers of migration 20261013120100:
 *   - deactivating (`deactivated: true`) or marking inactive
 *     (`isActive: false`) always revokes;
 *   - a role change revokes when it removes any of the member's roles.
 *     Permissions are the union of the member's roles, so a change that only
 *     adds or reorders roles cannot shrink them and keeps the keys.
 * Edits to a custom role's permission set are not membership changes and are
 * not covered here.
 * Revocation is final: reactivating or restoring a role brings no key back.
 */

export type MemberAccessChange = {
  role?: string;
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
  const role = scalarUpdate(Reflect.get(data, 'role'));
  const isActive = scalarUpdate(Reflect.get(data, 'isActive'));
  const deactivated = scalarUpdate(Reflect.get(data, 'deactivated'));
  return {
    ...(typeof role === 'string' ? { role } : {}),
    ...(typeof isActive === 'boolean' ? { isActive } : {}),
    ...(typeof deactivated === 'boolean' ? { deactivated } : {}),
  };
}

/** Whether a User update's `data` bans the user. */
export function bansUser(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return scalarUpdate(Reflect.get(data, 'banned')) === true;
}

function roleSet(roles: string): Set<string> {
  return new Set(
    roles
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
  );
}

/** Whether `next` drops any role present in `current`. */
export function removesRole({
  current,
  next,
}: {
  current: string;
  next: string;
}): boolean {
  const kept = roleSet(next);
  return [...roleSet(current)].some((role) => !kept.has(role));
}

/** Whether the change could cut access, before looking at the member. */
export function mayCutAccess(change: MemberAccessChange): boolean {
  return (
    change.isActive === false ||
    change.deactivated === true ||
    change.role !== undefined
  );
}

/** Whether applying `change` to a member with roles `currentRole` cuts access. */
export function cutsAccess({
  currentRole,
  change,
}: {
  currentRole: string;
  change: MemberAccessChange;
}): boolean {
  if (change.isActive === false || change.deactivated === true) return true;
  if (change.role === undefined) return false;
  return removesRole({ current: currentRole, next: change.role });
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
 * Locks the given members and revokes the personal keys of those `change`
 * cuts off, inside the caller's transaction (before it applies the change).
 * With `organizationId`, members of other organizations are left alone.
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
  if (memberIds.length === 0 || !mayCutAccess(change)) return;
  const members = await lockMembersById({ tx, memberIds });
  const cutOff = members
    .filter(
      (member) =>
        (!organizationId || member.organizationId === organizationId) &&
        cutsAccess({ currentRole: member.role, change }),
    )
    .map((member) => member.id);
  if (cutOff.length > 0) await revokeCreatedApiKeys({ tx, memberIds: cutOff });
}

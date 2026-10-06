import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import {
  revokeApiKeysOfUser,
  revokeCreatedApiKeys,
} from './api-key-offboarding';

/**
 * better-auth deletes Member rows itself on /organization/remove-member,
 * /organization/leave and (through the user cascade) /admin/remove-user. The
 * delete nulls ApiKey.createdByMemberId, so each path revokes the personal
 * keys first; a failure aborts the removal rather than leaving a live key.
 */

export const LEAVE_ORGANIZATION_PATH = '/organization/leave';

/** `organizationHooks.beforeRemoveMember`: runs after authorization. */
export async function revokeApiKeysBeforeMemberRemoval({
  member,
}: {
  member: { id: string };
}): Promise<void> {
  await revokeCreatedApiKeys({ memberIds: [member.id] });
}

/** `databaseHooks.user.delete.before`: the user's memberships cascade away. */
export async function revokeApiKeysBeforeUserDeletion(user: {
  id: string;
}): Promise<void> {
  await revokeApiKeysOfUser({ userId: user.id });
}

/** Revoke the leaving user's keys in that organization. */
export async function revokeApiKeysBeforeLeave({
  path,
  userId,
  organizationId,
}: {
  path: string;
  userId: string | undefined;
  organizationId: unknown;
}): Promise<void> {
  if (path !== LEAVE_ORGANIZATION_PATH) return;
  if (!userId || typeof organizationId !== 'string' || !organizationId) return;
  await revokeApiKeysOfUser({ userId, organizationId });
}

/**
 * `hooks.before` middleware. Leaving has no organization hook, so the session
 * user is resolved here; they can only revoke their own keys.
 */
export const apiKeyOffboardingBeforeHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== LEAVE_ORGANIZATION_PATH) return;
  const session = await getSessionFromCtx(ctx);
  const body: unknown = ctx.body;
  const organizationId =
    typeof body === 'object' && body !== null && 'organizationId' in body
      ? body.organizationId
      : undefined;
  await revokeApiKeysBeforeLeave({
    path: ctx.path,
    userId: session?.user.id,
    organizationId,
  });
});

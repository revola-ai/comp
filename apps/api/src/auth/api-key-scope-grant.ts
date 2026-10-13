import { ForbiddenException } from '@nestjs/common';
import { resolveRolePermissions } from './app-access';
import { resolveServiceByName } from './service-token.config';
import type { AuthContext } from './types';

export type ScopeGrantCaller = Pick<
  AuthContext,
  'authType' | 'organizationId' | 'apiKeyScopes' | 'serviceName'
> &
  Partial<Pick<AuthContext, 'userRoles' | 'isPlatformAdmin'>>;

/** Every scope may be granted. */
const ANY_SCOPE = 'any';

/**
 * The scopes the caller itself holds, as `resource:action` strings:
 *   - an API key: its own scopes (a key holding every available scope may
 *     grant any; a key with no recorded scopes holds none);
 *   - a session: what its roles grant in the organization, built-in and
 *     custom (the union over comma-separated roles), the same resolution
 *     PermissionGuard applies to MCP sessions; platform admins hold all;
 *   - a service token: its service's permissions.
 */
async function heldScopes({
  caller,
  availableScopes,
}: {
  caller: ScopeGrantCaller;
  availableScopes: string[];
}): Promise<Set<string> | typeof ANY_SCOPE> {
  if (caller.authType === 'api-key') {
    const held = new Set(caller.apiKeyScopes ?? []);
    const fullAccess =
      held.size > 0 && availableScopes.every((scope) => held.has(scope));
    return fullAccess ? ANY_SCOPE : held;
  }
  if (caller.authType === 'service') {
    return new Set(resolveServiceByName(caller.serviceName)?.permissions ?? []);
  }
  if (caller.isPlatformAdmin) return ANY_SCOPE;
  const roles = (caller.userRoles ?? [])
    .map((role) => role.trim())
    .filter(Boolean);
  if (roles.length === 0) return new Set();
  const permissions = await resolveRolePermissions(
    caller.organizationId,
    roles,
  );
  return new Set(
    Object.entries(permissions).flatMap(([resource, actions]) =>
      actions.map((action) => `${resource}:${action}`),
    ),
  );
}

/**
 * A new key may only carry scopes its creator holds, so `apiKey:create` alone
 * cannot mint a key with more access than the caller has: an API key with
 * only `apiKey:create` cannot mint a broader key, and a member whose (custom)
 * role grants `apiKey:create` and `vendor:read` cannot mint `risk:update`.
 */
export async function assertScopesGrantable({
  caller,
  requestedScopes,
  availableScopes,
}: {
  caller: ScopeGrantCaller;
  requestedScopes: string[];
  availableScopes: string[];
}): Promise<void> {
  const held = await heldScopes({ caller, availableScopes });
  if (held === ANY_SCOPE) return;
  const missing = requestedScopes.filter((scope) => !held.has(scope));
  if (missing.length === 0) return;
  const who =
    caller.authType === 'api-key'
      ? 'This API key cannot grant scopes it does not hold'
      : 'You cannot grant scopes you do not hold';
  throw new ForbiddenException(`${who}: ${missing.join(', ')}`);
}

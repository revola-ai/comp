import { permissionScopes, resolveRolePermissions } from './app-access';
import { asCredentialStoreError } from './credential-store-error';

/** A member's comma-separated `role` as role names. */
export function memberRoles(role: string): string[] {
  return role
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * The scopes an API key may use on this request. A personal key acts for its
 * creator, so its recorded scopes are cut to what the creator's roles grant
 * now (built-in roles from the role table, custom roles from
 * organization_role, the union over all roles): a promotion keeps the key
 * working, a demotion or a custom-role edit narrows it at once, and neither
 * revokes it. `creatorRoles` is null for keys not bounded by a member:
 * organization-owned keys (their own rules apply) and legacy creatorless
 * keys, which keep their recorded scopes. A failed custom-role lookup during
 * a database outage is a credential-store failure (503), not a refusal.
 */
export async function effectiveApiKeyScopes({
  organizationId,
  scopes,
  creatorRoles,
}: {
  organizationId: string;
  scopes: string[];
  creatorRoles: string[] | null;
}): Promise<string[]> {
  if (creatorRoles === null) return scopes;
  try {
    const held = permissionScopes(
      await resolveRolePermissions(organizationId, creatorRoles),
    );
    return scopes.filter((scope) => held.has(scope));
  } catch (error) {
    throw asCredentialStoreError(error);
  }
}

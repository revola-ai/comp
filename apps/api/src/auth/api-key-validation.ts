/** Result from validating an API key */
export interface ApiKeyValidationResult {
  /** API key row primary key - exposed on the request so downstream
   *  attribution logic (audit logs, owner-fallback resolver) can reference
   *  the exact key used without an extra DB lookup. */
  apiKeyId: string;
  /** Human-readable name set when the key was created (e.g. "CI Pipeline").
   *  Surfaced in audit log descriptions for API-key-initiated mutations. */
  apiKeyName: string;
  organizationId: string;
  scopes: string[];
  /** Member (org membership) that created this key, or null for legacy keys
   *  created before creator attribution existed. Used by ActingUserResolver
   *  to attribute API-key mutations to the real creator. */
  createdByMemberId: string | null;
  /** Organization-owned keys outlive their creator's membership; personal
   *  keys stop working once the creator is removed or deactivated. */
  organizationOwned: boolean;
}

/** Columns read when matching a presented key against stored candidates. */
export const API_KEY_VALIDATION_SELECT = {
  id: true,
  name: true,
  key: true,
  salt: true,
  organizationId: true,
  expiresAt: true,
  scopes: true,
  createdByMemberId: true,
  organizationOwned: true,
  createdBy: { select: { isActive: true, deactivated: true } },
} as const;

export interface ApiKeyCandidate {
  id: string;
  name: string;
  key: string;
  salt: string | null;
  organizationId: string;
  scopes: string[];
  createdByMemberId: string | null;
  organizationOwned: boolean;
  createdBy: { isActive: boolean; deactivated: boolean } | null;
}

/**
 * A personal key whose recorded creator is no longer an active member of the
 * organization (deactivated, inactive, or the membership row is gone). Legacy
 * keys without a recorded creator and organization-owned keys never count.
 */
export function hasInactiveCreator(candidate: ApiKeyCandidate): boolean {
  if (!candidate.createdByMemberId || candidate.organizationOwned) {
    return false;
  }
  const creator = candidate.createdBy;
  return !creator || creator.deactivated || !creator.isActive;
}

export function toValidationResult(
  candidate: ApiKeyCandidate,
): ApiKeyValidationResult {
  return {
    apiKeyId: candidate.id,
    apiKeyName: candidate.name,
    organizationId: candidate.organizationId,
    scopes: candidate.scopes,
    createdByMemberId: candidate.createdByMemberId ?? null,
    organizationOwned: candidate.organizationOwned,
  };
}

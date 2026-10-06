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

/**
 * Upper bound on legacy keys (no stored prefix) read for one validation, so a
 * junk key costs one bounded, indexed query instead of a full-table scan.
 */
export const LEGACY_KEY_SCAN_LIMIT = 100;

/**
 * When `organizationOwned` shipped (migration 20261006063557). Keys created
 * before it may lack a recorded creator; any personal key created since has
 * one, so a creatorless personal key from after it is an orphan (its creator's
 * membership was deleted) and is refused.
 */
export const LEGACY_CREATOR_CUTOFF = new Date('2026-10-06T06:35:57Z');

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
  createdAt: true,
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
  createdAt: Date;
  createdBy: { isActive: boolean; deactivated: boolean } | null;
}

export type ApiKeyRejection = 'inactive_creator' | 'orphaned';

/**
 * Why a matched key must not authenticate, or null when it may. Organization-
 * owned keys are always accepted. A personal key needs an active creator; one
 * without a recorded creator is accepted only as a legacy key created before
 * LEGACY_CREATOR_CUTOFF.
 */
export function apiKeyRejection(
  candidate: ApiKeyCandidate,
): ApiKeyRejection | null {
  if (candidate.organizationOwned) return null;
  if (!candidate.createdByMemberId) {
    const legacy = candidate.createdAt < LEGACY_CREATOR_CUTOFF;
    return legacy ? null : 'orphaned';
  }
  const creator = candidate.createdBy;
  const active = creator && !creator.deactivated && creator.isActive;
  return active ? null : 'inactive_creator';
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

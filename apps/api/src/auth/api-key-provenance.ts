import { ForbiddenException } from '@nestjs/common';
import type { AuthContext } from './types';

/** Who a new API key belongs to. */
export type ApiKeyProvenance = {
  /** The member the key is attributed to (and revoked with, unless organization-owned). */
  createdByMemberId: string | null;
  /** Organization-owned keys survive their creator's offboarding. */
  organizationOwned: boolean;
};

export type ProvenanceSource = Pick<
  AuthContext,
  | 'authType'
  | 'memberId'
  | 'apiKeyCreatedByMemberId'
  | 'apiKeyOrganizationOwned'
> &
  Partial<Pick<AuthContext, 'userRoles'>>;

/**
 * The provenance of a key created by the authenticated caller. A key minted
 * through an API key inherits that key's provenance, so it cannot outlive the
 * member behind it; a legacy key with no recorded creator may not mint keys at
 * all. Every other caller must be acting as a member. A new personal key never
 * gets a null creator.
 */
export function resolveKeyProvenance(
  source: ProvenanceSource,
): ApiKeyProvenance {
  if (source.authType === 'api-key') {
    const createdByMemberId = source.apiKeyCreatedByMemberId ?? null;
    if (source.apiKeyOrganizationOwned) {
      return { createdByMemberId, organizationOwned: true };
    }
    if (createdByMemberId) {
      return { createdByMemberId, organizationOwned: false };
    }
    throw new ForbiddenException(
      'This API key has no recorded creator, so keys it creates could not be revoked when that person leaves. Create API keys from a signed-in session.',
    );
  }
  if (source.memberId) {
    return { createdByMemberId: source.memberId, organizationOwned: false };
  }
  throw new ForbiddenException(
    'API keys can only be created by a member of the organization. Create API keys from a signed-in session.',
  );
}

/**
 * The provenance of an organization-owned key requested explicitly
 * (`organizationOwned: true`). Such a key survives its creator's offboarding,
 * so minting one is an ownership decision: only a signed-in member holding
 * the built-in `owner` role may, and the key is attributed to that owner. An
 * admin may not: admins can be removed by owners, and a key an admin minted
 * that outlived the removal would undo it. A key minted through an
 * organization-owned key is organization-owned anyway; any other API key or
 * service token is refused.
 */
export function resolveOrganizationOwnedProvenance(
  source: ProvenanceSource,
): ApiKeyProvenance {
  if (source.authType === 'api-key' && source.apiKeyOrganizationOwned) {
    return resolveKeyProvenance(source);
  }
  const roles = (source.userRoles ?? []).map((role) => role.trim());
  const owner = source.authType === 'session' && roles.includes('owner');
  if (!owner || !source.memberId) {
    throw new ForbiddenException(
      'Only an organization owner, signed in, can create organization-owned API keys.',
    );
  }
  return { createdByMemberId: source.memberId, organizationOwned: true };
}

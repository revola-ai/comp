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
>;

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

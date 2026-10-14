import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@db';
import { lockMembersById } from './api-key-member-lock';
import type { ApiKeyProvenance } from './api-key-provenance';

/**
 * Locks the creating member's row for the key-creation transaction and returns
 * the creator to record. A personal key needs its creator to be an active
 * member of the organization, checked under the lock; otherwise creation is
 * refused. An organization-owned key keeps its creator for attribution while
 * that member row exists, and needs none.
 */
export async function lockKeyCreator({
  tx,
  organizationId,
  provenance,
}: {
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>;
  organizationId: string;
  provenance: ApiKeyProvenance;
}): Promise<string | null> {
  const { createdByMemberId, organizationOwned } = provenance;
  if (!createdByMemberId) {
    if (organizationOwned) return null;
    throw new ForbiddenException(
      'A personal API key needs the member who creates it.',
    );
  }
  const [creator] = await lockMembersById({
    tx,
    memberIds: [createdByMemberId],
  });
  const inOrganization = creator?.organizationId === organizationId;
  if (organizationOwned) return inOrganization ? createdByMemberId : null;
  if (!inOrganization || creator.deactivated || !creator.isActive) {
    throw new ForbiddenException(
      'The member creating this API key is no longer an active member of the organization.',
    );
  }
  return createdByMemberId;
}

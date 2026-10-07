import { Logger, UnauthorizedException } from '@nestjs/common';
import { db } from '@db';
import { asCredentialStoreError } from './credential-store-error';
import { resolveServiceByToken } from './service-token.config';
import type { AuthenticatedRequest } from './types';

const logger = new Logger('HybridAuthGuard');

/**
 * Service-token authentication for HybridAuthGuard: the token must match a
 * configured service token and `x-organization-id` an existing organization.
 * An optional `x-user-id` names an active member to act as. A database outage
 * during either lookup answers 503 (credential_store_unavailable).
 *
 * The token is checked in memory, so a valid one never touches the caller's
 * IP bucket: junk API keys from a shared egress IP (Trigger.dev cloud, a NAT)
 * cannot lock an internal service out. A wrong token takes an attempt it never
 * gives back (`takeAttempt`), so guesses are counted and end in 429; production
 * also refuses to boot with a token short enough to guess (edge-secrets.ts).
 */
export async function authenticateServiceToken({
  request,
  token,
  takeAttempt,
}: {
  request: AuthenticatedRequest;
  token: string;
  takeAttempt: () => () => void;
}): Promise<boolean> {
  const service = resolveServiceByToken(token);
  if (!service) {
    takeAttempt();
    throw new UnauthorizedException('Invalid service token');
  }

  const organizationId = request.headers['x-organization-id'] as string;
  if (!organizationId) {
    throw new UnauthorizedException(
      'x-organization-id header is required for service token auth',
    );
  }

  const org = await db.organization
    .findUnique({ where: { id: organizationId }, select: { id: true } })
    .catch((error: unknown) => {
      logger.error('Service token organization lookup failed', error);
      throw asCredentialStoreError(error);
    });
  if (!org) {
    throw new UnauthorizedException(
      'Organization not found for the provided x-organization-id',
    );
  }

  request.organizationId = organizationId;
  request.authType = 'service';
  request.isApiKey = false;
  request.isServiceToken = true;
  request.serviceName = service.definition.name;
  request.isPlatformAdmin = false;
  request.userRoles = null;

  // Service tokens can pass x-user-id to act on behalf of a user
  // Validate that the user exists and belongs to the organization
  const actingUserId = request.headers['x-user-id'] as string;
  if (actingUserId) {
    const member = await db.member
      .findFirst({
        // Only active memberships may act - an offboarded/deactivated user must
        // not receive new audit / enteredById attribution. Mirrors the filters
        // ActingUserResolver applies to its creator/owner lookups.
        where: {
          userId: actingUserId,
          organizationId,
          deactivated: false,
          isActive: true,
        },
        select: { id: true, userId: true },
      })
      .catch((error: unknown) => {
        logger.error('Service token acting-member lookup failed', error);
        throw asCredentialStoreError(error);
      });
    if (member) {
      request.userId = actingUserId;
      // Set the acting membership too, so Member-FK sinks (audit rows,
      // enteredById, etc.) can attribute to the acting member and not just
      // the user.
      request.memberId = member.id;
    } else {
      logger.warn(
        `Service token x-user-id "${actingUserId}" is not an active member of org ${organizationId}`,
      );
    }
  }

  logger.log(
    `Service "${service.definition.name}" authenticated for org ${organizationId}`,
  );

  return true;
}

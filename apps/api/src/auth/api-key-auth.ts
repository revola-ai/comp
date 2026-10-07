import { UnauthorizedException } from '@nestjs/common';
import type { ApiKeyService } from './api-key.service';
import type { AuthenticatedRequest } from './types';

/**
 * API-key authentication for HybridAuthGuard. Checking a key is the guard's
 * only database-backed credential check, so it first takes an attempt from the
 * caller's verified client IP bucket (`takeAttempt`, 429 with no lookup once
 * the bucket is full). Only acceptance gives the attempt back: a wrong key, a
 * credential-store outage (503) or any other error keeps it, so a flood of
 * junk keys stays counted even while it saturates the database pool.
 */
export async function authenticateApiKey({
  request,
  header,
  apiKeyService,
  takeAttempt,
}: {
  request: AuthenticatedRequest;
  header: string;
  apiKeyService: Pick<ApiKeyService, 'extractApiKey' | 'validateApiKey'>;
  takeAttempt: () => () => void;
}): Promise<boolean> {
  const apiKey = apiKeyService.extractApiKey(header);
  if (!apiKey) {
    throw new UnauthorizedException('Invalid API key format');
  }

  const release = takeAttempt();
  const result = await apiKeyService.validateApiKey(apiKey);
  if (!result) {
    throw new UnauthorizedException('Invalid or expired API key');
  }
  release();

  request.organizationId = result.organizationId;
  request.authType = 'api-key';
  request.isApiKey = true;
  request.isServiceToken = false;
  request.isPlatformAdmin = false;
  request.apiKeyScopes = result.scopes;
  // Surface the key's id + name on the request so downstream attribution
  // (ActingUserResolver, audit logs) can record "via API key '<name>'"
  // without an extra DB lookup.
  request.apiKeyId = result.apiKeyId;
  request.apiKeyName = result.apiKeyName;
  // The member who created the key (if recorded). Lets ActingUserResolver
  // attribute mutations to the real creator instead of the org owner.
  request.apiKeyCreatedByMemberId = result.createdByMemberId;
  request.apiKeyOrganizationOwned = result.organizationOwned;
  // API keys are organization-scoped; no session user/member is attached here.
  request.userRoles = null;
  return true;
}

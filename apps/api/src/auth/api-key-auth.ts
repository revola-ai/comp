import { UnauthorizedException } from '@nestjs/common';
import type { ReadinessCheck } from '@trycompai/db';
import { checkApiReadiness } from '../health/readiness';
import { effectiveApiKeyScopes } from './api-key-effective-scopes';
import type { ApiKeyService, ApiKeyValidationResult } from './api-key.service';
import { CredentialStoreUnavailableException } from './credential-store-error';
import type { AuthenticatedRequest } from './types';

/**
 * Whether a failed key check hit a credential-store outage that a database
 * probe confirms (checkApiReadiness: `SELECT 1` on its own connection, shared
 * and cached, so a flood opens at most one probe at a time). A 503 whose probe
 * succeeds is a pool exhausted while the database answers, which a flood of
 * junk keys can cause itself, so it is not refunded.
 */
async function isConfirmedStoreOutage({
  error,
  checkReadiness,
}: {
  error: unknown;
  checkReadiness: ReadinessCheck;
}): Promise<boolean> {
  if (!(error instanceof CredentialStoreUnavailableException)) return false;
  const readiness = await checkReadiness();
  return readiness.status !== 'ok';
}

interface CheckedKey {
  result: ApiKeyValidationResult;
  scopes: string[];
}

/** Looks the key up and cuts a personal key's scopes to its creator's. */
async function checkKey({
  apiKey,
  apiKeyService,
}: {
  apiKey: string;
  apiKeyService: Pick<ApiKeyService, 'validateApiKey'>;
}): Promise<CheckedKey> {
  const result = await apiKeyService.validateApiKey(apiKey);
  if (!result) {
    throw new UnauthorizedException('Invalid or expired API key');
  }
  const scopes = await effectiveApiKeyScopes({
    organizationId: result.organizationId,
    scopes: result.scopes,
    creatorRoles: result.creatorRoles,
  });
  return { result, scopes };
}

/**
 * API-key authentication for HybridAuthGuard. Checking a key is a
 * database-backed credential check (as is a bearer token's, see
 * HybridAuthGuard), so it first takes an attempt from the caller's verified
 * client IP bucket (`takeAttempt`, 429 with no lookup once the bucket is
 * full). Acceptance gives the attempt back, and so does a credential-store
 * outage (503) the database probe confirms, as on the bearer path: an outage
 * says nothing about the key, and retries during one must not lock the key
 * out after recovery. A wrong key or any other error keeps it, so a flood of
 * junk keys stays counted even while it saturates the database pool.
 */
export async function authenticateApiKey({
  request,
  header,
  apiKeyService,
  takeAttempt,
  checkReadiness = checkApiReadiness,
}: {
  request: AuthenticatedRequest;
  header: string;
  apiKeyService: Pick<ApiKeyService, 'extractApiKey' | 'validateApiKey'>;
  takeAttempt: () => () => void;
  checkReadiness?: ReadinessCheck;
}): Promise<boolean> {
  const apiKey = apiKeyService.extractApiKey(header);
  if (!apiKey) {
    throw new UnauthorizedException('Invalid API key format');
  }

  const release = takeAttempt();
  let checked: CheckedKey;
  try {
    checked = await checkKey({ apiKey, apiKeyService });
  } catch (error) {
    if (await isConfirmedStoreOutage({ error, checkReadiness })) release();
    throw error;
  }
  release();
  const { result, scopes } = checked;

  request.organizationId = result.organizationId;
  request.authType = 'api-key';
  request.isApiKey = true;
  request.isServiceToken = false;
  request.isPlatformAdmin = false;
  request.apiKeyScopes = scopes;
  request.apiKeyGrantedScopes = result.scopes;
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

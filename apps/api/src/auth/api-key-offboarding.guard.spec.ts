import { createHash } from 'node:crypto';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HybridAuthGuard } from './hybrid-auth.guard';
import { ApiKeyService } from './api-key.service';

// End to end through the guard with the real ApiKeyService: only the database
// and the better-auth server are mocked.
const mockApiKeyFindMany = jest.fn();
const mockApiKeyUpdate = jest.fn();
jest.mock('@db', () => ({
  db: {
    apiKey: {
      findMany: (...args: unknown[]) => mockApiKeyFindMany(...args),
      update: (...args: unknown[]) => mockApiKeyUpdate(...args),
    },
  },
}));
// @trycompai/auth pulls in better-auth (ESM only); the API-key path never
// reads it, so an empty role map is enough.
jest.mock('@trycompai/auth', () => ({ BUILT_IN_ROLE_PERMISSIONS: {} }));
jest.mock('./auth.server', () => ({
  auth: { api: { getSession: jest.fn(), getMcpSession: jest.fn() } },
}));

const RAW_KEY = `comp_${'cd'.repeat(32)}`;
const SALT = 'salt-guard';

function keyRecord(overrides: Record<string, unknown>) {
  return {
    id: 'apk_1',
    name: 'Departed engineer key',
    key: createHash('sha256')
      .update(RAW_KEY + SALT)
      .digest('hex'),
    salt: SALT,
    organizationId: 'org_1',
    expiresAt: null,
    scopes: ['risk:read', 'risk:update'],
    createdByMemberId: 'mem_departed',
    organizationOwned: false,
    createdBy: { isActive: false, deactivated: true },
    createdAt: new Date('2026-10-07T00:00:00Z'),
    ...overrides,
  };
}

function contextFor(method: string): {
  context: ExecutionContext;
  request: Record<string, unknown>;
} {
  const request: Record<string, unknown> = {
    method,
    headers: { 'x-api-key': RAW_KEY },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('HybridAuthGuard with a key whose creator left the organization', () => {
  let guard: HybridAuthGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApiKeyUpdate.mockResolvedValue({});
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    guard = new HybridAuthGuard(new ApiKeyService(), reflector);
  });

  it.each(['GET', 'POST', 'PATCH', 'DELETE'])(
    'answers 401 on a %s request',
    async (method) => {
      mockApiKeyFindMany.mockResolvedValueOnce([keyRecord({})]);
      const { context } = contextFor(method);
      await expect(guard.canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
    },
  );

  it.each(['GET', 'POST'])(
    'accepts an organization-owned key on a %s request',
    async (method) => {
      mockApiKeyFindMany.mockResolvedValueOnce([
        keyRecord({ organizationOwned: true }),
      ]);
      const { context, request } = contextFor(method);
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.organizationId).toBe('org_1');
      expect(request.apiKeyCreatedByMemberId).toBe('mem_departed');
      expect(request.apiKeyOrganizationOwned).toBe(true);
    },
  );

  it.each(['GET', 'POST', 'DELETE'])(
    'answers 401 on a %s request with a creatorless personal key minted after the cutoff',
    async (method) => {
      mockApiKeyFindMany.mockResolvedValueOnce([
        keyRecord({ createdByMemberId: null, createdBy: null }),
      ]);
      const { context } = contextFor(method);
      await expect(guard.canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
    },
  );

  it('still accepts a creatorless legacy key minted before the cutoff', async () => {
    mockApiKeyFindMany.mockResolvedValueOnce([
      keyRecord({
        createdByMemberId: null,
        createdBy: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ]);
    const { context, request } = contextFor('POST');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.apiKeyCreatedByMemberId).toBeNull();
  });
});

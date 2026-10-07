jest.mock('@db', () => ({ db: {} }));
jest.mock('../auth/auth.server', () => ({
  auth: { api: { getSession: jest.fn() } },
}));
jest.mock('@trycompai/auth', () => ({
  statement: { apiKey: ['create', 'read', 'delete'] },
  BUILT_IN_ROLE_PERMISSIONS: {},
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ApiKeyService } from '../auth/api-key.service';
import type { AuthContext } from '../auth/types';
import { OrganizationController } from './organization.controller';
import type { OrganizationService } from './organization.service';

// POST /v1/organization/api-keys: who a new key belongs to.
describe('OrganizationController.createApiKey', () => {
  const mockApiKeyService = {
    create: jest.fn(),
    getAvailableScopes: () => ['apiKey:create', 'vendor:read', 'risk:read'],
  };
  const controller = new OrganizationController(
    {} as OrganizationService,
    mockApiKeyService as unknown as ApiKeyService,
  );

  const sessionAuthContext: AuthContext = {
    organizationId: 'org_123',
    authType: 'session',
    isApiKey: false,
    isPlatformAdmin: false,
    userId: 'usr_123',
    memberId: 'mem_123',
    userEmail: 'test@example.com',
    userRoles: ['owner'],
  };

  const apiKeyAuthContext: AuthContext = {
    organizationId: 'org_123',
    authType: 'api-key',
    isApiKey: true,
    isPlatformAdmin: false,
    userRoles: [],
  };

  beforeEach(() => {
    mockApiKeyService.create.mockReset();
    mockApiKeyService.create.mockResolvedValue({
      id: 'apk_1',
      key: 'comp_x',
    });
  });

  it('attributes a session-created key to the creating member', async () => {
    await controller.createApiKey('org_123', sessionAuthContext, {
      name: 'CI Pipeline',
      scopes: ['vendor:read'],
    });
    expect(mockApiKeyService.create).toHaveBeenCalledWith({
      organizationId: 'org_123',
      name: 'CI Pipeline',
      expiresAt: undefined,
      scopes: ['vendor:read'],
      provenance: { createdByMemberId: 'mem_123', organizationOwned: false },
    });
  });

  it('gives a key created through an API key that key creator', async () => {
    await controller.createApiKey(
      'org_123',
      {
        ...apiKeyAuthContext,
        apiKeyCreatedByMemberId: 'mem_creator',
        apiKeyScopes: ['apiKey:create', 'vendor:read'],
      },
      { name: 'Nested Key', scopes: ['vendor:read'] },
    );
    expect(mockApiKeyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: {
          createdByMemberId: 'mem_creator',
          organizationOwned: false,
        },
      }),
    );
  });

  it('refuses creation through a legacy API key with no creator (403)', async () => {
    await expect(
      controller.createApiKey('org_123', apiKeyAuthContext, {
        name: 'Nested Key',
        scopes: ['vendor:read'],
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(mockApiKeyService.create).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when name is missing', async () => {
    await expect(
      controller.createApiKey('org_123', sessionAuthContext, {
        name: '',
        scopes: ['vendor:read'],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mockApiKeyService.create).not.toHaveBeenCalled();
  });

  it('refuses a scope the creating API key does not hold (403)', async () => {
    await expect(
      controller.createApiKey(
        'org_123',
        {
          ...apiKeyAuthContext,
          apiKeyCreatedByMemberId: 'mem_creator',
          apiKeyScopes: ['apiKey:create'],
        },
        { name: 'Escalated', scopes: ['apiKey:create', 'vendor:read'] },
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(mockApiKeyService.create).not.toHaveBeenCalled();
  });

  it('lets an API key grant scopes it holds', async () => {
    await controller.createApiKey(
      'org_123',
      {
        ...apiKeyAuthContext,
        apiKeyCreatedByMemberId: 'mem_creator',
        apiKeyScopes: ['apiKey:create', 'vendor:read'],
      },
      { name: 'Narrow', scopes: ['vendor:read'] },
    );
    expect(mockApiKeyService.create).toHaveBeenCalled();
  });
});

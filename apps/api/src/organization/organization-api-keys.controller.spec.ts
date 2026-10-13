const mockOrganizationRoleFindMany = jest.fn();
jest.mock('@db', () => ({
  db: {
    organizationRole: {
      findMany: (...args: unknown[]) => mockOrganizationRoleFindMany(...args),
    },
  },
}));
jest.mock('../auth/auth.server', () => ({
  auth: { api: { getSession: jest.fn() } },
}));
jest.mock('@trycompai/auth', () => ({
  statement: { apiKey: ['create', 'read', 'delete'] },
  BUILT_IN_ROLE_PERMISSIONS: {
    owner: { apiKey: ['create'], vendor: ['read'], risk: ['read'] },
    admin: { apiKey: ['create'], vendor: ['read'], risk: ['read'] },
  },
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ApiKeyService } from '../auth/api-key.service';
import type { AuthContext } from '../auth/types';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { OrganizationApiKeysController } from './organization-api-keys.controller';
import type { OrganizationService } from './organization.service';

// POST /v1/organization/api-keys: who a new key belongs to, and what it may do.
describe('OrganizationApiKeysController.createApiKey', () => {
  const mockApiKeyService = {
    create: jest.fn(),
    getAvailableScopes: () => ['apiKey:create', 'vendor:read', 'risk:read'],
  };
  const controller = new OrganizationApiKeysController(
    {} as OrganizationService,
    mockApiKeyService as unknown as ApiKeyService,
  );

  const owner: AuthContext = {
    organizationId: 'org_123',
    authType: 'session',
    isApiKey: false,
    isPlatformAdmin: false,
    userId: 'usr_123',
    memberId: 'mem_123',
    userEmail: 'test@example.com',
    userRoles: ['owner'],
  };
  const admin: AuthContext = { ...owner, userRoles: ['admin'] };
  const apiKeyCaller: AuthContext = {
    organizationId: 'org_123',
    authType: 'api-key',
    isApiKey: true,
    isPlatformAdmin: false,
    userRoles: [],
  };

  const create = (caller: AuthContext, body: Partial<CreateApiKeyDto>) =>
    controller.createApiKey('org_123', caller, {
      name: 'CI Pipeline',
      scopes: ['vendor:read'],
      ...body,
    });

  beforeEach(() => {
    mockApiKeyService.create.mockReset();
    mockApiKeyService.create.mockResolvedValue({ id: 'apk_1', key: 'comp_x' });
    mockOrganizationRoleFindMany.mockReset();
    mockOrganizationRoleFindMany.mockResolvedValue([]);
  });

  it('attributes a session-created key to the creating member, personal by default', async () => {
    await create(owner, {});
    expect(mockApiKeyService.create).toHaveBeenCalledWith({
      organizationId: 'org_123',
      name: 'CI Pipeline',
      expiresAt: undefined,
      scopes: ['vendor:read'],
      provenance: { createdByMemberId: 'mem_123', organizationOwned: false },
    });
  });

  it('lets an owner create an organization-owned key', async () => {
    await create(owner, { organizationOwned: true });
    expect(mockApiKeyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: { createdByMemberId: 'mem_123', organizationOwned: true },
      }),
    );
  });

  it('refuses an organization-owned key to an admin (403)', async () => {
    await expect(create(admin, { organizationOwned: true })).rejects.toThrow(
      ForbiddenException,
    );
    expect(mockApiKeyService.create).not.toHaveBeenCalled();
  });

  it('lets an admin create a personal key', async () => {
    await create(admin, { organizationOwned: false });
    expect(mockApiKeyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: { createdByMemberId: 'mem_123', organizationOwned: false },
      }),
    );
  });

  it('refuses an organization-owned key through a personal API key (403)', async () => {
    await expect(
      create(
        {
          ...apiKeyCaller,
          apiKeyCreatedByMemberId: 'mem_123',
          apiKeyScopes: ['apiKey:create', 'vendor:read'],
        },
        { organizationOwned: true },
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(mockApiKeyService.create).not.toHaveBeenCalled();
  });

  it('gives a key created through an API key that key creator', async () => {
    await create(
      {
        ...apiKeyCaller,
        apiKeyCreatedByMemberId: 'mem_creator',
        apiKeyScopes: ['apiKey:create', 'vendor:read'],
      },
      { name: 'Nested Key' },
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
    await expect(create(apiKeyCaller, {})).rejects.toThrow(ForbiddenException);
    expect(mockApiKeyService.create).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when name is missing', async () => {
    await expect(create(owner, { name: '' })).rejects.toThrow(
      BadRequestException,
    );
    expect(mockApiKeyService.create).not.toHaveBeenCalled();
  });

  it('refuses a scope the creating API key does not hold (403)', async () => {
    await expect(
      create(
        {
          ...apiKeyCaller,
          apiKeyCreatedByMemberId: 'mem_creator',
          apiKeyScopes: ['apiKey:create'],
        },
        { scopes: ['apiKey:create', 'vendor:read'] },
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(mockApiKeyService.create).not.toHaveBeenCalled();
  });

  it('refuses a session member a scope beyond their custom role (403)', async () => {
    mockOrganizationRoleFindMany.mockResolvedValue([
      { permissions: { apiKey: ['create'], vendor: ['read'] } },
    ]);
    const ciBot: AuthContext = { ...owner, userRoles: ['ci-bot'] };
    await expect(
      create(ciBot, { scopes: ['vendor:read', 'risk:read'] }),
    ).rejects.toThrow(/risk:read/);
    expect(mockApiKeyService.create).not.toHaveBeenCalled();
    await create(ciBot, { scopes: ['vendor:read'] });
    expect(mockApiKeyService.create).toHaveBeenCalledTimes(1);
  });
});

describe('CreateApiKeyDto validation', () => {
  const errorsFor = async (body: Record<string, unknown>) =>
    (
      await validate(plainToInstance(CreateApiKeyDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    ).map((error) => error.property);

  it('accepts the body the web app sends, with or without organizationOwned', async () => {
    const body = { name: 'CI', expiresAt: '90days', scopes: ['risk:read'] };
    expect(await errorsFor(body)).toEqual([]);
    expect(await errorsFor({ ...body, organizationOwned: true })).toEqual([]);
  });

  it('rejects a non-boolean organizationOwned, an unknown expiry and unknown fields', async () => {
    expect(
      await errorsFor({ name: 'CI', scopes: [], organizationOwned: 'yes' }),
    ).toEqual(['organizationOwned']);
    expect(await errorsFor({ name: 'CI', expiresAt: '2days' })).toEqual([
      'expiresAt',
    ]);
    expect(await errorsFor({ name: 'CI', createdByMemberId: 'mem_x' })).toEqual(
      ['createdByMemberId'],
    );
  });
});

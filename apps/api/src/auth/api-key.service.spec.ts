import { createHash } from 'node:crypto';

// Mock @db so importing the service never builds a real Prisma client.
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

jest.mock('@trycompai/auth', () => ({
  statement: {
    organization: ['read', 'update', 'delete'],
    member: ['create', 'read', 'update', 'delete'],
    invitation: ['create', 'read', 'delete'],
    team: ['create', 'read', 'update', 'delete'],
    control: ['create', 'read', 'update', 'delete'],
    evidence: ['create', 'read', 'update', 'delete'],
    policy: ['create', 'read', 'update', 'delete'],
    risk: ['create', 'read', 'update', 'delete'],
    vendor: ['create', 'read', 'update', 'delete'],
    task: ['create', 'read', 'update', 'delete'],
    framework: ['create', 'read', 'update', 'delete'],
    audit: ['create', 'read', 'update'],
    finding: ['create', 'read', 'update', 'delete'],
    questionnaire: ['create', 'read', 'update', 'delete'],
    integration: ['create', 'read', 'update', 'delete'],
    apiKey: ['create', 'read', 'delete'],
    app: ['read'],
    trust: ['read', 'update'],
    pentest: ['create', 'read', 'delete'],
    training: ['read', 'update'],
  },
}));

import { ApiKeyService } from './api-key.service';

describe('ApiKeyService', () => {
  let service: ApiKeyService;

  beforeEach(() => {
    service = new ApiKeyService();
  });

  describe('getAvailableScopes', () => {
    let scopes: string[];

    beforeEach(() => {
      scopes = service.getAvailableScopes();
    });

    it('should not include any invitation:* scopes', () => {
      const matches = scopes.filter((s) => s.startsWith('invitation:'));
      expect(matches).toEqual([]);
    });

    it('should not include any team:* scopes', () => {
      const matches = scopes.filter((s) => s.startsWith('team:'));
      expect(matches).toEqual([]);
    });

    it('should not include any compliance:* scopes', () => {
      const matches = scopes.filter((s) => s.startsWith('compliance:'));
      expect(matches).toEqual([]);
    });

    it('should include expected public resources', () => {
      const expected = [
        'risk',
        'vendor',
        'task',
        'control',
        'policy',
        'evidence',
        'framework',
        'audit',
        'finding',
        'questionnaire',
        'integration',
        'apiKey',
        'pentest',
      ];
      for (const resource of expected) {
        const matching = scopes.filter((s) => s.startsWith(`${resource}:`));
        expect(matching.length).toBeGreaterThan(0);
      }
    });

    it('should return scopes in resource:action format', () => {
      for (const scope of scopes) {
        expect(scope).toMatch(/^[a-zA-Z]+:[a-zA-Z]+$/);
      }
    });

    it('should not return an empty array', () => {
      expect(scopes.length).toBeGreaterThan(0);
    });
  });
});

describe('ApiKeyService.validateApiKey offboarding', () => {
  const RAW_KEY = `comp_${'ab'.repeat(32)}`;
  const SALT = 'salt-1';
  let service: ApiKeyService;

  function keyRecord(overrides: Record<string, unknown> = {}) {
    return {
      id: 'apk_1',
      name: 'CI Pipeline',
      key: createHash('sha256')
        .update(RAW_KEY + SALT)
        .digest('hex'),
      salt: SALT,
      organizationId: 'org_1',
      expiresAt: null,
      scopes: ['risk:read'],
      createdByMemberId: 'mem_creator',
      organizationOwned: false,
      createdBy: { isActive: true, deactivated: false },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockApiKeyUpdate.mockResolvedValue({});
    service = new ApiKeyService();
  });

  it('accepts a key whose creator is an active member', async () => {
    mockApiKeyFindMany.mockResolvedValueOnce([keyRecord()]);
    const result = await service.validateApiKey(RAW_KEY);
    expect(result).toEqual({
      apiKeyId: 'apk_1',
      apiKeyName: 'CI Pipeline',
      organizationId: 'org_1',
      scopes: ['risk:read'],
      createdByMemberId: 'mem_creator',
      organizationOwned: false,
    });
  });

  it('selects the creator status and the organization-owned flag', async () => {
    mockApiKeyFindMany.mockResolvedValueOnce([keyRecord()]);
    await service.validateApiKey(RAW_KEY);
    const { select } = mockApiKeyFindMany.mock.calls[0][0];
    expect(select.organizationOwned).toBe(true);
    expect(select.createdBy).toEqual({
      select: { isActive: true, deactivated: true },
    });
  });

  it('rejects a key whose creator was deactivated', async () => {
    mockApiKeyFindMany.mockResolvedValueOnce([
      keyRecord({ createdBy: { isActive: false, deactivated: true } }),
    ]);
    await expect(service.validateApiKey(RAW_KEY)).resolves.toBeNull();
    expect(mockApiKeyUpdate).not.toHaveBeenCalled();
  });

  it('rejects a key whose creator is inactive but not yet deactivated', async () => {
    mockApiKeyFindMany.mockResolvedValueOnce([
      keyRecord({ createdBy: { isActive: false, deactivated: false } }),
    ]);
    await expect(service.validateApiKey(RAW_KEY)).resolves.toBeNull();
  });

  it('rejects a key whose recorded creator no longer exists', async () => {
    mockApiKeyFindMany.mockResolvedValueOnce([keyRecord({ createdBy: null })]);
    await expect(service.validateApiKey(RAW_KEY)).resolves.toBeNull();
  });

  it('accepts an organization-owned key whose creator left', async () => {
    mockApiKeyFindMany.mockResolvedValueOnce([
      keyRecord({
        organizationOwned: true,
        createdBy: { isActive: false, deactivated: true },
      }),
    ]);
    const result = await service.validateApiKey(RAW_KEY);
    expect(result?.organizationOwned).toBe(true);
    expect(result?.createdByMemberId).toBe('mem_creator');
  });

  it('accepts a legacy key with no recorded creator', async () => {
    mockApiKeyFindMany.mockResolvedValueOnce([
      keyRecord({ createdByMemberId: null, createdBy: null }),
    ]);
    const result = await service.validateApiKey(RAW_KEY);
    expect(result?.createdByMemberId).toBeNull();
  });

  it('applies the creator check to keys found by the legacy no-prefix lookup', async () => {
    mockApiKeyFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        keyRecord({ createdBy: { isActive: false, deactivated: true } }),
      ]);
    await expect(service.validateApiKey(RAW_KEY)).resolves.toBeNull();
    expect(mockApiKeyUpdate).not.toHaveBeenCalled();
  });
});

// The query shape of key validation: a well-formed key is looked up by its
// indexed prefix; anything else, or a prefixed key not found that way, is
// checked against the legacy keys (no stored prefix) only, all of them.
import { createHash } from 'node:crypto';

const mockApiKeyFindMany = jest.fn();
const mockApiKeyCount = jest.fn();
jest.mock('@db', () => ({
  db: {
    apiKey: {
      findMany: (...args: unknown[]) => mockApiKeyFindMany(...args),
      count: (...args: unknown[]) => mockApiKeyCount(...args),
      update: jest.fn(),
    },
  },
}));
jest.mock('@trycompai/auth', () => ({ statement: {} }));

import { reportLegacyApiKeys } from './api-key-lookup';
import { ApiKeyService } from './api-key.service';
import { LEGACY_CREATOR_CUTOFF } from './api-key-validation';

function legacyRow(index: number, apiKey: string) {
  return {
    id: `apk_${index}`,
    name: `legacy ${index}`,
    key: createHash('sha256').update(apiKey).digest('hex'),
    salt: null,
    organizationId: 'org_1',
    expiresAt: null,
    scopes: [],
    createdByMemberId: null,
    organizationOwned: false,
    createdAt: new Date(LEGACY_CREATOR_CUTOFF.getTime() - 86_400_000),
    createdBy: null,
  };
}

describe('ApiKeyService.validateApiKey lookup shape', () => {
  const PREFIXED_KEY = `comp_${'cd'.repeat(32)}`;
  let service: ApiKeyService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApiKeyFindMany.mockResolvedValue([]);
    service = new ApiKeyService();
  });

  const argsOf = (call: number) =>
    mockApiKeyFindMany.mock.calls[call][0] as {
      where: Record<string, unknown>;
      take?: number;
    };

  it('looks a well-formed key up by its indexed prefix only', async () => {
    await service.validateApiKey(PREFIXED_KEY);
    expect(argsOf(0).where.keyPrefix).toBe('cdcdcdcd');
  });

  it('falls back only to legacy keys without a prefix, all of them', async () => {
    await service.validateApiKey(PREFIXED_KEY);
    expect(mockApiKeyFindMany).toHaveBeenCalledTimes(2);
    expect(argsOf(1).where.keyPrefix).toBeNull();
    expect(argsOf(1).where.isActive).toBe(true);
    expect(argsOf(1).take).toBeUndefined();
  });

  it.each([
    'garbage',
    'comp_short',
    `bubba_${'ef'.repeat(32)}`,
    `comp_${'zz'.repeat(32)}`,
  ])(
    'performs one legacy-only lookup for the malformed key %p',
    async (key) => {
      await expect(service.validateApiKey(key)).resolves.toBeNull();
      expect(mockApiKeyFindMany).toHaveBeenCalledTimes(1);
      expect(argsOf(0).where.keyPrefix).toBeNull();
    },
  );

  it('authenticates the 101st legacy key', async () => {
    const presented = 'legacy-key-101';
    const rows = Array.from({ length: 100 }, (_, i) =>
      legacyRow(i, `other-legacy-key-${i}`),
    );
    rows.push(legacyRow(100, presented));
    // Like the database, honour a row limit if one is asked for.
    mockApiKeyFindMany.mockImplementation(({ take }: { take?: number }) =>
      Promise.resolve(rows.slice(0, take ?? rows.length)),
    );
    await expect(service.validateApiKey(presented)).resolves.toMatchObject({
      apiKeyId: 'apk_100',
      organizationId: 'org_1',
    });
  });

  it('never scans the whole key table', async () => {
    for (const key of [PREFIXED_KEY, 'garbage']) {
      await service.validateApiKey(key);
    }
    for (const [args] of mockApiKeyFindMany.mock.calls as [
      { where: Record<string, unknown> },
    ][]) {
      expect(args.where).toHaveProperty('keyPrefix');
    }
  });
});

describe('reportLegacyApiKeys (boot warning)', () => {
  const warn = jest.fn<void, [string]>();

  beforeEach(() => jest.clearAllMocks());

  it('warns with the count of active legacy keys only', async () => {
    mockApiKeyCount.mockResolvedValue(3);
    await reportLegacyApiKeys({ warn });
    const where = (mockApiKeyCount.mock.calls[0][0] as { where: object })
      .where as Record<string, unknown>;
    expect(where.keyPrefix).toBeNull();
    expect(where.isActive).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/\b3 active/);
  });

  it('stays quiet when there are none', async () => {
    mockApiKeyCount.mockResolvedValue(0);
    await reportLegacyApiKeys({ warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('never fails boot when the count cannot be read', async () => {
    mockApiKeyCount.mockRejectedValue(new Error('database down'));
    await expect(reportLegacyApiKeys({ warn })).resolves.toBeUndefined();
  });

  it('runs once the application has started', async () => {
    mockApiKeyCount.mockResolvedValue(0);
    new ApiKeyService().onApplicationBootstrap();
    await new Promise((settle) => setImmediate(settle));
    expect(mockApiKeyCount).toHaveBeenCalledTimes(1);
  });
});

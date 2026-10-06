// The query shape of key validation: a junk key must cost one bounded,
// indexed lookup, never a scan and hash of every stored key.
const mockApiKeyFindMany = jest.fn();
jest.mock('@db', () => ({
  db: {
    apiKey: {
      findMany: (...args: unknown[]) => mockApiKeyFindMany(...args),
      update: jest.fn(),
    },
  },
}));
jest.mock('@trycompai/auth', () => ({ statement: {} }));

import { ApiKeyService } from './api-key.service';
import { LEGACY_KEY_SCAN_LIMIT } from './api-key-validation';

describe('ApiKeyService.validateApiKey lookup shape', () => {
  const PREFIXED_KEY = `comp_${'cd'.repeat(32)}`;
  let service: ApiKeyService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApiKeyFindMany.mockResolvedValue([]);
    service = new ApiKeyService();
  });

  const whereOf = (call: number) =>
    (
      mockApiKeyFindMany.mock.calls[call][0] as {
        where: Record<string, unknown>;
      }
    ).where;
  const takeOf = (call: number) =>
    (mockApiKeyFindMany.mock.calls[call][0] as { take?: number }).take;

  it('looks a well-formed key up by its indexed prefix only', async () => {
    await service.validateApiKey(PREFIXED_KEY);
    expect(whereOf(0).keyPrefix).toBe('cdcdcdcd');
  });

  it('falls back only to legacy keys without a prefix, with a bounded result', async () => {
    await service.validateApiKey(PREFIXED_KEY);
    expect(mockApiKeyFindMany).toHaveBeenCalledTimes(2);
    expect(whereOf(1).keyPrefix).toBeNull();
    expect(takeOf(1)).toBe(LEGACY_KEY_SCAN_LIMIT);
  });

  it.each([
    'garbage',
    'comp_short',
    `bubba_${'ef'.repeat(32)}`,
    `comp_${'zz'.repeat(32)}`,
  ])(
    'performs at most one bounded legacy lookup for the malformed key %p',
    async (key) => {
      await expect(service.validateApiKey(key)).resolves.toBeNull();
      expect(mockApiKeyFindMany).toHaveBeenCalledTimes(1);
      expect(whereOf(0).keyPrefix).toBeNull();
      expect(takeOf(0)).toBe(LEGACY_KEY_SCAN_LIMIT);
    },
  );

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

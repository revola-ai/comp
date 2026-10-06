import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const patch = vi.fn();
const get = vi.fn();

vi.mock('@/lib/api-server', () => ({ serverApi: { post, patch, get } }));
vi.mock('@trigger.dev/sdk', () => ({ auth: {}, runs: {}, tasks: {} }));
vi.mock('@/trigger/tasks/cloud-security/execute-result', () => ({
  classifyExecuteResult: vi.fn(),
}));
vi.mock('@/trigger/tasks/cloud-security/retry-preview', () => ({
  classifyRetryPreview: vi.fn(),
}));

const MODULES = {
  'cloud-tests': () => import('./batch-fix'),
  'integrations/[slug]': () => import('../../integrations/[slug]/actions/batch-fix'),
};

function requestedPath(mock: typeof post): string {
  return new URL(String(mock.mock.calls[0]?.[0]), 'http://comp-api.comp.internal:3333').pathname;
}

describe.each(Object.entries(MODULES))('%s batch-fix actions', (_name, load) => {
  beforeEach(() => {
    for (const mock of [post, patch, get]) {
      mock.mockReset();
      mock.mockResolvedValue({ status: 200, data: null });
    }
  });

  it('skipBatchFinding keeps traversal ids inside the batch resource', async () => {
    const { skipBatchFinding } = await load();
    await skipBatchFinding('../internal/x', '../../integration-debug/connections');
    expect(requestedPath(post)).toBe(
      '/v1/cloud-security/remediation/batch/..%2Finternal%2Fx/skip/..%2F..%2Fintegration-debug%2Fconnections',
    );
  });

  it('skipBatchFinding refuses a bare dot-dot id without calling the API', async () => {
    const { skipBatchFinding } = await load();
    await skipBatchFinding('..', '..');
    expect(post).not.toHaveBeenCalled();
  });

  it('cancelBatchFix keeps a traversal batch id inside the batch resource', async () => {
    const { cancelBatchFix } = await load();
    await cancelBatchFix('run_1', '../internal/x').catch(() => undefined);
    expect(requestedPath(patch)).toBe('/v1/cloud-security/remediation/batch/..%2Finternal%2Fx');
  });

  it('getActiveBatch sends the connection id as one query value', async () => {
    const { getActiveBatch } = await load();
    await getActiveBatch('icn_1&organizationId=other');
    const url = new URL(String(get.mock.calls[0]?.[0]), 'http://api.test');
    expect(url.searchParams.get('connectionId')).toBe('icn_1&organizationId=other');
    expect(url.searchParams.get('organizationId')).toBeNull();
  });
});

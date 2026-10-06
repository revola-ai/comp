import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPolicyTools } from './policy-tools';

const fetchMock = vi.fn();
const toolOptions = { toolCallId: 'call_1', messages: [] };

function requestedUrl(): URL {
  return new URL(String(fetchMock.mock.calls[0]?.[0]));
}

describe('policy tools build API paths from model-supplied ids safely', () => {
  beforeEach(() => {
    vi.stubEnv('BACKEND_API_URL', 'http://comp-api.comp.internal:3333');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{"data":[],"count":0}', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const tools = () => getPolicyTools({ currentPolicyId: 'pol_current', incoming: new Headers() });

  it('getVendor keeps a traversal id inside /v1/vendors', async () => {
    await tools().getVendor.execute?.(
      { vendorId: '../internal/integration-debug/connections' },
      toolOptions,
    );
    const url = requestedUrl();
    expect(url.pathname).toBe('/v1/vendors/..%2Finternal%2Fintegration-debug%2Fconnections');
  });

  it('getVendor refuses a bare dot-dot id without calling the API', async () => {
    const result = await tools().getVendor.execute?.({ vendorId: '..' }, toolOptions);
    expect(result).toEqual({ error: 'Vendor not found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getPolicy keeps a traversal id inside /v1/policies', async () => {
    await tools().getPolicy.execute?.({ policyId: '../internal/x' }, toolOptions);
    expect(requestedUrl().pathname).toBe('/v1/policies/..%2Finternal%2Fx');
  });

  it('listEvidence encodes the form type as one query value', async () => {
    await tools().listEvidence.execute?.({ formType: 'meeting&organizationId=other' }, toolOptions);
    const url = requestedUrl();
    expect(url.pathname).toBe('/v1/evidence');
    expect([...url.searchParams.entries()]).toEqual([['formType', 'meeting&organizationId=other']]);
  });
});

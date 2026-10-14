import { BackgroundCheckIdentityClient } from './background-check-identity.client';

describe('BackgroundCheckIdentityClient idempotency key', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BACKGROUND_CHECK_API_KEY: 'bc_test',
      BACKGROUND_CHECK_API_BASE_URL: 'https://identity.test',
      BACKGROUND_WH_ENDPOINT:
        'https://api.comp.revola.ai/v1/background-checks/webhook',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  function mockFetchOk() {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ id: 'check_1', status: 'invited' })),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function keyFrom(fetchMock: jest.Mock): string {
    const init = fetchMock.mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    return init.headers['Idempotency-Key'];
  }

  const params = {
    organizationId: 'org_1',
    memberId: 'mem_1',
    employeeName: 'Ada',
    employeeEmail: 'ada@example.com',
    requesterEmail: 'admin@example.com',
  };

  it('refuses, without calling Identity, when BACKGROUND_WH_ENDPOINT is unset', async () => {
    // An upstream default would have Identity post results about Revola employees to
    // upstream Comp's API.
    delete process.env.BACKGROUND_WH_ENDPOINT;
    const fetchMock = mockFetchOk();
    await expect(
      new BackgroundCheckIdentityClient().createBackgroundCheck({
        ...params,
        idempotencyKey: 'comp-background-check:bcr_1',
      }),
    ).rejects.toThrow('Background check service is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the provided idempotency key as the Idempotency-Key header', async () => {
    const fetchMock = mockFetchOk();
    await new BackgroundCheckIdentityClient().createBackgroundCheck({
      ...params,
      idempotencyKey: 'comp-background-check:bcr_1',
    });
    expect(keyFrom(fetchMock)).toBe('comp-background-check:bcr_1');
  });

  it('forwards a per-attempt retry idempotency key unchanged', async () => {
    const fetchMock = mockFetchOk();
    await new BackgroundCheckIdentityClient().createBackgroundCheck({
      ...params,
      idempotencyKey: 'comp-background-check:bcr_1:2',
    });
    expect(keyFrom(fetchMock)).toBe('comp-background-check:bcr_1:2');
  });
});

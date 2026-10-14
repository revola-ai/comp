// The whole hosted-MCP OAuth flow on the real better-auth (loaded by Node, see
// test/native-module.ts) with an in-memory store: better-auth's mcp plugin
// looks clients up only in its oauthApplication table (oidcConfig's
// trustedClients is ignored by /mcp/authorize and /mcp/token), and
// /mcp/register is refused, so Gram works only once the API has written its
// row from GRAM_OAUTH_* (syncGramOAuthApplication, run at boot). Only the Comp
// database lookups of authenticateMcpOAuth are mocked.
function mockNativeModule(id: string): unknown {
  const loader: typeof import('../../test/native-module') = jest.requireActual(
    '../../test/native-module',
  );
  return loader.nativeModule(id);
}
jest.mock('better-auth', () => mockNativeModule('better-auth'));
jest.mock('better-auth/api', () => mockNativeModule('better-auth/api'));
jest.mock('better-auth/plugins', () => mockNativeModule('better-auth/plugins'));
jest.mock('better-auth/adapters/memory', () =>
  mockNativeModule('better-auth/adapters/memory'),
);

const mockStore: Record<string, Record<string, unknown>[]> = {
  user: [],
  session: [],
  account: [],
  verification: [],
  oauthApplication: [],
  oauthAccessToken: [],
  oauthConsent: [],
};
const mockGramEnv = {
  GRAM_OAUTH_CLIENT_ID: 'gram-client-id',
  GRAM_OAUTH_CLIENT_SECRET: 'gram-client-secret-value',
  GRAM_OAUTH_REDIRECT_URI: 'https://gram.example/oauth/callback',
};
jest.mock('./auth.server', () => {
  const { betterAuth } =
    jest.requireMock<typeof import('better-auth')>('better-auth');
  const { memoryAdapter } = jest.requireMock<
    typeof import('better-auth/adapters/memory')
  >('better-auth/adapters/memory');
  const { gramMcpPlugins } =
    jest.requireActual<typeof import('./gram-mcp-oauth')>('./gram-mcp-oauth');
  return {
    auth: betterAuth({
      baseURL: 'http://localhost:3333',
      secret: 'test-secret-'.repeat(4),
      database: memoryAdapter(mockStore),
      logger: { disabled: true },
      emailAndPassword: { enabled: true },
      plugins: gramMcpPlugins({
        env: mockGramEnv,
        loginPage: 'http://localhost:3000/login',
      }),
    }),
  };
});
jest.mock('@db', () => ({
  db: {
    user: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id, email: 'm@revola.ai', role: null }),
    },
    member: {
      findMany: () =>
        Promise.resolve([
          {
            id: 'mem_1',
            role: 'admin',
            department: null,
            organizationId: 'org_1',
          },
        ]),
    },
  },
}));
jest.mock('./app-access', () => ({ hasAppAccess: () => true }));

import { auth } from './auth.server';
import { syncGramOAuthApplication } from './gram-mcp-client-sync';
import { authenticateMcpOAuth } from './mcp-oauth-auth';
import type { AuthenticatedRequest } from './types';

const API = 'http://localhost:3333/api/auth';

async function signedInCookie(): Promise<string> {
  const { headers } = await auth.api.signUpEmail({
    body: { email: 'm@revola.ai', password: 'a-long-password-1', name: 'M' },
    returnHeaders: true,
  });
  return (headers.get('set-cookie') ?? '')
    .split(/,(?=\s*[\w.-]+=)/)
    .map((cookie) => cookie.split(';')[0].trim())
    .join('; ');
}

function authorize({ cookie, clientId }: { cookie: string; clientId: string }) {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: mockGramEnv.GRAM_OAUTH_REDIRECT_URI,
    scope: 'openid email',
    state: 'xyz',
  });
  return auth.handler(
    new Request(`${API}/mcp/authorize?${query}`, { headers: { cookie } }),
  );
}

function exchange(code: string) {
  return auth.handler(
    new Request(`${API}/mcp/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: mockGramEnv.GRAM_OAUTH_REDIRECT_URI,
        client_id: mockGramEnv.GRAM_OAUTH_CLIENT_ID,
        client_secret: mockGramEnv.GRAM_OAUTH_CLIENT_SECRET,
      }),
    }),
  );
}

async function guardAccepts(token: string) {
  const request = { headers: {} } as AuthenticatedRequest;
  const accepted = await authenticateMcpOAuth({
    request,
    headers: new Headers({ authorization: `Bearer ${token}` }),
    onAccepted: () => undefined,
  });
  return { accepted, request };
}

const adapter = async () => (await auth.$context).adapter;

describe('Gram MCP OAuth, end to end on better-auth', () => {
  const savedEnv = { ...process.env };
  const log = jest.fn();
  let cookie: string;

  beforeAll(async () => {
    Object.assign(process.env, mockGramEnv);
    cookie = await signedInCookie();
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('without the synced row, authorize sends Gram to invalid_client', async () => {
    const response = await authorize({
      cookie,
      clientId: mockGramEnv.GRAM_OAUTH_CLIENT_ID,
    });
    expect(response.headers.get('location')).toContain('error=invalid_client');
  });

  it('boot sync writes Gram row the way better-auth reads it, and logs no secret', async () => {
    await expect(
      syncGramOAuthApplication({
        env: mockGramEnv,
        adapter: await adapter(),
        log,
      }),
    ).resolves.toBe('created');
    await expect(
      syncGramOAuthApplication({
        env: mockGramEnv,
        adapter: await adapter(),
        log,
      }),
    ).resolves.toBe('unchanged');
    expect(mockStore.oauthApplication).toEqual([
      expect.objectContaining({
        clientId: mockGramEnv.GRAM_OAUTH_CLIENT_ID,
        clientSecret: mockGramEnv.GRAM_OAUTH_CLIENT_SECRET,
        redirectUrls: mockGramEnv.GRAM_OAUTH_REDIRECT_URI,
        type: 'web',
        disabled: false,
      }),
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      mockGramEnv.GRAM_OAUTH_CLIENT_SECRET,
    );
  });

  it('a signed-in user authorizes Gram, Gram exchanges the code, the guard accepts the token', async () => {
    const authorized = await authorize({
      cookie,
      clientId: mockGramEnv.GRAM_OAUTH_CLIENT_ID,
    });
    expect(authorized.status).toBe(302);
    const location = new URL(authorized.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(
      mockGramEnv.GRAM_OAUTH_REDIRECT_URI,
    );
    expect(location.searchParams.get('state')).toBe('xyz');
    const code = location.searchParams.get('code') ?? '';
    expect(code).not.toBe('');

    const tokenResponse = await exchange(code);
    expect(tokenResponse.status).toBe(200);
    const { access_token: accessToken } = (await tokenResponse.json()) as {
      access_token: string;
    };

    const { accepted, request } = await guardAccepts(accessToken);
    expect(accepted).toBe(true);
    expect(request.isMcpOAuth).toBe(true);
    expect(request.organizationId).toBe('org_1');
    expect(request.userId).toBe(mockStore.user[0]?.id);
  });

  it('a client other than Gram still fails, even with its own row', async () => {
    mockStore.oauthApplication.push({
      id: 'oap_other',
      name: 'Registered before the gate',
      clientId: 'other-client',
      clientSecret: 'other-secret',
      redirectUrls: mockGramEnv.GRAM_OAUTH_REDIRECT_URI,
      type: 'web',
      disabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await authorize({ cookie, clientId: 'other-client' });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('a changed redirect URI or secret updates the one row', async () => {
    const env = {
      ...mockGramEnv,
      GRAM_OAUTH_REDIRECT_URI: 'https://gram.example/oauth/callback-2',
    };
    await expect(
      syncGramOAuthApplication({ env, adapter: await adapter(), log }),
    ).resolves.toBe('updated');
    const gramRows = mockStore.oauthApplication.filter(
      (row) => row.clientId === mockGramEnv.GRAM_OAUTH_CLIENT_ID,
    );
    expect(gramRows).toEqual([
      expect.objectContaining({ redirectUrls: env.GRAM_OAUTH_REDIRECT_URI }),
    ]);
  });

  it('does nothing without GRAM_OAUTH_*', async () => {
    await expect(
      syncGramOAuthApplication({ env: {}, adapter: await adapter(), log }),
    ).resolves.toBe('not-configured');
  });

  it('the discovery document advertises no registration endpoint', async () => {
    const response = await auth.handler(
      new Request(`${API}/.well-known/oauth-authorization-server`),
    );
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.token_endpoint).toBe(`${API}/mcp/token`);
    expect(metadata).not.toHaveProperty('registration_endpoint');
  });
});

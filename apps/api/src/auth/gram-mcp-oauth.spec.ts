import type { BetterAuthOptions } from 'better-auth';

// The real better-auth runs (loaded by Node, see test/native-module.ts) with an
// in-memory database, so these requests take the library's own routing,
// hooks and MCP endpoints.
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

import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { readGramMcpClient } from './gram-mcp-client';
import { gramMcpPlugins } from './gram-mcp-oauth';

const BASE = 'http://localhost:3333';
const GRAM = {
  GRAM_OAUTH_CLIENT_ID: 'gram-client-id',
  GRAM_OAUTH_CLIENT_SECRET: 'gram-client-secret',
  GRAM_OAUTH_REDIRECT_URI: 'https://gram.example/oauth/callback',
};

function authWith({ env }: { env: Record<string, string> }) {
  const options = {
    baseURL: BASE,
    secret: 'test-secret-'.repeat(4),
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      oauthApplication: [],
      oauthAccessToken: [],
      oauthConsent: [],
    }),
    logger: { disabled: true },
    plugins: [...gramMcpPlugins({ env, loginPage: `${BASE}/login` })],
  } satisfies BetterAuthOptions;
  return betterAuth(options);
}

function post({ path, body }: { path: string; body: unknown }): Request {
  return new Request(`${BASE}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ATTACKER_CLIENT = { redirect_uris: ['https://attacker.example/cb'] };

describe('readGramMcpClient', () => {
  it('is null unless the id, secret and redirect URI are all set', () => {
    expect(readGramMcpClient({ env: {} })).toBeNull();
    expect(
      readGramMcpClient({ env: { ...GRAM, GRAM_OAUTH_CLIENT_SECRET: ' ' } }),
    ).toBeNull();
    expect(readGramMcpClient({ env: GRAM })).toEqual({
      clientId: GRAM.GRAM_OAUTH_CLIENT_ID,
      clientSecret: GRAM.GRAM_OAUTH_CLIENT_SECRET,
      redirectUri: GRAM.GRAM_OAUTH_REDIRECT_URI,
    });
  });
});

describe('MCP OAuth endpoints without the Gram client', () => {
  const auth = authWith({ env: {} });

  it.each([
    ['POST', '/mcp/register'],
    ['GET', '/mcp/authorize?client_id=x&response_type=code'],
    ['POST', '/mcp/token'],
    ['GET', '/mcp/get-session'],
    ['GET', '/.well-known/oauth-authorization-server'],
  ])('%s %s is not served', async (method, path) => {
    const response = await auth.handler(
      new Request(`${BASE}/api/auth${path}`, { method }),
    );
    expect(response.status).toBe(404);
  });
});

describe('MCP OAuth endpoints with the Gram client', () => {
  const auth = authWith({ env: GRAM });

  it('refuses anonymous dynamic client registration', async () => {
    const response = await auth.handler(
      post({ path: '/mcp/register', body: ATTACKER_CLIENT }),
    );
    expect(response.status).toBe(404);
    const context = await auth.$context;
    expect(await context.adapter.count({ model: 'oauthApplication' })).toBe(0);
  });

  it('refuses registration through the server API too (any caller)', async () => {
    await expect(
      auth.api.registerMcpClient({ body: ATTACKER_CLIENT }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses an authorization request for any client but Gram', async () => {
    const query = new URLSearchParams({
      client_id: 'attacker-client',
      response_type: 'code',
      redirect_uri: 'https://attacker.example/cb',
    });
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/mcp/authorize?${query}`),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('starts the authorization flow for the Gram client', async () => {
    const query = new URLSearchParams({
      client_id: GRAM.GRAM_OAUTH_CLIENT_ID,
      response_type: 'code',
      redirect_uri: GRAM.GRAM_OAUTH_REDIRECT_URI,
      scope: 'openid',
    });
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/mcp/authorize?${query}`),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain(`${BASE}/login`);
  });
});

// HybridAuthGuard's MCP path (authenticateMcpOAuth) must accept only access
// tokens issued to the Gram client: a token minted for any other OAuth client
// is refused. The real better-auth runs (loaded by Node, see
// test/native-module.ts) with an in-memory store holding the tokens; only the
// Comp database lookups are mocked.
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
  GRAM_OAUTH_CLIENT_SECRET: 'gram-client-secret',
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
      plugins: gramMcpPlugins({ env: mockGramEnv, loginPage: '/login' }),
    }),
  };
});
jest.mock('@db', () => ({
  db: {
    user: {
      findUnique: () =>
        Promise.resolve({ id: 'usr_1', email: 'm@revola.ai', role: 'admin' }),
    },
    member: {
      findMany: () =>
        Promise.resolve([
          {
            id: 'mem_1',
            role: 'owner',
            department: null,
            organizationId: 'org_1',
          },
        ]),
    },
  },
}));
jest.mock('./app-access', () => ({ hasAppAccess: () => true }));

import { authenticateMcpOAuth } from './mcp-oauth-auth';
import type { AuthenticatedRequest } from './types';

function issueToken({ token, clientId }: { token: string; clientId: string }) {
  const now = Date.now();
  mockStore.oauthAccessToken.push({
    id: `tok_${token}`,
    accessToken: token,
    refreshToken: `refresh-${token}`,
    accessTokenExpiresAt: new Date(now + 3_600_000),
    refreshTokenExpiresAt: new Date(now + 7_200_000),
    clientId,
    userId: 'usr_1',
    scopes: 'openid',
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
}

async function authenticate(token: string) {
  const request = { headers: {} } as AuthenticatedRequest;
  const onAccepted = jest.fn();
  const accepted = await authenticateMcpOAuth({
    request,
    headers: new Headers({ authorization: `Bearer ${token}` }),
    onAccepted,
  });
  return { accepted, request, onAccepted };
}

describe('authenticateMcpOAuth client binding', () => {
  const savedEnv = { ...process.env };

  beforeAll(() => {
    Object.assign(process.env, mockGramEnv);
    issueToken({ token: 'gram-token', clientId: 'gram-client-id' });
    issueToken({ token: 'rogue-token', clientId: 'attacker-client' });
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('accepts a token issued to the Gram client', async () => {
    const { accepted, request, onAccepted } = await authenticate('gram-token');
    expect(accepted).toBe(true);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(request.userId).toBe('usr_1');
    expect(request.organizationId).toBe('org_1');
    expect(request.isMcpOAuth).toBe(true);
  });

  it('refuses a token issued to any other client', async () => {
    const { accepted, request, onAccepted } = await authenticate('rogue-token');
    expect(accepted).toBe(false);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(request.userId).toBeUndefined();
  });

  it('refuses an unknown token', async () => {
    expect((await authenticate('unknown-token')).accepted).toBe(false);
  });

  it('refuses every token when the Gram client is not configured', async () => {
    delete process.env.GRAM_OAUTH_CLIENT_ID;
    try {
      expect((await authenticate('gram-token')).accepted).toBe(false);
    } finally {
      process.env.GRAM_OAUTH_CLIENT_ID = mockGramEnv.GRAM_OAUTH_CLIENT_ID;
    }
  });
});

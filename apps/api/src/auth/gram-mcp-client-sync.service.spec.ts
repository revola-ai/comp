import { Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';

const mockAdapter = {
  findOne: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
};
const mockContextRead = jest.fn();
jest.mock('./auth.server', () => ({
  auth: {
    get $context() {
      mockContextRead();
      return Promise.resolve({ adapter: mockAdapter });
    },
  },
}));
jest.mock('@thallesp/nestjs-better-auth', () => ({
  AuthModule: { forRoot: () => ({ module: class BetterAuthStub {} }) },
}));
jest.mock('@db', () => ({ db: {} }));
jest.mock('@trycompai/auth', () => ({
  statement: {},
  BUILT_IN_ROLE_PERMISSIONS: {},
}));

import { AuthModule } from './auth.module';
import { GramMcpClientSync } from './gram-mcp-client-sync.service';

const GRAM = {
  GRAM_OAUTH_CLIENT_ID: 'gram-client-id',
  GRAM_OAUTH_CLIENT_SECRET: 'gram-secret-value',
  GRAM_OAUTH_REDIRECT_URI: 'https://gram.example/oauth/callback',
};
// The deployed API (production-deployment.ts). Laptops share its database
// (D7), so only it may write Gram's row.
const DEPLOYED = {
  NODE_ENV: 'production',
  SELF_HOSTED: 'true',
  AUTH_COOKIE_DOMAIN: '.comp.revola.ai',
};

// At boot the API writes Gram's oauthApplication row from GRAM_OAUTH_*
// through better-auth's adapter (end to end: gram-mcp-oauth-flow.spec.ts).
describe('GramMcpClientSync', () => {
  const savedEnv = { ...process.env };
  let logged: string[];

  beforeEach(() => {
    jest.resetAllMocks();
    Object.assign(process.env, GRAM, DEPLOYED);
    logged = [];
    for (const level of ['log', 'error', 'warn'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });
    }
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  it('is a provider of AuthModule, so it runs at every boot', () => {
    const providers: unknown[] =
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuthModule) ?? [];
    expect(providers).toContain(GramMcpClientSync);
  });

  it('creates the row through better-auth adapter at boot', async () => {
    mockAdapter.findOne.mockResolvedValue(null);
    await new GramMcpClientSync().onApplicationBootstrap();
    expect(mockAdapter.create).toHaveBeenCalledWith({
      model: 'oauthApplication',
      data: expect.objectContaining({
        clientId: GRAM.GRAM_OAUTH_CLIENT_ID,
        clientSecret: GRAM.GRAM_OAUTH_CLIENT_SECRET,
        redirectUrls: GRAM.GRAM_OAUTH_REDIRECT_URI,
        type: 'web',
        disabled: false,
      }),
    });
    expect(logged.join('\n')).not.toContain(GRAM.GRAM_OAUTH_CLIENT_SECRET);
  });

  it('does not touch better-auth or log anything without GRAM_OAUTH_*', async () => {
    delete process.env.GRAM_OAUTH_CLIENT_ID;
    await new GramMcpClientSync().onApplicationBootstrap();
    expect(mockContextRead).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it.each([
    ['a laptop', { NODE_ENV: 'development', AUTH_COOKIE_DOMAIN: '' }],
    ['the production image run locally', { AUTH_COOKIE_DOMAIN: '' }],
  ])(
    'skips the sync on %s, saying so, without touching better-auth',
    async (_name, env) => {
      Object.assign(process.env, env);
      await new GramMcpClientSync().onApplicationBootstrap();
      expect(mockContextRead).not.toHaveBeenCalled();
      expect(mockAdapter.findOne).not.toHaveBeenCalled();
      expect(logged).toEqual([
        'Skipped the Gram MCP OAuth client sync: only the production deployment (NODE_ENV=production, SELF_HOSTED=true, AUTH_COOKIE_DOMAIN set) writes its row',
      ]);
    },
  );

  it('logs a failure by name and code only, and lets the API boot', async () => {
    mockAdapter.findOne.mockRejectedValue(
      Object.assign(
        new Error(`insert failed for ${GRAM.GRAM_OAUTH_CLIENT_SECRET}`),
        { name: 'PrismaClientKnownRequestError', code: 'P1001' },
      ),
    );
    await expect(
      new GramMcpClientSync().onApplicationBootstrap(),
    ).resolves.toBeUndefined();
    expect(logged).toEqual([
      'Could not register the Gram MCP OAuth client: PrismaClientKnownRequestError P1001',
    ]);
  });
});

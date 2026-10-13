import { Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';

const mockAdapter = {
  findOne: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
};
jest.mock('./auth.server', () => ({
  auth: { $context: Promise.resolve({ adapter: mockAdapter }) },
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

// At boot the API writes Gram's oauthApplication row from GRAM_OAUTH_*
// through better-auth's adapter (end to end: gram-mcp-oauth-flow.spec.ts).
describe('GramMcpClientSync', () => {
  const savedEnv = { ...process.env };
  let logged: string[];

  beforeEach(() => {
    jest.resetAllMocks();
    Object.assign(process.env, GRAM);
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
    process.env = savedEnv;
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

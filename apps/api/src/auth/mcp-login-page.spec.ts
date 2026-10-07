import { mcpLoginPage } from './mcp-login-page';

const ENV_KEYS = ['MCP_OAUTH_LOGIN_PAGE', 'NEXT_PUBLIC_APP_URL'] as const;

describe('mcpLoginPage', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let warn: jest.SpyInstance;

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses MCP_OAUTH_LOGIN_PAGE when set', () => {
    process.env.MCP_OAUTH_LOGIN_PAGE = 'https://app.comp.revola.ai/sign-in';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.comp.revola.ai';
    expect(mcpLoginPage()).toBe('https://app.comp.revola.ai/sign-in');
  });

  it("uses the app's sign-in page on this deployment", () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.comp.revola.ai/';
    expect(mcpLoginPage()).toBe('https://app.comp.revola.ai/auth');
  });

  it('never sends users to an upstream host when the app URL is unset', () => {
    // Relative: better-auth redirects to /auth on this API, which fails closed.
    expect(mcpLoginPage()).toBe('/auth');
  });
});

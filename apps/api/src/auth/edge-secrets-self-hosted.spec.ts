import { assertEdgeSecrets } from './edge-secrets';

// The self-hosted production deployment (AUTH_COOKIE_DOMAIN set) must also run
// with SELF_HOSTED=true: without it the origin policy trusts Comp AI's own
// domains (*.trycomp.ai, trust-portal custom domains) for CORS and redirects.
// And a self-hosted production API with no trusted origin at all would refuse
// every browser, so it refuses to boot instead.
const selfHosted = {
  NODE_ENV: 'production',
  SELF_HOSTED: 'true',
  AUTH_COOKIE_DOMAIN: '.comp.revola.ai',
  BASE_URL: 'https://api.comp.revola.ai',
  NEXT_PUBLIC_APP_URL: 'https://app.comp.revola.ai',
  NEXT_PUBLIC_PORTAL_URL: 'https://portal.comp.revola.ai',
  COMP_ORIGIN_AUTH: 'Ab3'.repeat(21) + 'Z',
  COMP_FORWARDED_IP_TOKEN: 'f'.repeat(32),
};

function messageOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('assertEdgeSecrets: self-hosted origin configuration', () => {
  it('accepts the self-hosted production deployment', () => {
    expect(() => assertEdgeSecrets({ env: selfHosted })).not.toThrow();
  });

  it.each([
    ['unset', undefined],
    ['"false"', 'false'],
    ['"1"', '1'],
    ['"TRUE"', 'TRUE'],
  ])(
    'refuses AUTH_COOKIE_DOMAIN in production with SELF_HOSTED %s',
    (_case, value) => {
      const message = messageOf(() =>
        assertEdgeSecrets({ env: { ...selfHosted, SELF_HOSTED: value } }),
      );
      expect(message).toContain('SELF_HOSTED');
      expect(message).toContain('AUTH_COOKIE_DOMAIN');
      expect(message).not.toContain('.comp.revola.ai');
    },
  );

  it('refuses a self-hosted production API that would trust no origin', () => {
    const env = {
      NODE_ENV: 'production',
      SELF_HOSTED: 'true',
      AUTH_TRUSTED_ORIGINS: ' , ',
    };
    const message = messageOf(() => assertEdgeSecrets({ env }));
    expect(message).toContain('AUTH_TRUSTED_ORIGINS');
    expect(message).toContain('AUTH_COOKIE_DOMAIN');
    expect(message).toContain('SELF_HOSTED');
  });

  it('accepts a self-hosted production API trusting explicit origins only', () => {
    const env = {
      NODE_ENV: 'production',
      SELF_HOSTED: 'true',
      AUTH_TRUSTED_ORIGINS: 'https://app.example.com',
    };
    expect(() => assertEdgeSecrets({ env })).not.toThrow();
  });

  it('leaves development and the cloud deployment alone', () => {
    expect(() =>
      assertEdgeSecrets({
        env: { ...selfHosted, SELF_HOSTED: undefined, NODE_ENV: 'development' },
      }),
    ).not.toThrow();
    expect(() =>
      assertEdgeSecrets({
        env: { NODE_ENV: 'development', SELF_HOSTED: 'true' },
      }),
    ).not.toThrow();
    expect(() =>
      assertEdgeSecrets({ env: { NODE_ENV: 'production' } }),
    ).not.toThrow();
  });
});

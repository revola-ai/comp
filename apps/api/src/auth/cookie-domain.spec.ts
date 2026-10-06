import { getCookieDomain, getCookieDomainOrigins } from './cookie-domain';

const REVOLA_URLS = {
  BASE_URL: 'https://api.comp.revola.ai',
  NEXT_PUBLIC_APP_URL: 'https://app.comp.revola.ai',
  NEXT_PUBLIC_PORTAL_URL: 'https://portal.comp.revola.ai',
};

const STAGING_URLS = {
  BASE_URL: 'https://api.staging.trycomp.ai',
  NEXT_PUBLIC_APP_URL: 'https://app.staging.trycomp.ai',
  NEXT_PUBLIC_PORTAL_URL: 'https://portal.staging.trycomp.ai',
};

function without(
  key: keyof typeof REVOLA_URLS,
): Partial<Record<keyof typeof REVOLA_URLS, string>> {
  const env: Partial<Record<keyof typeof REVOLA_URLS, string>> = {
    ...REVOLA_URLS,
  };
  delete env[key];
  return env;
}

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('threw a non-Error value');
  }
  throw new Error('expected the call to throw');
}

describe('getCookieDomain', () => {
  describe('with AUTH_COOKIE_DOMAIN set', () => {
    it('returns the configured domain when it covers the api, app and portal hosts', () => {
      expect(
        getCookieDomain({
          env: { ...REVOLA_URLS, AUTH_COOKIE_DOMAIN: '.comp.revola.ai' },
        }),
      ).toBe('.comp.revola.ai');
    });

    it('wins over the built-in staging rule', () => {
      expect(
        getCookieDomain({
          env: {
            ...STAGING_URLS,
            AUTH_COOKIE_DOMAIN: '.trycomp.ai',
            AUTH_COOKIE_DOMAIN_ALLOW_BROAD: '1',
          },
        }),
      ).toBe('.trycomp.ai');
    });

    it('normalizes case and surrounding whitespace', () => {
      expect(
        getCookieDomain({
          env: { ...REVOLA_URLS, AUTH_COOKIE_DOMAIN: '  .Comp.Revola.AI ' },
        }),
      ).toBe('.comp.revola.ai');
    });

    it('rejects a domain without a leading dot', () => {
      expect(() =>
        getCookieDomain({
          env: { ...REVOLA_URLS, AUTH_COOKIE_DOMAIN: 'comp.revola.ai' },
        }),
      ).toThrow(/must start with a dot/);
    });

    it('rejects a domain that does not cover the app host', () => {
      expect(() =>
        getCookieDomain({
          env: { ...REVOLA_URLS, AUTH_COOKIE_DOMAIN: '.api.comp.revola.ai' },
        }),
      ).toThrow(/NEXT_PUBLIC_APP_URL/);
    });

    it('rejects a domain that does not cover the portal host', () => {
      expect(() =>
        getCookieDomain({
          env: {
            ...REVOLA_URLS,
            NEXT_PUBLIC_PORTAL_URL: 'https://portal.revola.ai',
            AUTH_COOKIE_DOMAIN: '.comp.revola.ai',
          },
        }),
      ).toThrow(/NEXT_PUBLIC_PORTAL_URL/);
    });

    it('does not treat a lookalike host as covered', () => {
      expect(() =>
        getCookieDomain({
          env: {
            ...REVOLA_URLS,
            NEXT_PUBLIC_APP_URL: 'https://app.evilcomp.revola.ai',
            AUTH_COOKIE_DOMAIN: '.comp.revola.ai',
          },
        }),
      ).toThrow(/does not cover/);
    });

    it('covers a host equal to the domain without its leading dot', () => {
      expect(
        getCookieDomain({
          env: {
            ...REVOLA_URLS,
            NEXT_PUBLIC_APP_URL: 'https://comp.revola.ai',
            AUTH_COOKIE_DOMAIN: '.comp.revola.ai',
          },
        }),
      ).toBe('.comp.revola.ai');
    });

    it('rejects a domain with fewer than three labels', () => {
      expect(() =>
        getCookieDomain({
          env: {
            BASE_URL: 'https://api.revola.ai',
            NEXT_PUBLIC_APP_URL: 'https://app.revola.ai',
            NEXT_PUBLIC_PORTAL_URL: 'https://portal.revola.ai',
            AUTH_COOKIE_DOMAIN: '.revola.ai',
          },
        }),
      ).toThrow(/too broad/);
      expect(() =>
        getCookieDomain({
          env: { ...STAGING_URLS, AUTH_COOKIE_DOMAIN: '.trycomp.ai' },
        }),
      ).toThrow(/too broad/);
    });

    it('accepts a two-label domain when AUTH_COOKIE_DOMAIN_ALLOW_BROAD=1', () => {
      expect(
        getCookieDomain({
          env: {
            ...REVOLA_URLS,
            AUTH_COOKIE_DOMAIN: '.revola.ai',
            AUTH_COOKIE_DOMAIN_ALLOW_BROAD: '1',
          },
        }),
      ).toBe('.revola.ai');
    });

    it('rejects a malformed domain', () => {
      for (const value of [
        '.comp..revola.ai',
        '.comp.revola.ai/',
        '.',
        '.*.revola.ai',
      ]) {
        expect(() =>
          getCookieDomain({
            env: { ...REVOLA_URLS, AUTH_COOKIE_DOMAIN: value },
          }),
        ).toThrow(/AUTH_COOKIE_DOMAIN/);
      }
    });

    it('rejects the setting when BASE_URL is missing', () => {
      const rest = without('BASE_URL');
      expect(() =>
        getCookieDomain({
          env: { ...rest, AUTH_COOKIE_DOMAIN: '.comp.revola.ai' },
        }),
      ).toThrow(/BASE_URL/);
    });

    it('rejects the setting when BASE_URL is unparseable', () => {
      expect(() =>
        getCookieDomain({
          env: {
            ...REVOLA_URLS,
            BASE_URL: 'not a url',
            AUTH_COOKIE_DOMAIN: '.comp.revola.ai',
          },
        }),
      ).toThrow(/BASE_URL/);
    });

    it('rejects the setting when the app or portal URL is missing', () => {
      const noApp = without('NEXT_PUBLIC_APP_URL');
      expect(() =>
        getCookieDomain({
          env: { ...noApp, AUTH_COOKIE_DOMAIN: '.comp.revola.ai' },
        }),
      ).toThrow(/NEXT_PUBLIC_APP_URL/);
      const noPortal = without('NEXT_PUBLIC_PORTAL_URL');
      expect(() =>
        getCookieDomain({
          env: { ...noPortal, AUTH_COOKIE_DOMAIN: '.comp.revola.ai' },
        }),
      ).toThrow(/NEXT_PUBLIC_PORTAL_URL/);
    });

    it('names AUTH_COOKIE_DOMAIN and gives an example value in every error', () => {
      const noBase = without('BASE_URL');
      const badEnvs = [
        { ...REVOLA_URLS, AUTH_COOKIE_DOMAIN: 'comp.revola.ai' },
        { ...REVOLA_URLS, AUTH_COOKIE_DOMAIN: '.api.comp.revola.ai' },
        { ...REVOLA_URLS, AUTH_COOKIE_DOMAIN: '.revola.ai' },
        { ...REVOLA_URLS, AUTH_COOKIE_DOMAIN: '.comp..revola.ai' },
        { ...noBase, AUTH_COOKIE_DOMAIN: '.comp.revola.ai' },
        {
          ...REVOLA_URLS,
          BASE_URL: '::',
          AUTH_COOKIE_DOMAIN: '.comp.revola.ai',
        },
      ];
      for (const env of badEnvs) {
        const error = captureError(() => getCookieDomain({ env }));
        expect(error.message).toContain('AUTH_COOKIE_DOMAIN');
        expect(error.message).toContain('AUTH_COOKIE_DOMAIN=.comp.revola.ai');
      }
    });
  });

  describe('with AUTH_COOKIE_DOMAIN unset', () => {
    it('keeps the production trycomp.ai rule', () => {
      expect(
        getCookieDomain({ env: { BASE_URL: 'https://api.trycomp.ai' } }),
      ).toBe('.trycomp.ai');
    });

    it('keeps the staging rule', () => {
      expect(
        getCookieDomain({
          env: { BASE_URL: 'https://api.staging.trycomp.ai' },
        }),
      ).toBe('.staging.trycomp.ai');
    });

    it('returns undefined for any other host', () => {
      expect(
        getCookieDomain({ env: { BASE_URL: 'http://localhost:3333' } }),
      ).toBeUndefined();
      expect(getCookieDomain({ env: {} })).toBeUndefined();
    });

    it('treats an empty value as unset', () => {
      expect(
        getCookieDomain({
          env: { BASE_URL: 'https://api.trycomp.ai', AUTH_COOKIE_DOMAIN: '  ' },
        }),
      ).toBe('.trycomp.ai');
    });

    it('has no .trycomp.ai fallback when SELF_HOSTED=true', () => {
      expect(
        getCookieDomain({
          env: { BASE_URL: 'https://api.trycomp.ai', SELF_HOSTED: 'true' },
        }),
      ).toBeUndefined();
      expect(
        getCookieDomain({
          env: {
            BASE_URL: 'https://api.staging.trycomp.ai',
            SELF_HOSTED: 'true',
          },
        }),
      ).toBeUndefined();
    });
  });
});

describe('getCookieDomainOrigins', () => {
  it('returns the api, app and portal origins covered by AUTH_COOKIE_DOMAIN', () => {
    expect(
      getCookieDomainOrigins({
        env: { ...REVOLA_URLS, AUTH_COOKIE_DOMAIN: '.comp.revola.ai' },
      }),
    ).toEqual([
      'https://api.comp.revola.ai',
      'https://app.comp.revola.ai',
      'https://portal.comp.revola.ai',
    ]);
  });

  it('returns nothing when AUTH_COOKIE_DOMAIN is unset, even on trycomp.ai', () => {
    expect(
      getCookieDomainOrigins({ env: { BASE_URL: 'https://api.trycomp.ai' } }),
    ).toEqual([]);
    expect(getCookieDomainOrigins({ env: {} })).toEqual([]);
  });
});

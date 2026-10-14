import { getCookieDomainOrigins } from './cookie-domain';

const REVOLA_URLS = {
  BASE_URL: 'https://api.comp.revola.ai',
  NEXT_PUBLIC_APP_URL: 'https://app.comp.revola.ai',
  NEXT_PUBLIC_PORTAL_URL: 'https://portal.comp.revola.ai',
};

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

  it('validates a configuration once and reuses the result on every request', () => {
    const env = { ...REVOLA_URLS, AUTH_COOKIE_DOMAIN: '.comp.revola.ai' };
    const first = getCookieDomainOrigins({ env });
    const second = getCookieDomainOrigins({ env: { ...env } });
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('recomputes when the configuration changes', () => {
    const env = { ...REVOLA_URLS, AUTH_COOKIE_DOMAIN: '.comp.revola.ai' };
    const before = getCookieDomainOrigins({ env });
    const after = getCookieDomainOrigins({
      env: { ...env, NEXT_PUBLIC_PORTAL_URL: 'https://people.comp.revola.ai' },
    });
    expect(after).not.toBe(before);
    expect(after).toContain('https://people.comp.revola.ai');
    expect(() =>
      getCookieDomainOrigins({
        env: { ...env, AUTH_COOKIE_DOMAIN: 'comp.revola.ai' },
      }),
    ).toThrow('AUTH_COOKIE_DOMAIN');
  });
});

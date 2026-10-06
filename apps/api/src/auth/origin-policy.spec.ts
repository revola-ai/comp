import {
  getBetterAuthTrustedOrigins,
  getTrustedOrigins,
  isStaticTrustedOrigin,
} from './origin-policy';

describe('isStaticTrustedOrigin', () => {
  const originalTrustedOrigins = process.env.AUTH_TRUSTED_ORIGINS;

  beforeEach(() => {
    delete process.env.AUTH_TRUSTED_ORIGINS;
  });

  afterAll(() => {
    if (originalTrustedOrigins === undefined) {
      delete process.env.AUTH_TRUSTED_ORIGINS;
      return;
    }
    process.env.AUTH_TRUSTED_ORIGINS = originalTrustedOrigins;
  });

  it('trusts HTTPS subdomains of the wildcard domains', () => {
    expect(isStaticTrustedOrigin('https://anything.trycomp.ai')).toBe(true);
    expect(isStaticTrustedOrigin('https://anything.staging.trycomp.ai')).toBe(
      true,
    );
    expect(isStaticTrustedOrigin('https://anything.trust.inc')).toBe(true);
    expect(isStaticTrustedOrigin('https://trust.inc')).toBe(true);
  });

  it('does not extend the wildcard match to plain HTTP', () => {
    expect(isStaticTrustedOrigin('http://anything.trycomp.ai')).toBe(false);
    expect(isStaticTrustedOrigin('http://anything.staging.trycomp.ai')).toBe(
      false,
    );
    expect(isStaticTrustedOrigin('http://anything.trust.inc')).toBe(false);
    expect(isStaticTrustedOrigin('http://trust.inc')).toBe(false);
  });

  it('still trusts the explicitly listed http localhost origins', () => {
    expect(isStaticTrustedOrigin('http://localhost:3000')).toBe(true);
    expect(isStaticTrustedOrigin('http://localhost:3333')).toBe(true);
  });

  it('honours an explicit AUTH_TRUSTED_ORIGINS list', () => {
    process.env.AUTH_TRUSTED_ORIGINS = 'http://localhost:4000';
    expect(isStaticTrustedOrigin('http://localhost:4000')).toBe(true);
    expect(isStaticTrustedOrigin('http://localhost:3000')).toBe(false);
  });

  it('rejects unrelated and malformed origins', () => {
    expect(isStaticTrustedOrigin('https://trycomp.ai.untrusted.example')).toBe(
      false,
    );
    expect(isStaticTrustedOrigin('https://nottrust.inc')).toBe(false);
    expect(isStaticTrustedOrigin('not-a-url')).toBe(false);
    expect(isStaticTrustedOrigin('')).toBe(false);
  });
});

describe('origin policy when SELF_HOSTED=true', () => {
  const KEYS = [
    'SELF_HOSTED',
    'NODE_ENV',
    'AUTH_TRUSTED_ORIGINS',
    'AUTH_COOKIE_DOMAIN',
    'BASE_URL',
    'NEXT_PUBLIC_APP_URL',
    'NEXT_PUBLIC_PORTAL_URL',
    'COMP_EXTENSION_TRUSTED_ORIGINS',
  ] as const;
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    for (const key of KEYS) delete process.env[key];
    process.env.SELF_HOSTED = 'true';
    process.env.NODE_ENV = 'production';
    process.env.BASE_URL = 'https://api.comp.revola.ai';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.comp.revola.ai';
    process.env.NEXT_PUBLIC_PORTAL_URL = 'https://portal.comp.revola.ai';
    process.env.AUTH_COOKIE_DOMAIN = '.comp.revola.ai';
  });

  afterAll(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('trusts only AUTH_TRUSTED_ORIGINS plus the AUTH_COOKIE_DOMAIN hosts', () => {
    process.env.AUTH_TRUSTED_ORIGINS = 'https://tools.revola.ai';
    expect(getTrustedOrigins()).toEqual([
      'https://tools.revola.ai',
      'https://api.comp.revola.ai',
      'https://app.comp.revola.ai',
      'https://portal.comp.revola.ai',
    ]);
    expect(getBetterAuthTrustedOrigins()).toEqual(getTrustedOrigins());
  });

  it('does not list the same origin twice', () => {
    process.env.AUTH_TRUSTED_ORIGINS = 'https://app.comp.revola.ai';
    expect(getTrustedOrigins()).toEqual([
      'https://app.comp.revola.ai',
      'https://api.comp.revola.ai',
      'https://portal.comp.revola.ai',
    ]);
  });

  it('rejects trycomp.ai and trust.inc origins', () => {
    for (const origin of [
      'https://x.trycomp.ai',
      'https://app.trycomp.ai',
      'https://anything.staging.trycomp.ai',
      'https://x.trust.inc',
      'https://trust.inc',
    ]) {
      expect(isStaticTrustedOrigin(origin)).toBe(false);
    }
    expect(getTrustedOrigins()).not.toContain('https://app.trycomp.ai');
  });

  it('accepts exactly the configured hosts and no other subdomain', () => {
    expect(isStaticTrustedOrigin('https://app.comp.revola.ai')).toBe(true);
    expect(isStaticTrustedOrigin('https://portal.comp.revola.ai')).toBe(true);
    expect(isStaticTrustedOrigin('https://api.comp.revola.ai')).toBe(true);
    expect(isStaticTrustedOrigin('https://other.comp.revola.ai')).toBe(false);
    expect(isStaticTrustedOrigin('http://app.comp.revola.ai')).toBe(false);
  });

  it('does not trust localhost in production', () => {
    expect(isStaticTrustedOrigin('http://localhost:3000')).toBe(false);
  });

  it('keeps the localhost defaults for local development when nothing is configured', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.AUTH_COOKIE_DOMAIN;
    expect(isStaticTrustedOrigin('http://localhost:3000')).toBe(true);
    expect(isStaticTrustedOrigin('http://localhost:3333')).toBe(true);
    expect(isStaticTrustedOrigin('https://app.trycomp.ai')).toBe(false);
    expect(isStaticTrustedOrigin('https://x.trycomp.ai')).toBe(false);
  });

  it('still adds browser-extension origins to the better-auth list', () => {
    process.env.COMP_EXTENSION_TRUSTED_ORIGINS = 'chrome-extension://abc';
    expect(getBetterAuthTrustedOrigins()).toContain('chrome-extension://abc');
  });
});

describe('origin policy without SELF_HOSTED', () => {
  const saved = {
    SELF_HOSTED: process.env.SELF_HOSTED,
    AUTH_TRUSTED_ORIGINS: process.env.AUTH_TRUSTED_ORIGINS,
  };

  beforeEach(() => {
    delete process.env.SELF_HOSTED;
    delete process.env.AUTH_TRUSTED_ORIGINS;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('keeps the built-in trycomp.ai defaults and wildcard', () => {
    expect(getTrustedOrigins()).toContain('https://app.trycomp.ai');
    expect(isStaticTrustedOrigin('https://x.trycomp.ai')).toBe(true);
    expect(isStaticTrustedOrigin('https://x.trust.inc')).toBe(true);
  });
});

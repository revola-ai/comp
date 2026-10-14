import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'unsubscribe-test-secret';
const EMAIL = 'person@revola.ai';

/** A fresh copy of the module, so its once-per-process warning starts unsent. */
async function freshModule() {
  vi.resetModules();
  return import('./unsubscribe');
}

describe('app unsubscribe links with a configured secret', () => {
  beforeEach(() => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    vi.stubEnv('AUTH_SECRET', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('points at the app host, never the API host in BETTER_AUTH_URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_BETTER_AUTH_URL', 'https://api.comp.revola.ai');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai');
    const { getUnsubscribeUrl } = await freshModule();

    const url = new URL(getUnsubscribeUrl(EMAIL) ?? '');

    expect(url.origin).toBe('https://app.comp.revola.ai');
    expect(url.pathname).toBe('/unsubscribe/preferences');
    expect(url.searchParams.get('email')).toBe(EMAIL);
    expect(url.searchParams.get('token')).toBe(
      createHmac('sha256', SECRET).update(EMAIL).digest('base64url'),
    );
  });

  it('normalizes a trailing slash on NEXT_PUBLIC_APP_URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai/');
    const { getUnsubscribeUrl } = await freshModule();
    expect(getUnsubscribeUrl(EMAIL)).toMatch(
      /^https:\/\/app\.comp\.revola\.ai\/unsubscribe\/preferences\?/,
    );
  });

  it('builds no link without NEXT_PUBLIC_APP_URL, never an upstream host, warning once', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { getUnsubscribeUrl } = await freshModule();
    expect(getUnsubscribeUrl(EMAIL)).toBeUndefined();
    expect(getUnsubscribeUrl('other@revola.ai')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('NEXT_PUBLIC_APP_URL');
    warn.mockRestore();
  });

  it('verifies its own token and rejects a forged or foreign one', async () => {
    const { verifyUnsubscribeToken } = await freshModule();
    const token = createHmac('sha256', SECRET).update(EMAIL).digest('base64url');
    const forged = createHmac('sha256', 'fallback-secret').update(EMAIL).digest('base64url');
    expect(verifyUnsubscribeToken({ email: EMAIL, token })).toBe(true);
    expect(verifyUnsubscribeToken({ email: EMAIL, token: forged })).toBe(false);
    expect(verifyUnsubscribeToken({ email: 'other@revola.ai', token })).toBe(false);
    expect(verifyUnsubscribeToken({ email: EMAIL, token: '' })).toBe(false);
  });

  it('reads the secret on every use, so AUTH_SECRET works as the fallback', async () => {
    const { isUnsubscribeConfigured, verifyUnsubscribeToken } = await freshModule();
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    const token = createHmac('sha256', 'auth-secret').update(EMAIL).digest('base64url');
    expect(isUnsubscribeConfigured()).toBe(true);
    expect(verifyUnsubscribeToken({ email: EMAIL, token })).toBe(true);
  });
});

describe('app unsubscribe links without a configured secret', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    vi.stubEnv('AUTH_SECRET', '');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it('builds no link, warning once per process', async () => {
    const { getUnsubscribeUrl, isUnsubscribeConfigured } = await freshModule();
    expect(isUnsubscribeConfigured()).toBe(false);
    expect(getUnsubscribeUrl(EMAIL)).toBeUndefined();
    expect(getUnsubscribeUrl('other@revola.ai')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('UNSUBSCRIBE_SECRET');
  });

  it('refuses to verify with a named error instead of a public default', async () => {
    const { UnsubscribeSecretMissingError, verifyUnsubscribeToken } = await freshModule();
    expect(() => verifyUnsubscribeToken({ email: EMAIL, token: 'x' })).toThrow(
      UnsubscribeSecretMissingError,
    );
  });
});

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateUnsubscribeToken,
  getUnsubscribeUrl,
  UnsubscribeSecretMissingError,
  verifyUnsubscribeToken,
} from './unsubscribe';

const SECRET = 'unsubscribe-test-secret';
const EMAIL = 'person@revola.ai';

describe('unsubscribe tokens', () => {
  beforeEach(() => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    vi.stubEnv('AUTH_SECRET', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('signs with UNSUBSCRIBE_SECRET', () => {
    const expected = createHmac('sha256', SECRET).update(EMAIL).digest('base64url');
    expect(generateUnsubscribeToken(EMAIL)).toBe(expected);
  });

  it('falls back to AUTH_SECRET, the value the app verifies with', () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    const expected = createHmac('sha256', 'auth-secret').update(EMAIL).digest('base64url');
    expect(generateUnsubscribeToken(EMAIL)).toBe(expected);
  });

  it('throws a named error instead of signing with a public fallback', () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    vi.stubEnv('AUTH_SECRET', '');
    expect(() => generateUnsubscribeToken(EMAIL)).toThrow(UnsubscribeSecretMissingError);
    expect(() => verifyUnsubscribeToken({ email: EMAIL, token: 'x' })).toThrow(
      UnsubscribeSecretMissingError,
    );
    expect(() => getUnsubscribeUrl(EMAIL)).toThrow(UnsubscribeSecretMissingError);
  });

  it('never signs with the old fallback-secret', () => {
    const forged = createHmac('sha256', 'fallback-secret').update(EMAIL).digest('base64url');
    expect(verifyUnsubscribeToken({ email: EMAIL, token: forged })).toBe(false);
  });

  it('verifies its own token and rejects another', () => {
    const token = generateUnsubscribeToken(EMAIL);
    expect(verifyUnsubscribeToken({ email: EMAIL, token })).toBe(true);
    expect(verifyUnsubscribeToken({ email: 'other@revola.ai', token })).toBe(false);
    expect(verifyUnsubscribeToken({ email: EMAIL, token: `${token}x` })).toBe(false);
    expect(verifyUnsubscribeToken({ email: EMAIL, token: '' })).toBe(false);
  });
});

describe('getUnsubscribeUrl', () => {
  beforeEach(() => vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it('points at the app host, never the API host in NEXT_PUBLIC_BETTER_AUTH_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_BETTER_AUTH_URL', 'https://api.comp.revola.ai');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai/');
    const url = new URL(getUnsubscribeUrl(EMAIL));
    expect(url.origin).toBe('https://app.comp.revola.ai');
    expect(url.pathname).toBe('/unsubscribe/preferences');
    expect(url.searchParams.get('email')).toBe(EMAIL);
    expect(url.searchParams.get('token')).toBe(generateUnsubscribeToken(EMAIL));
  });
});

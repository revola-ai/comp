import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'unsubscribe-test-secret';
const EMAIL = 'person@revola.ai';

/** A fresh copy of the module, so its once-per-process warning starts unsent. */
async function freshModule() {
  vi.resetModules();
  return import('./unsubscribe.js');
}

describe('unsubscribe links without a configured secret', () => {
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

  it('reports that unsubscribe is not configured', async () => {
    const { isUnsubscribeConfigured } = await freshModule();
    expect(isUnsubscribeConfigured()).toBe(false);
  });

  it('builds no token and no link instead of throwing', async () => {
    const { getUnsubscribeToken, getUnsubscribeUrl } = await freshModule();
    expect(getUnsubscribeToken(EMAIL)).toBeUndefined();
    expect(getUnsubscribeUrl(EMAIL)).toBeUndefined();
  });

  it('warns once per process, naming the variable', async () => {
    const { getUnsubscribeToken, getUnsubscribeUrl } = await freshModule();
    getUnsubscribeToken(EMAIL);
    getUnsubscribeUrl(EMAIL);
    getUnsubscribeUrl('other@revola.ai');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('UNSUBSCRIBE_SECRET');
  });
});

describe('unsubscribe links without NEXT_PUBLIC_APP_URL', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it('builds no link instead of pointing at an upstream host, warning once', async () => {
    const { getUnsubscribeToken, getUnsubscribeUrl } = await freshModule();
    expect(getUnsubscribeUrl(EMAIL)).toBeUndefined();
    expect(getUnsubscribeUrl('other@revola.ai')).toBeUndefined();
    // The token itself does not depend on a host; the API header builder uses it.
    expect(getUnsubscribeToken(EMAIL)).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('NEXT_PUBLIC_APP_URL');
  });
});

describe('unsubscribe links with a configured secret', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai/');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it('signs the token and the link without warning', async () => {
    const { getUnsubscribeToken, getUnsubscribeUrl, isUnsubscribeConfigured } = await freshModule();
    const expected = createHmac('sha256', SECRET).update(EMAIL).digest('base64url');
    expect(isUnsubscribeConfigured()).toBe(true);
    expect(getUnsubscribeToken(EMAIL)).toBe(expected);
    expect(getUnsubscribeUrl(EMAIL)).toBe(
      `https://app.comp.revola.ai/unsubscribe/preferences?email=person%40revola.ai&token=${expected}`,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('never puts the secret in the warning after it is removed', async () => {
    const { getUnsubscribeUrl } = await freshModule();
    getUnsubscribeUrl(EMAIL);
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    vi.stubEnv('AUTH_SECRET', '');
    expect(getUnsubscribeUrl(EMAIL)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(SECRET);
  });
});

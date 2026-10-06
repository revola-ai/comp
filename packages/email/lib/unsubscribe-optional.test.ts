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

describe('unsubscribe links with a configured secret', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
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
    expect(getUnsubscribeUrl(EMAIL)).toContain(`token=${expected}`);
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

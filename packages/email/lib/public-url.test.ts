import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh copy of the module, so its once-per-process warnings start unsent. */
async function freshModule() {
  vi.resetModules();
  return import('./public-url.js');
}

describe('publicBaseUrl', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.stubEnv('BETTER_AUTH_URL', '');
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it('returns the first set variable, trimmed and without a trailing slash', async () => {
    vi.stubEnv('BETTER_AUTH_URL', '  https://api.comp.revola.ai//  ');
    const { publicBaseUrl } = await freshModule();
    expect(publicBaseUrl(['NEXT_PUBLIC_APP_URL', 'BETTER_AUTH_URL'])).toBe(
      'https://api.comp.revola.ai',
    );
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai/');
    expect(publicBaseUrl(['NEXT_PUBLIC_APP_URL', 'BETTER_AUTH_URL'])).toBe(
      'https://app.comp.revola.ai',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns undefined, never an upstream host, when nothing is set', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '   ');
    const { publicBaseUrl } = await freshModule();
    expect(publicBaseUrl(['NEXT_PUBLIC_APP_URL', 'BETTER_AUTH_URL'])).toBeUndefined();
  });

  it('warns once per process for each variable list, naming the variables', async () => {
    const { publicBaseUrl } = await freshModule();
    publicBaseUrl(['NEXT_PUBLIC_API_URL']);
    publicBaseUrl(['NEXT_PUBLIC_API_URL']);
    publicBaseUrl(['NEXT_PUBLIC_APP_URL', 'BETTER_AUTH_URL']);
    publicBaseUrl(['NEXT_PUBLIC_APP_URL', 'BETTER_AUTH_URL']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('NEXT_PUBLIC_API_URL');
    expect(String(warn.mock.calls[1]?.[0])).toContain('NEXT_PUBLIC_APP_URL');
    expect(String(warn.mock.calls[1]?.[0])).toContain('BETTER_AUTH_URL');
    expect(String(warn.mock.calls.flat())).not.toContain('trycomp.ai');
  });
});

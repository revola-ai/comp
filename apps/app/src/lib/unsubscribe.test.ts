import { afterEach, describe, expect, it, vi } from 'vitest';

// The module reads its signing secret at import time.
vi.hoisted(() => {
  process.env.UNSUBSCRIBE_SECRET = 'unsubscribe-test-secret';
});

import { getUnsubscribeUrl } from './unsubscribe';

describe('getUnsubscribeUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('points at the app host, never the API host in BETTER_AUTH_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_BETTER_AUTH_URL', 'https://api.comp.revola.ai');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai');

    const url = new URL(getUnsubscribeUrl('person@revola.ai'));

    expect(url.origin).toBe('https://app.comp.revola.ai');
    expect(url.pathname).toBe('/unsubscribe/preferences');
    expect(url.searchParams.get('email')).toBe('person@revola.ai');
  });

  it('normalizes a trailing slash on NEXT_PUBLIC_APP_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai/');
    expect(getUnsubscribeUrl('person@revola.ai')).toMatch(
      /^https:\/\/app\.comp\.revola\.ai\/unsubscribe\/preferences\?/,
    );
  });
});

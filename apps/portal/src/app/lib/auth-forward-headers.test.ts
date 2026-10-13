import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuthForwardHeaders } from './auth-forward-headers';

describe('buildAuthForwardHeaders (portal)', () => {
  beforeEach(() => {
    vi.stubEnv('COMP_FORWARDED_IP_TOKEN', 'forwarded-test-token');
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', 'https://portal.comp.revola.ai');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.comp.revola.ai');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('forwards the cookie, the forwarded-IP token and the sanitized client IP only', () => {
    const headers = buildAuthForwardHeaders({
      incoming: new Headers({
        cookie: 'better-auth.session_token=abc',
        'x-forwarded-for': '203.0.113.7, 10.0.0.2',
        'x-comp-origin-auth': 'edge-secret',
        'x-custom': 'nope',
      }),
    });
    expect(headers).toEqual({
      cookie: 'better-auth.session_token=abc',
      'X-Comp-Forwarded-Auth': 'forwarded-test-token',
      'X-Forwarded-For': '203.0.113.7',
      origin: 'https://portal.comp.revola.ai',
    });
  });

  it('keeps the browser Origin when the request has one', () => {
    const headers = buildAuthForwardHeaders({
      incoming: new Headers({ origin: 'https://portal.comp.revola.ai' }),
    });
    expect(headers.origin).toBe('https://portal.comp.revola.ai');
  });

  it('sends only the origin of NEXT_PUBLIC_PORTAL_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', 'https://portal.comp.revola.ai/some/path/');
    expect(buildAuthForwardHeaders({ incoming: new Headers() }).origin).toBe(
      'https://portal.comp.revola.ai',
    );
  });

  it('falls back to the public API URL when NEXT_PUBLIC_PORTAL_URL is unset or invalid', () => {
    for (const value of ['', 'not a url']) {
      vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', value);
      expect(buildAuthForwardHeaders({ incoming: new Headers() }).origin).toBe(
        'https://api.comp.revola.ai',
      );
    }
  });

  it('falls back to the local API when nothing is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', '');
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    expect(buildAuthForwardHeaders({ incoming: new Headers() }).origin).toBe(
      'http://localhost:3333',
    );
  });

  it('never uses the internal Service Connect address as the Origin', () => {
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', '');
    vi.stubEnv('BACKEND_API_URL', 'http://comp-api.comp.internal:3333');
    expect(buildAuthForwardHeaders({ incoming: new Headers() }).origin).toBe(
      'https://api.comp.revola.ai',
    );
  });
});

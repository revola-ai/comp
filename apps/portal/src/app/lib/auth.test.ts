import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from './auth';

const fetchMock = vi.fn();

function sentHeaders(): Headers {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

function incoming(): Headers {
  return new Headers({
    cookie: 'better-auth.session_token=abc',
    'x-forwarded-for': '203.0.113.7, 10.0.0.2',
    'x-comp-origin-auth': 'edge-secret',
    'x-custom': 'should-not-travel',
    'x-api-key': 'should-not-travel-either',
  });
}

describe('portal auth forwards only a sanitized set of headers', () => {
  beforeEach(() => {
    vi.stubEnv('BACKEND_API_URL', 'http://comp-api.comp.internal:3333');
    vi.stubEnv('INTERNAL_API_TOKEN', 'internal-test-token');
    vi.stubEnv('COMP_FORWARDED_IP_TOKEN', 'forwarded-test-token');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('getSession calls the internal API with cookie, token and client IP only', async () => {
    await auth.api.getSession({ headers: incoming() });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://comp-api.comp.internal:3333/api/auth/get-session',
    );
    const sent = sentHeaders();
    expect(sent.get('cookie')).toBe('better-auth.session_token=abc');
    expect(sent.get('x-comp-forwarded-auth')).toBe('forwarded-test-token');
    expect(sent.get('x-internal-token')).toBeNull();
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.get('x-comp-origin-auth')).toBeNull();
    expect(sent.get('x-custom')).toBeNull();
    expect(sent.get('x-api-key')).toBeNull();
  });

  it('setActiveOrganization forwards the same sanitized set', async () => {
    await auth.api.setActiveOrganization({
      headers: incoming(),
      body: { organizationId: 'org_1' },
    });

    const sent = sentHeaders();
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.get('x-comp-origin-auth')).toBeNull();
    expect(sent.get('x-custom')).toBeNull();
  });
});

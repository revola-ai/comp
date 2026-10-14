import { headers } from 'next/headers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// env.mjs validates required server env vars at import time; the callers under
// test read the API location through the helper, so a stub keeps this hermetic.
vi.mock('@/env.mjs', () => ({ env: {} }));

import { auth } from '@/utils/auth';
import { InvalidApiPathError } from './api-path';
import { serverApi } from './api-server';
import { serverApi as legacyServerApi } from './server-api-client';

const fetchMock = vi.fn();

function incomingRequestHeaders(): Headers {
  return new Headers({
    cookie: 'better-auth.session_token=abc',
    'x-forwarded-for': '203.0.113.7, 10.0.0.2',
    'x-comp-origin-auth': 'edge-secret',
    'x-custom': 'should-not-travel',
  });
}

function sentHeaders(): Headers {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

describe('server-side API callers', () => {
  beforeEach(() => {
    vi.stubEnv('BACKEND_API_URL', 'http://comp-api.comp.internal:3333');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.comp.revola.ai');
    vi.stubEnv('INTERNAL_API_TOKEN', 'internal-test-token');
    vi.stubEnv('COMP_FORWARDED_IP_TOKEN', 'forwarded-test-token');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    vi.mocked(headers).mockResolvedValue(incomingRequestHeaders() as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('serverApi (lib/api-server) calls the internal URL with both headers', async () => {
    await serverApi.get('/v1/people');

    expect(fetchMock.mock.calls[0][0]).toBe('http://comp-api.comp.internal:3333/v1/people');
    const sent = sentHeaders();
    expect(sent.get('x-comp-forwarded-auth')).toBe('forwarded-test-token');
    expect(sent.get('x-internal-token')).toBeNull();
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.get('cookie')).toBe('better-auth.session_token=abc');
    expect(sent.get('x-comp-origin-auth')).toBeNull();
  });

  it('serverApi (lib/server-api-client) calls the internal URL with both headers', async () => {
    await legacyServerApi.get('/v1/tasks');

    expect(fetchMock.mock.calls[0][0]).toBe('http://comp-api.comp.internal:3333/v1/tasks');
    const sent = sentHeaders();
    expect(sent.get('x-comp-forwarded-auth')).toBe('forwarded-test-token');
    expect(sent.get('x-internal-token')).toBeNull();
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.7');
  });

  it.each([
    [
      'lib/api-server',
      () => serverApi.get('/v1/vendors/../internal/integration-debug/connections'),
    ],
    ['lib/server-api-client', () => legacyServerApi.post('/v1/vendors/%2e%2e/internal/x', {})],
  ])('serverApi (%s) refuses a dot-segment path before any request', async (_name, run) => {
    await expect(run()).rejects.toThrow(InvalidApiPathError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auth.api.getSession forwards only the cookie, origin and server headers', async () => {
    await auth.api.getSession({ headers: incomingRequestHeaders() });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://comp-api.comp.internal:3333/api/auth/get-session',
    );
    const sent = sentHeaders();
    expect(sent.get('x-comp-forwarded-auth')).toBe('forwarded-test-token');
    expect(sent.get('x-internal-token')).toBeNull();
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.get('cookie')).toBe('better-auth.session_token=abc');
    expect(sent.get('x-comp-origin-auth')).toBeNull();
    expect(sent.get('x-custom')).toBeNull();
  });

  it('auth falls back to the public API origin for CSRF, never the internal address', async () => {
    await auth.api.hasPermission({
      headers: incomingRequestHeaders(),
      body: { permission: { control: ['read'] } },
    });

    expect(sentHeaders().get('origin')).toBe('https://api.comp.revola.ai');
  });

  it('auth keeps the browser origin when the incoming request has one', async () => {
    const incoming = incomingRequestHeaders();
    incoming.set('origin', 'https://app.comp.revola.ai');
    await auth.api.getSession({ headers: incoming });

    expect(sentHeaders().get('origin')).toBe('https://app.comp.revola.ai');
  });
});

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getSessionAlias } from '../auth/get-session/route';
import { proxyToApi } from './proxy';

const fetchMock = vi.fn();

function sentHeaders(): Headers {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

function deviceRequest(): Request {
  return new Request('http://localhost/api/device-agent/status', {
    headers: {
      authorization: 'Bearer device-token',
      'x-forwarded-for': '198.51.100.4, 10.0.0.9',
      'x-comp-origin-auth': 'edge-secret',
    },
  });
}

describe('portal API proxies', () => {
  beforeEach(() => {
    vi.stubEnv('BACKEND_API_URL', 'http://comp-api.comp.internal:3333');
    vi.stubEnv('INTERNAL_API_TOKEN', 'internal-test-token');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('device-agent proxy calls the internal API with the agent auth and server headers', async () => {
    await proxyToApi(deviceRequest(), '/v1/device-agent/status');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://comp-api.comp.internal:3333/v1/device-agent/status',
    );
    const sent = sentHeaders();
    expect(sent.get('authorization')).toBe('Bearer device-token');
    expect(sent.get('x-internal-token')).toBe('internal-test-token');
    expect(sent.get('x-forwarded-for')).toBe('198.51.100.4');
    expect(sent.get('x-comp-origin-auth')).toBeNull();
  });

  it('get-session alias calls the internal API with the server headers', async () => {
    const req = new NextRequest('http://localhost/api/auth/get-session', {
      headers: { cookie: 'session=abc', 'x-forwarded-for': '198.51.100.4' },
    });

    await getSessionAlias(req);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://comp-api.comp.internal:3333/api/auth/get-session',
    );
    const sent = sentHeaders();
    expect(sent.get('cookie')).toBe('session=abc');
    expect(sent.get('x-internal-token')).toBe('internal-test-token');
    expect(sent.get('x-forwarded-for')).toBe('198.51.100.4');
  });
});

import { InvalidApiPathError } from '@/app/lib/api-path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getSessionAlias } from '../auth/get-session/route';
import { proxyToApi } from './proxy';
import { GET as getUpdate, HEAD as headUpdate } from './updates/[filename]/route';

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
    vi.stubEnv('COMP_FORWARDED_IP_TOKEN', 'forwarded-test-token');
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
    expect(sent.get('x-comp-forwarded-auth')).toBe('forwarded-test-token');
    expect(sent.get('x-internal-token')).toBeNull();
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
    expect(sent.get('x-comp-forwarded-auth')).toBe('forwarded-test-token');
    expect(sent.get('x-internal-token')).toBeNull();
    expect(sent.get('x-forwarded-for')).toBe('198.51.100.4');
  });

  it('device-agent proxy refuses a dot-segment path before any request', async () => {
    await expect(
      proxyToApi(deviceRequest(), '/v1/device-agent/updates/../../internal/x'),
    ).rejects.toThrow(InvalidApiPathError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updates route keeps a traversal filename inside /v1/device-agent/updates', async () => {
    const req = new NextRequest('http://localhost/api/device-agent/updates/x');
    await getUpdate(req, { params: Promise.resolve({ filename: '../../internal/x' }) });

    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe(
      '/v1/device-agent/updates/..%2F..%2Finternal%2Fx',
    );
  });

  it.each([
    ['GET', getUpdate],
    ['HEAD', headUpdate],
  ])(
    'updates route answers 400 to a dot-dot filename (%s) without calling the API',
    async (_method, handler) => {
      const req = new NextRequest('http://localhost/api/device-agent/updates/x');
      const res = await handler(req, { params: Promise.resolve({ filename: '..' }) });

      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

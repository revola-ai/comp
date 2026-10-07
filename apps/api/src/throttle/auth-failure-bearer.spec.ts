import type { INestApplication } from '@nestjs/common';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Agent } from 'node:http';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ApiKeyService } from '../auth/api-key.service';
import { HybridAuthGuard } from '../auth/hybrid-auth.guard';

// Bearer tokens reach better-auth's session lookup and the MCP OAuth token
// lookup, both database-backed, so they take an attempt from the verified
// client IP bucket like API keys do. The real HybridAuthGuard runs; the two
// resolvers and the database are mocked.
const mockGetSession = jest.fn();
const mockGetMcpSession = jest.fn();
jest.mock('../auth/auth.server', () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getMcpSession: (...args: unknown[]) => mockGetMcpSession(...args),
    },
  },
}));
jest.mock('@db', () => ({
  db: {
    member: {
      findFirst: () =>
        Promise.resolve({ id: 'mem_1', role: 'admin', department: null }),
      findMany: () =>
        Promise.resolve([
          {
            id: 'mem_1',
            role: 'admin',
            department: null,
            organizationId: 'org_1',
          },
        ]),
    },
    user: {
      findUnique: () =>
        Promise.resolve({ id: 'usr_mcp', email: 'm@example.com', role: null }),
    },
  },
}));
jest.mock('@trycompai/auth', () => ({
  BUILT_IN_ROLE_PERMISSIONS: { admin: { app: ['read'] } },
}));

import { AUTH_FAILURE_LIMIT, AuthFailureLimiter } from './auth-failure-limiter';
import { ThrottleModule } from './throttle.module';

const ORIGIN = 'C'.repeat(64);
const N = AUTH_FAILURE_LIMIT;
const VALID_SESSION_TOKEN = 'valid-session-token';
const VALID_MCP_TOKEN = 'valid-mcp-token';

@Controller({ path: 'probe' })
@UseGuards(HybridAuthGuard)
class ProbeController {
  @Get('private')
  guarded() {
    return { ok: true };
  }
}

function bearerOf(headers: Headers): string | null {
  const value = headers.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}

// The session token better-auth looks up. Its bearer plugin replaces the session
// cookie with an unsigned bearer token (no '.'), so that token takes precedence;
// a signed-looking one whose signature does not verify is ignored and the
// cookie is used.
function sessionTokenOf(headers: Headers): string | null {
  const bearer = bearerOf(headers);
  if (bearer && !bearer.includes('.')) return bearer;
  return headers.get('cookie')?.match(/session_token=([^;]+)/)?.[1] ?? null;
}

const agent = new Agent({ keepAlive: false });

describe('credential attempt limit for bearer tokens (HybridAuthGuard)', () => {
  let app: INestApplication;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.COMP_ORIGIN_AUTH = ORIGIN;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleModule],
      controllers: [ProbeController],
      providers: [
        HybridAuthGuard,
        AuthFailureLimiter,
        {
          provide: ApiKeyService,
          useValue: { extractApiKey: () => null, validateApiKey: jest.fn() },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
  });

  afterAll(async () => {
    agent.destroy();
    await app.close();
    jest.restoreAllMocks();
    process.env = savedEnv;
  });

  beforeEach(() => {
    mockGetSession.mockReset();
    mockGetMcpSession.mockReset();
    mockGetSession.mockImplementation(({ headers }: { headers: Headers }) =>
      Promise.resolve(
        sessionTokenOf(headers) === VALID_SESSION_TOKEN
          ? {
              user: { id: 'usr_1', email: 'u@example.com', role: null },
              session: { id: 'ses_1', activeOrganizationId: 'org_1' },
            }
          : null,
      ),
    );
    mockGetMcpSession.mockImplementation(({ headers }: { headers: Headers }) =>
      Promise.resolve(
        bearerOf(headers) === VALID_MCP_TOKEN ? { userId: 'usr_mcp' } : null,
      ),
    );
  });

  const send = (client: string, extra: Record<string, string>) => {
    const call = request(app.getHttpServer() as App)
      .get('/probe/private')
      .agent(agent)
      .set('X-Comp-Origin-Auth', ORIGIN)
      .set('CF-Connecting-IP', client);
    for (const [name, value] of Object.entries(extra)) call.set(name, value);
    return call;
  };
  const withBearer = (client: string, token: string) =>
    send(client, { Authorization: `Bearer ${token}` });

  it('lets exactly the limit of junk bearer tokens reach the resolvers, then 429 without a lookup', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < N; i += 1) {
      statuses.push((await withBearer('198.51.100.10', `junk-${i}`)).status);
    }
    expect(statuses).toEqual(Array(N).fill(401));
    expect(mockGetSession).toHaveBeenCalledTimes(N);
    expect(mockGetMcpSession).toHaveBeenCalledTimes(N);

    const blocked = await withBearer('198.51.100.10', 'junk-last');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(mockGetSession).toHaveBeenCalledTimes(N);
    expect(mockGetMcpSession).toHaveBeenCalledTimes(N);
  });

  it('blocks a valid bearer token from a full bucket without a lookup, and leaves other clients alone', async () => {
    for (let i = 0; i < N; i += 1) {
      await withBearer('198.51.100.20', `junk-${i}`);
    }
    mockGetSession.mockClear();
    expect(
      (await withBearer('198.51.100.20', VALID_SESSION_TOKEN)).status,
    ).toBe(429);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(
      (await withBearer('198.51.100.21', VALID_SESSION_TOKEN)).status,
    ).toBe(200);
  });

  it('gives the attempt back when a bearer session is accepted', async () => {
    for (let i = 0; i < N - 1; i += 1) {
      await withBearer('198.51.100.30', `junk-${i}`);
    }
    const statuses: number[] = [];
    for (let i = 0; i < N + 5; i += 1) {
      statuses.push(
        (await withBearer('198.51.100.30', VALID_SESSION_TOKEN)).status,
      );
    }
    expect(statuses).toEqual(Array(N + 5).fill(200));
  });

  it('gives the attempt back when an MCP OAuth bearer token is accepted', async () => {
    for (let i = 0; i < N - 1; i += 1) {
      await withBearer('198.51.100.40', `junk-${i}`);
    }
    const statuses: number[] = [];
    for (let i = 0; i < N + 5; i += 1) {
      statuses.push(
        (await withBearer('198.51.100.40', VALID_MCP_TOKEN)).status,
      );
    }
    expect(statuses).toEqual(Array(N + 5).fill(200));
  });

  it('never counts cookie-only session 401s', async () => {
    for (let i = 0; i < N + 5; i += 1) {
      const response = await send('198.51.100.50', {
        Cookie: `better-auth.session_token=stale-${i}`,
      });
      expect(response.status).toBe(401);
    }
    const statuses: number[] = [];
    for (let i = 0; i < N; i += 1) {
      statuses.push((await withBearer('198.51.100.50', `junk-${i}`)).status);
    }
    expect(statuses).toEqual(Array(N).fill(401));
  });

  it('counts a junk bearer token sent with a valid session cookie (the bearer token takes precedence)', async () => {
    const both = (client: string) =>
      send(client, {
        Authorization: 'Bearer junk',
        Cookie: `better-auth.session_token=${VALID_SESSION_TOKEN}`,
      });
    const statuses: number[] = [];
    for (let i = 0; i < N; i += 1) {
      statuses.push((await both('198.51.100.70')).status);
    }
    expect(statuses).toEqual(Array(N).fill(401));
    mockGetSession.mockClear();
    mockGetMcpSession.mockClear();
    expect((await both('198.51.100.70')).status).toBe(429);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetMcpSession).not.toHaveBeenCalled();
  });

  it('gives the attempt back when a request with a bearer token and a valid cookie is accepted', async () => {
    for (let i = 0; i < N - 1; i += 1) {
      await withBearer('198.51.100.80', `junk-${i}`);
    }
    const statuses: number[] = [];
    for (let i = 0; i < N + 5; i += 1) {
      const response = await send('198.51.100.80', {
        Authorization: 'Bearer unsigned.signature',
        Cookie: `better-auth.session_token=${VALID_SESSION_TOKEN}`,
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual(Array(N + 5).fill(200));
  });

  it('keeps the attempt of a bearer lookup that hits a credential-store outage', async () => {
    mockGetSession.mockRejectedValue(
      Object.assign(new Error('cannot reach database'), {
        code: 'ECONNREFUSED',
      }),
    );
    const statuses: number[] = [];
    for (let i = 0; i < N; i += 1) {
      statuses.push(
        (await withBearer('198.51.100.60', VALID_SESSION_TOKEN)).status,
      );
    }
    expect(statuses).toEqual(Array(N).fill(503));
    expect(
      (await withBearer('198.51.100.60', VALID_SESSION_TOKEN)).status,
    ).toBe(429);
  });
});

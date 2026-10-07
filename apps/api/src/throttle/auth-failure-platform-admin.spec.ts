import type { INestApplication } from '@nestjs/common';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Agent } from 'node:http';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';

// Platform admin routes (/v1/admin/*, the framework editor) run
// PlatformAdminGuard instead of HybridAuthGuard and are not @Public, so neither
// the public-route throttle nor the identity interceptor limits a rejected
// credential there. The guard forwards Authorization to better-auth's
// database-backed session lookup, so a bearer token takes an attempt from the
// verified client IP bucket first, exactly as in HybridAuthGuard. The real guard
// and limiter run; the session resolver and the database are mocked.
const mockGetSession = jest.fn();
const mockFindUser = jest.fn();
jest.mock('../auth/auth.server', () => ({
  auth: {
    api: { getSession: (...args: unknown[]) => mockGetSession(...args) },
  },
}));
jest.mock('@db', () => ({
  db: { user: { findUnique: (...args: unknown[]) => mockFindUser(...args) } },
}));

import { AUTH_FAILURE_LIMIT, AuthFailureLimiter } from './auth-failure-limiter';
import { ThrottleModule } from './throttle.module';

const ORIGIN = 'D'.repeat(64);
const N = AUTH_FAILURE_LIMIT;
const ADMIN_TOKEN = 'admin-session-token';
const USER_TOKEN = 'user-session-token';
const SESSION_USERS: Record<string, { id: string; role: string | null }> = {
  [ADMIN_TOKEN]: { id: 'usr_admin', role: 'admin' },
  [USER_TOKEN]: { id: 'usr_user', role: null },
};

@Controller({ path: 'admin-probe' })
@UseGuards(PlatformAdminGuard)
class AdminProbeController {
  @Get()
  guarded() {
    return { ok: true };
  }
}

// better-auth's bearer plugin: an unsigned bearer token (no '.') replaces the
// session cookie before the lookup, so it takes precedence over a valid cookie.
function sessionTokenOf(headers: Headers): string | undefined {
  const bearer = headers.get('authorization')?.replace(/^Bearer /, '');
  if (bearer) return bearer;
  return headers.get('cookie')?.match(/session_token=([^;]+)/)?.[1];
}

const agent = new Agent({ keepAlive: false });

describe('credential attempt limit on platform admin routes (PlatformAdminGuard)', () => {
  let app: INestApplication;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.COMP_ORIGIN_AUTH = ORIGIN;
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleModule],
      controllers: [AdminProbeController],
      providers: [PlatformAdminGuard, AuthFailureLimiter],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
  });

  afterAll(async () => {
    agent.destroy();
    await app.close();
    process.env = savedEnv;
  });

  beforeEach(() => {
    mockGetSession.mockReset();
    mockFindUser.mockReset();
    mockGetSession.mockImplementation(({ headers }: { headers: Headers }) => {
      const user = SESSION_USERS[sessionTokenOf(headers) ?? ''];
      return Promise.resolve(user ? { user: { id: user.id } } : null);
    });
    mockFindUser.mockImplementation(({ where }: { where: { id: string } }) => {
      const user = Object.values(SESSION_USERS).find((u) => u.id === where.id);
      return Promise.resolve(
        user ? { ...user, email: `${user.id}@example.com` } : null,
      );
    });
  });

  const send = (client: string, extra: Record<string, string>) => {
    const call = request(app.getHttpServer() as App)
      .get('/admin-probe')
      .agent(agent)
      .set('X-Comp-Origin-Auth', ORIGIN)
      .set('CF-Connecting-IP', client);
    for (const [name, value] of Object.entries(extra)) call.set(name, value);
    return call;
  };
  const withBearer = (client: string, token: string) =>
    send(client, { Authorization: `Bearer ${token}` });
  const withCookie = (client: string, token: string) =>
    send(client, { Cookie: `better-auth.session_token=${token}` });

  it('lets exactly the limit of junk bearer tokens reach the session lookup, then 429 without a lookup', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < N; i += 1) {
      statuses.push((await withBearer('203.0.113.10', `junk-${i}`)).status);
    }
    expect(statuses).toEqual(Array(N).fill(401));
    expect(mockGetSession).toHaveBeenCalledTimes(N);

    const blocked = await withBearer('203.0.113.10', 'junk-last');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(mockGetSession).toHaveBeenCalledTimes(N);
    expect(mockFindUser).not.toHaveBeenCalled();

    // Another client is unaffected.
    expect((await withBearer('203.0.113.11', ADMIN_TOKEN)).status).toBe(200);
  });

  it('gives the attempt back when a bearer session is accepted (admin 200, non-admin 403)', async () => {
    for (let i = 0; i < N - 1; i += 1) {
      await withBearer('203.0.113.20', `junk-${i}`);
    }
    const statuses: number[] = [];
    for (let i = 0; i < N + 5; i += 1) {
      statuses.push((await withBearer('203.0.113.20', ADMIN_TOKEN)).status);
      statuses.push((await withBearer('203.0.113.20', USER_TOKEN)).status);
    }
    expect(statuses).toEqual(
      Array.from({ length: 2 * (N + 5) }, (_, i) => (i % 2 ? 403 : 200)),
    );
  });

  it('never counts cookie-only requests', async () => {
    for (let i = 0; i < N + 5; i += 1) {
      expect((await withCookie('203.0.113.30', `stale-${i}`)).status).toBe(401);
    }
    expect((await withCookie('203.0.113.30', ADMIN_TOKEN)).status).toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < N; i += 1) {
      statuses.push((await withBearer('203.0.113.30', `junk-${i}`)).status);
    }
    expect(statuses).toEqual(Array(N).fill(401));
  });

  it('counts a junk bearer token sent with a valid admin cookie (the bearer token takes precedence)', async () => {
    const both = (client: string) =>
      send(client, {
        Authorization: 'Bearer junk',
        Cookie: `better-auth.session_token=${ADMIN_TOKEN}`,
      });
    const statuses: number[] = [];
    for (let i = 0; i < N; i += 1) {
      statuses.push((await both('203.0.113.40')).status);
    }
    expect(statuses).toEqual(Array(N).fill(401));
    mockGetSession.mockClear();
    expect((await both('203.0.113.40')).status).toBe(429);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('keeps the attempt when the session lookup fails', async () => {
    mockGetSession.mockRejectedValue(new Error('cannot reach database'));
    for (let i = 0; i < N; i += 1) {
      expect((await withBearer('203.0.113.50', ADMIN_TOKEN)).status).toBe(500);
    }
    expect((await withBearer('203.0.113.50', ADMIN_TOKEN)).status).toBe(429);
  });
});

import type { INestApplication } from '@nestjs/common';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Throttle } from '@nestjs/throttler';
import { readFileSync } from 'node:fs';
import { Agent } from 'node:http';
import { resolve } from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ApiKeyService } from '../auth/api-key.service';
import { HybridAuthGuard } from '../auth/hybrid-auth.guard';
import { Public } from '../auth/public.decorator';
import { AuthFailureLimiter } from './auth-failure-limiter';

// The real HybridAuthGuard runs; only its session resolver and database are mocked.
const mockGetSession = jest.fn();
jest.mock('../auth/auth.server', () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getMcpSession: jest.fn().mockResolvedValue(null),
    },
  },
}));
jest.mock('@db', () => ({
  db: {
    member: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'mem_1', role: 'admin', department: null }),
    },
    organization: { findUnique: jest.fn().mockResolvedValue({ id: 'org_1' }) },
  },
}));

// better-auth's ESM access plugin cannot load under jest; the guard only needs
// the built-in role table for the MCP path, which these tests do not use.
jest.mock('@trycompai/auth', () => ({
  BUILT_IN_ROLE_PERMISSIONS: { admin: { app: ['read'] } },
}));

import { ThrottleModule } from './throttle.module';

// A private, non-keep-alive agent: Node's global agent keeps sockets alive
// across the test files of a jest worker, so a request could otherwise ride a
// socket still served by an earlier file's app that had the same port.
const agent = new Agent({ keepAlive: false });

const ORIGIN = 'A'.repeat(64);
const INTERNAL = 'internal-token-for-tests';
const FORWARDED = 'forwarded-ip-token-for-tests';
const SERVICE_TOKEN = 'portal-service-token-for-tests';
const LIMIT = { default: { limit: 2, ttl: 60_000 } };

@Controller({ path: 'probe' })
class ProbeController {
  @Public()
  @Throttle(LIMIT)
  @Get('public')
  open() {
    return { ok: true };
  }

  @UseGuards(HybridAuthGuard)
  @Throttle(LIMIT)
  @Get('private')
  guarded() {
    return { ok: true };
  }

  @Throttle(LIMIT)
  @Get('unguarded')
  unguarded() {
    return { ok: true };
  }

  @Get('default-limit')
  @Public()
  defaultLimit() {
    return { ok: true };
  }
}

const apiKeyService = {
  extractApiKey: (value: string) => value,
  validateApiKey: (key: string) =>
    Promise.resolve({
      organizationId: 'org_1',
      apiKeyId: `apk_${key}`,
      apiKeyName: key,
      scopes: [],
      createdByMemberId: null,
      organizationOwned: false,
    }),
};

describe('throttling chain (global public limiter + identity interceptor after HybridAuthGuard)', () => {
  let app: INestApplication;
  const logged: string[] = [];
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.COMP_ORIGIN_AUTH = ORIGIN;
    process.env.COMP_FORWARDED_IP_TOKEN = FORWARDED;
    process.env.INTERNAL_API_TOKEN = INTERNAL;
    process.env.SERVICE_TOKEN_PORTAL = SERVICE_TOKEN;
    for (const stream of [process.stdout, process.stderr]) {
      jest.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
        logged.push(String(chunk));
        return true;
      });
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => JSON.stringify(arg) ?? '').join(' '));
      });
    }

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleModule],
      controllers: [ProbeController],
      providers: [
        HybridAuthGuard,
        AuthFailureLimiter,
        { provide: ApiKeyService, useValue: apiKeyService },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // Listen once: unbound, supertest listens and closes per request.
    await app.listen(0);
  });

  afterAll(async () => {
    agent.destroy();
    await app.close();
    jest.restoreAllMocks();
    process.env = savedEnv;
  });

  beforeEach(() => {
    mockGetSession.mockImplementation(({ headers }: { headers: Headers }) => {
      const user = /user=(\w+)/.exec(headers.get('cookie') ?? '')?.[1];
      if (!user) return Promise.resolve(null);
      return Promise.resolve({
        user: { id: user, email: `${user}@revola.ai` },
        session: { id: `ses_${user}`, activeOrganizationId: 'org_1' },
      });
    });
  });

  const get = (path: string, headers: Record<string, string> = {}) => {
    const call = request(app.getHttpServer() as App)
      .get(path)
      .agent(agent);
    for (const [name, value] of Object.entries(headers)) call.set(name, value);
    return call.then((response) => response.status);
  };

  it('keeps the IP limiter on public routes and ignores forged client IP headers', async () => {
    const statuses: number[] = [];
    for (const forged of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      statuses.push(
        await get('/probe/public', {
          'CF-Connecting-IP': forged,
          'X-Forwarded-For': forged,
        }),
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('gives each verified Cloudflare client its own public bucket', async () => {
    const statuses: number[] = [];
    for (const client of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
      statuses.push(
        await get('/probe/public', {
          'X-Comp-Origin-Auth': ORIGIN,
          'CF-Connecting-IP': client,
        }),
      );
    }
    expect(statuses).toEqual([200, 200, 200]);
  });

  it('gives two signed-in users arriving through Service Connect separate buckets', async () => {
    const internal = {
      'X-Comp-Forwarded-Auth': FORWARDED,
      'X-Forwarded-For': '203.0.113.50',
    };
    const alice = { ...internal, Cookie: 'user=alice' };
    const bob = { ...internal, Cookie: 'user=bob' };
    const statuses = [
      await get('/probe/private', alice),
      await get('/probe/private', alice),
      await get('/probe/private', bob),
      await get('/probe/private', bob),
      await get('/probe/private', alice),
    ];
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });

  it('keys unauthenticated Service Connect calls on the forwarded client IP', async () => {
    const statuses: number[] = [];
    for (const client of ['203.0.113.60', '203.0.113.61', '203.0.113.62']) {
      statuses.push(
        await get('/probe/unguarded', {
          'X-Comp-Forwarded-Auth': FORWARDED,
          'X-Forwarded-For': `${client}, 10.0.3.4`,
        }),
      );
    }
    expect(statuses).toEqual([200, 200, 200]);
  });

  it('does not trust a forwarded client IP on the privileged internal token', async () => {
    const statuses: number[] = [];
    for (const client of ['203.0.113.70', '203.0.113.71', '203.0.113.72']) {
      statuses.push(
        await get('/probe/unguarded', {
          'X-Internal-Token': INTERNAL,
          'X-Forwarded-For': client,
        }),
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('gives a service-token caller its own bucket', async () => {
    const service = {
      'X-Service-Token': SERVICE_TOKEN,
      'X-Organization-Id': 'org_1',
    };
    await get('/probe/private', { Cookie: 'user=carol' });
    await get('/probe/private', { Cookie: 'user=carol' });
    expect(await get('/probe/private', { Cookie: 'user=carol' })).toBe(429);
    expect(await get('/probe/private', service)).toBe(200);
    expect(await get('/probe/private', service)).toBe(200);
    expect(await get('/probe/private', service)).toBe(429);
  });

  it('gives each API key its own bucket', async () => {
    expect(await get('/probe/private', { 'X-API-Key': 'one' })).toBe(200);
    expect(await get('/probe/private', { 'X-API-Key': 'one' })).toBe(200);
    expect(await get('/probe/private', { 'X-API-Key': 'one' })).toBe(429);
    expect(await get('/probe/private', { 'X-API-Key': 'two' })).toBe(200);
  });

  it('rejects an unauthenticated call to a guarded route with 401 before throttling', async () => {
    expect(await get('/probe/private')).toBe(401);
  });

  it('applies the global default of 100 requests per minute', async () => {
    const response = await request(app.getHttpServer() as App)
      .get('/probe/default-limit')
      .agent(agent);
    expect(response.headers['x-ratelimit-limit']).toBe('100');
  });

  it('never writes the origin or forwarded-auth header values to logs', () => {
    expect(logged.join('\n')).not.toContain(ORIGIN);
    expect(logged.join('\n')).not.toContain(FORWARDED);
  });
});

describe('main.ts', () => {
  it('sets no hop-count trust proxy (client IPs come only from verified headers)', () => {
    const source = readFileSync(resolve(__dirname, '../main.ts'), 'utf8');
    expect(source).not.toMatch(/['"]trust proxy['"]/);
  });
});

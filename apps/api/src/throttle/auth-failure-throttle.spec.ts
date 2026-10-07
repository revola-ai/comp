import type { INestApplication } from '@nestjs/common';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Agent, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ApiKeyService } from '../auth/api-key.service';
import { HybridAuthGuard } from '../auth/hybrid-auth.guard';
import { Public } from '../auth/public.decorator';

// The real HybridAuthGuard runs; its session resolver and database are mocked.
jest.mock('../auth/auth.server', () => ({
  auth: {
    api: {
      getSession: jest.fn().mockResolvedValue(null),
      getMcpSession: jest.fn().mockResolvedValue(null),
    },
  },
}));
jest.mock('@db', () => ({ db: {} }));
jest.mock('@trycompai/auth', () => ({
  BUILT_IN_ROLE_PERMISSIONS: { admin: { app: ['read'] } },
}));

import { AUTH_FAILURE_LIMIT, AuthFailureLimiter } from './auth-failure-limiter';
import { ThrottleModule } from './throttle.module';

const ORIGIN = 'B'.repeat(64);
const VALID_KEY = 'valid-key';
const N = AUTH_FAILURE_LIMIT;

@Controller({ path: 'probe' })
@UseGuards(HybridAuthGuard)
class ProbeController {
  @Get('private')
  guarded() {
    return { ok: true };
  }

  @Public()
  @Get('public')
  open() {
    return { ok: true };
  }
}

// Like the health, webhook and download controllers: no HybridAuthGuard.
@Controller({ path: 'plain' })
class PlainController {
  @Get()
  plain() {
    return { ok: true };
  }
}

const VALID_RESULT = {
  organizationId: 'org_1',
  apiKeyId: 'apk_valid',
  apiKeyName: 'valid',
  scopes: [],
  createdByMemberId: 'mem_1',
  organizationOwned: false,
};
const validateApiKey = jest.fn();
const resolveByKey = (key: string) =>
  Promise.resolve(key === VALID_KEY ? VALID_RESULT : null);

// A private, non-keep-alive agent: Node's global agent keeps sockets alive
// across the test files of a jest worker, so a request could otherwise ride a
// socket still served by an earlier file's app that had the same port.
const agent = new Agent({ keepAlive: false });

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await settle();
  if (!condition()) throw new Error('condition not reached');
}

describe('credential attempt limit (HybridAuthGuard, by verified client IP)', () => {
  let app: INestApplication;
  let port = 0;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.COMP_ORIGIN_AUTH = ORIGIN;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleModule],
      controllers: [ProbeController, PlainController],
      providers: [
        HybridAuthGuard,
        AuthFailureLimiter,
        {
          provide: ApiKeyService,
          useValue: { extractApiKey: (value: string) => value, validateApiKey },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    port = (app.getHttpServer() as { address(): AddressInfo }).address().port;
  });

  afterAll(async () => {
    agent.destroy();
    await app.close();
    jest.restoreAllMocks();
    process.env = savedEnv;
  });

  beforeEach(() => {
    validateApiKey.mockReset();
    validateApiKey.mockImplementation(resolveByKey);
  });

  const headersFor = (client: string, extra: Record<string, string> = {}) => ({
    'X-Comp-Origin-Auth': ORIGIN,
    'CF-Connecting-IP': client,
    ...extra,
  });

  const send = (headers: Record<string, string>, path = '/probe/private') => {
    const call = request(app.getHttpServer() as App)
      .get(path)
      .agent(agent);
    for (const [name, value] of Object.entries(headers)) call.set(name, value);
    return call;
  };
  const get = (headers: Record<string, string>, path = '/probe/private') =>
    send(headers, path).then((response) => response.status);

  const withKey = (client: string, key: string, path = '/probe/private') =>
    get(headersFor(client, { 'X-API-Key': key }), path);

  it('lets exactly the limit of rejected API keys reach validation, then 429 without a lookup', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < N; i += 1) {
      statuses.push(await withKey('192.0.2.10', `junk-${i}`));
    }
    expect(statuses).toEqual(Array(N).fill(401));
    expect(validateApiKey).toHaveBeenCalledTimes(N);
    const refused = await send(
      headersFor('192.0.2.10', { 'X-API-Key': 'junk-last' }),
    );
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toMatch(/^\d+$/);
    expect(validateApiKey).toHaveBeenCalledTimes(N);
  });

  it('never takes a slot for a valid key on a @Public route', async () => {
    for (let i = 0; i <= N + 5; i += 1) {
      expect(await withKey('192.0.2.12', VALID_KEY, '/probe/public')).toBe(200);
    }
    expect(validateApiKey).not.toHaveBeenCalled();
    for (let i = 0; i < N; i += 1) {
      expect(await withKey('192.0.2.12', `junk-${i}`)).toBe(401);
    }
  });

  it('never takes a slot on a route without HybridAuthGuard', async () => {
    for (let i = 0; i <= N + 5; i += 1) {
      expect(await withKey('192.0.2.13', `junk-${i}`, '/plain')).toBe(200);
    }
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(await withKey('192.0.2.13', VALID_KEY)).toBe(200);
  });

  it('refuses the blocked IP before any key lookup, even for a valid key', async () => {
    expect(await withKey('192.0.2.10', 'junk-again')).toBe(429);
    expect(await withKey('192.0.2.10', VALID_KEY)).toBe(429);
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it('leaves a valid caller from another IP unaffected', async () => {
    expect(await withKey('192.0.2.11', VALID_KEY)).toBe(200);
  });

  it('counts a burst at arrival: of N+5 simultaneous bad keys exactly N reach validation', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    validateApiKey.mockImplementation(() => held);
    const statuses: number[] = [];
    const burst = Array.from({ length: N + 5 }, (_, i) =>
      withKey('192.0.2.20', `burst-${i}`).then((status) => {
        statuses.push(status);
        return status;
      }),
    );
    await until(() => statuses.length === 5);
    expect(validateApiKey).toHaveBeenCalledTimes(N);
    expect(statuses).toEqual(Array(5).fill(429));
    release();
    const all = await Promise.all(burst);
    expect(all.filter((status) => status === 401)).toHaveLength(N);
  });

  it('keeps aborted requests counted', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    validateApiKey.mockImplementation(() => held);
    for (let i = 0; i < N; i += 1) {
      const aborted = httpRequest({
        agent,
        port,
        path: '/probe/private',
        headers: headersFor('192.0.2.30', { 'X-API-Key': `abort-${i}` }),
      });
      aborted.on('error', () => undefined);
      aborted.end();
      await until(() => validateApiKey.mock.calls.length === i + 1);
      aborted.destroy();
    }
    release();
    await settle();
    validateApiKey.mockImplementation(resolveByKey);
    expect(await withKey('192.0.2.30', VALID_KEY)).toBe(429);
    expect(validateApiKey).toHaveBeenCalledTimes(N);
  });

  it('refunds the slot of a request whose key is accepted', async () => {
    for (let i = 0; i < N - 1; i += 1) {
      expect(await withKey('192.0.2.40', `junk-${i}`)).toBe(401);
    }
    for (let i = 0; i <= N; i += 1) {
      expect(await withKey('192.0.2.40', VALID_KEY)).toBe(200);
    }
    expect(await withKey('192.0.2.40', 'last-junk')).toBe(401);
    expect(await withKey('192.0.2.40', 'one-more')).toBe(429);
  });

  it('never counts cookie-session or credential-less 401s', async () => {
    for (let i = 0; i <= 2 * N; i += 1) {
      expect(
        await get(headersFor('192.0.2.50', { Cookie: `session=stale-${i}` })),
      ).toBe(401);
      expect(await get(headersFor('192.0.2.50'))).toBe(401);
    }
    expect(await withKey('192.0.2.50', VALID_KEY)).toBe(200);
  });

  it('counts rejected service tokens', async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= N; i += 1) {
      statuses.push(
        await get(
          headersFor('192.0.2.60', {
            'X-Service-Token': `bad-${i}`,
            'X-Organization-Id': 'org_1',
          }),
        ),
      );
    }
    expect(statuses[N - 1]).toBe(401);
    expect(statuses[N]).toBe(429);
  });

  it('cannot be dodged by forging client IP headers without the origin secret', async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= N; i += 1) {
      const forged = `198.51.100.${i + 1}`;
      statuses.push(
        await get({
          'CF-Connecting-IP': forged,
          'X-Forwarded-For': forged,
          'X-API-Key': `junk-${i}`,
        }),
      );
    }
    expect(statuses[N]).toBe(429);
  });
});

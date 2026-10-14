import type { INestApplication } from '@nestjs/common';
import { Controller, ForbiddenException, Get, UseGuards } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Agent } from 'node:http';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ApiKeyService } from '../auth/api-key.service';
import { HybridAuthGuard } from '../auth/hybrid-auth.guard';

// When HybridAuthGuard gives an API key's slot back: as soon as it accepts the
// key (not when the handler finishes), or when its lookup hit a credential-store
// outage that a database probe confirms, so retries during an outage do not
// lock the key out after recovery. A wrong key or any other failure keeps the
// slot, as does a 503 the probe does not confirm (a flood of junk keys
// exhausting the connection pool while the database answers). A valid service
// token never takes a slot at all.
const mockReadiness = jest.fn();
jest.mock('../health/readiness', () => ({
  checkApiReadiness: () => mockReadiness(),
}));
jest.mock('../auth/auth.server', () => ({
  auth: {
    api: {
      getSession: jest.fn().mockResolvedValue(null),
      getMcpSession: jest.fn().mockResolvedValue(null),
    },
  },
}));
jest.mock('@db', () => ({
  db: { organization: { findUnique: () => Promise.resolve({ id: 'org_1' }) } },
}));
jest.mock('@trycompai/auth', () => ({
  BUILT_IN_ROLE_PERMISSIONS: { admin: { app: ['read'] } },
}));

import { CredentialStoreUnavailableFilter } from '../auth/credential-store-unavailable.filter';
import { credentialStoreUnavailable } from '../auth/credential-store-error';
import { AUTH_FAILURE_LIMIT, AuthFailureLimiter } from './auth-failure-limiter';
import { ThrottleModule } from './throttle.module';

const ORIGIN = 'C'.repeat(64);
const SERVICE_TOKEN = 'trigger-service-token-for-tests';
const VALID_KEY = 'valid-key';
const N = AUTH_FAILURE_LIMIT;

let releaseSlow: () => void = () => undefined;
let slowGate = Promise.resolve();
let inSlowHandler = 0;

@Controller({ path: 'probe' })
@UseGuards(HybridAuthGuard)
class ProbeController {
  @Get('private')
  guarded() {
    return { ok: true };
  }

  @Get('slow')
  async slow() {
    inSlowHandler += 1;
    await slowGate;
    return { ok: true };
  }

  @Get('scope-denied')
  denied() {
    throw new ForbiddenException('Missing scope risk:update');
  }
}

const validateApiKey = jest.fn();
const resolveByKey = (key: string) =>
  Promise.resolve(
    key === VALID_KEY
      ? {
          organizationId: 'org_1',
          apiKeyId: 'apk_valid',
          apiKeyName: 'valid',
          scopes: ['risk:read'],
          createdByMemberId: 'mem_1',
          organizationOwned: false,
          creatorRoles: null,
        }
      : null,
  );

// A private, non-keep-alive agent: Node's global agent keeps sockets alive
// across the test files of a jest worker, so a request could otherwise ride a
// socket still served by an earlier file's app that had the same port.
const agent = new Agent({ keepAlive: false });

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await settle();
  if (!condition()) throw new Error('condition not reached');
}

describe('credential attempt limit: refunds at acceptance, service tokens first', () => {
  let app: INestApplication;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.COMP_ORIGIN_AUTH = ORIGIN;
    process.env.SERVICE_TOKEN_TRIGGER = SERVICE_TOKEN;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleModule],
      controllers: [ProbeController],
      providers: [
        HybridAuthGuard,
        AuthFailureLimiter,
        { provide: APP_FILTER, useClass: CredentialStoreUnavailableFilter },
        {
          provide: ApiKeyService,
          useValue: { extractApiKey: (value: string) => value, validateApiKey },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Listen once: unbound, supertest listens and closes per request, so a
    // concurrent burst could reach a port that was closed and bound again.
    await app.listen(0);
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
    mockReadiness.mockReset().mockResolvedValue({ status: 'ok' });
  });

  const call = (
    path: string,
    client: string,
    extra: Record<string, string>,
  ) => {
    const pending = request(app.getHttpServer() as App)
      .get(path)
      .agent(agent)
      .set('X-Comp-Origin-Auth', ORIGIN)
      .set('CF-Connecting-IP', client);
    for (const [name, value] of Object.entries(extra)) pending.set(name, value);
    return pending;
  };
  const status = (
    path: string,
    client: string,
    extra: Record<string, string>,
  ) => call(path, client, extra).then((response) => response.status);
  const key = (value: string) => ({ 'X-API-Key': value });
  const service = (token: string) => ({
    'X-Service-Token': token,
    'X-Organization-Id': 'org_1',
  });

  it('does not hold a slot for a long-running valid request: N+5 concurrent all pass', async () => {
    slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    inSlowHandler = 0;
    const pending = Array.from({ length: N + 5 }, () =>
      status('/probe/slow', '192.0.2.80', key(VALID_KEY)),
    );
    try {
      await until(() => inSlowHandler === N + 5);
    } finally {
      releaseSlow();
    }
    expect(await Promise.all(pending)).toEqual(Array(N + 5).fill(200));
  });

  it('refunds a 403 raised after the credential was accepted (scope denial)', async () => {
    for (let i = 0; i <= N; i += 1) {
      expect(
        await status('/probe/scope-denied', '192.0.2.81', key(VALID_KEY)),
      ).toBe(403);
    }
    expect(await status('/probe/private', '192.0.2.81', key(VALID_KEY))).toBe(
      200,
    );
  });

  it('lets a valid service token through while the IP bucket is full of junk keys', async () => {
    for (let i = 0; i < N; i += 1) {
      expect(
        await status('/probe/private', '192.0.2.82', key(`junk-${i}`)),
      ).toBe(401);
    }
    expect(await status('/probe/private', '192.0.2.82', key('junk-more'))).toBe(
      429,
    );
    for (let i = 0; i < 3; i += 1) {
      expect(
        await status('/probe/private', '192.0.2.82', service(SERVICE_TOKEN)),
      ).toBe(200);
    }
  });

  it('still counts a junk API key sent alongside a valid service token (the key decides)', async () => {
    for (let i = 0; i < N; i += 1) {
      await status('/probe/private', '192.0.2.83', {
        ...service(SERVICE_TOKEN),
        ...key(`junk-${i}`),
      });
    }
    expect(
      await status('/probe/private', '192.0.2.83', service(SERVICE_TOKEN)),
    ).toBe(200);
    expect(
      await status('/probe/private', '192.0.2.83', {
        ...service(SERVICE_TOKEN),
        ...key('junk-last'),
      }),
    ).toBe(429);
  });

  it('counts junk service tokens', async () => {
    for (let i = 0; i < N; i += 1) {
      expect(
        await status('/probe/private', '192.0.2.84', service(`bad-${i}`)),
      ).toBe(401);
    }
    expect(
      await status('/probe/private', '192.0.2.84', service('bad-last')),
    ).toBe(429);
  });

  const outageThenValidKey = async (client: string) => {
    validateApiKey.mockRejectedValue(credentialStoreUnavailable());
    for (let i = 0; i <= N; i += 1) {
      const response = await call('/probe/private', client, key(`any-${i}`));
      if (response.status === 429) break;
      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toMatch(/^\d+$/);
    }
    validateApiKey.mockReset();
    validateApiKey.mockImplementation(resolveByKey);
    return call('/probe/private', client, key(VALID_KEY));
  };

  it('gives the slot back when the probe confirms a credential-store outage', async () => {
    mockReadiness.mockResolvedValue({ status: 'unavailable', reason: 'P1001' });
    const recovered = await outageThenValidKey('192.0.2.85');
    expect(recovered.status).toBe(200);
    expect(validateApiKey).toHaveBeenCalledWith(VALID_KEY);
  });

  it('keeps the slot of a 503 the database probe does not confirm', async () => {
    const refused = await outageThenValidKey('192.0.2.87');
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toMatch(/^\d+$/);
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it('keeps the slot of a request whose lookup fails for another reason', async () => {
    // Even while the database is down: only a credential-store 503 is refunded.
    mockReadiness.mockResolvedValue({ status: 'unavailable', reason: 'P1001' });
    validateApiKey.mockRejectedValue(new Error('bug'));
    for (let i = 0; i < N; i += 1) {
      expect(await status('/probe/private', '192.0.2.86', key(`x-${i}`))).toBe(
        500,
      );
    }
    expect(await status('/probe/private', '192.0.2.86', key(VALID_KEY))).toBe(
      429,
    );
  });
});

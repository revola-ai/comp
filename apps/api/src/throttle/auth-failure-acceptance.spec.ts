import type { INestApplication } from '@nestjs/common';
import { Controller, ForbiddenException, Get, UseGuards } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ApiKeyService } from '../auth/api-key.service';
import { HybridAuthGuard } from '../auth/hybrid-auth.guard';

// When the limiter gives a slot back: as soon as HybridAuthGuard accepts the
// credential (not when the handler finishes), and when the credential store is
// down. A valid service token never takes a slot at all.
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
import { AUTH_FAILURE_LIMIT } from './auth-failure-limiter';
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
        }
      : null,
  );

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await settle();
  if (!condition()) throw new Error('condition not reached');
}

describe('pre-authentication limiter: refunds at acceptance, service tokens first', () => {
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
        { provide: APP_FILTER, useClass: CredentialStoreUnavailableFilter },
        {
          provide: ApiKeyService,
          useValue: { extractApiKey: (value: string) => value, validateApiKey },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
    process.env = savedEnv;
  });

  beforeEach(() => {
    validateApiKey.mockReset();
    validateApiKey.mockImplementation(resolveByKey);
  });

  const call = (
    path: string,
    client: string,
    extra: Record<string, string>,
  ) => {
    const pending = request(app.getHttpServer() as App)
      .get(path)
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

  it('answers 503 with Retry-After and refunds the slot when the credential store is down', async () => {
    validateApiKey.mockRejectedValue(credentialStoreUnavailable());
    for (let i = 0; i <= N; i += 1) {
      const response = await call(
        '/probe/private',
        '192.0.2.85',
        key(`any-${i}`),
      );
      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toMatch(/^\d+$/);
    }
    validateApiKey.mockImplementation(resolveByKey);
    expect(await status('/probe/private', '192.0.2.85', key(VALID_KEY))).toBe(
      200,
    );
  });
});

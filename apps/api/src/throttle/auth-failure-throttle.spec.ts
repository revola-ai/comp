import type { INestApplication } from '@nestjs/common';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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

import { AUTH_FAILURE_LIMIT } from './auth-failure-limiter';
import { ThrottleModule } from './throttle.module';

const ORIGIN = 'B'.repeat(64);
const VALID_KEY = 'valid-key';

@Controller({ path: 'probe' })
class ProbeController {
  @UseGuards(HybridAuthGuard)
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

const validateApiKey = jest.fn((key: string) =>
  Promise.resolve(
    key === VALID_KEY
      ? {
          organizationId: 'org_1',
          apiKeyId: 'apk_valid',
          apiKeyName: 'valid',
          scopes: [],
          createdByMemberId: 'mem_1',
          organizationOwned: false,
        }
      : null,
  ),
);

describe('pre-authentication limiter (failed credentials by verified client IP)', () => {
  let app: INestApplication;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.COMP_ORIGIN_AUTH = ORIGIN;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleModule],
      controllers: [ProbeController],
      providers: [
        HybridAuthGuard,
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

  const viaCloudflare = (client: string, key?: string) => {
    const call = request(app.getHttpServer() as App)
      .get('/probe/private')
      .set('X-Comp-Origin-Auth', ORIGIN)
      .set('CF-Connecting-IP', client);
    if (key) call.set('X-API-Key', key);
    return call.then((response) => response.status);
  };

  it('answers 429 once one verified IP has sent the limit of rejected API keys', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= AUTH_FAILURE_LIMIT; attempt += 1) {
      statuses.push(await viaCloudflare('192.0.2.10', `junk-${attempt}`));
    }
    expect(statuses.slice(0, AUTH_FAILURE_LIMIT)).toEqual(
      Array(AUTH_FAILURE_LIMIT).fill(401),
    );
    expect(statuses[AUTH_FAILURE_LIMIT]).toBe(429);
  });

  it('refuses the blocked IP before any key lookup, even for a valid key', async () => {
    const lookups = validateApiKey.mock.calls.length;
    expect(await viaCloudflare('192.0.2.10', 'junk-again')).toBe(429);
    expect(await viaCloudflare('192.0.2.10', VALID_KEY)).toBe(429);
    expect(validateApiKey.mock.calls.length).toBe(lookups);
  });

  it('leaves a valid caller from another IP unaffected', async () => {
    expect(await viaCloudflare('192.0.2.11', VALID_KEY)).toBe(200);
  });

  it('counts unauthenticated calls without credentials too', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= AUTH_FAILURE_LIMIT; attempt += 1) {
      statuses.push(await viaCloudflare('192.0.2.12'));
    }
    expect(statuses[AUTH_FAILURE_LIMIT - 1]).toBe(401);
    expect(statuses[AUTH_FAILURE_LIMIT]).toBe(429);
  });

  it('cannot be dodged by forging client IP headers without the origin secret', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= AUTH_FAILURE_LIMIT; attempt += 1) {
      const forged = `198.51.100.${attempt + 1}`;
      const response = await request(app.getHttpServer() as App)
        .get('/probe/private')
        .set('CF-Connecting-IP', forged)
        .set('X-Forwarded-For', forged)
        .set('X-API-Key', `junk-${attempt}`);
      statuses.push(response.status);
    }
    expect(statuses[AUTH_FAILURE_LIMIT]).toBe(429);
  });

  it('does not count successful requests', async () => {
    for (let attempt = 0; attempt <= AUTH_FAILURE_LIMIT; attempt += 1) {
      expect(await viaCloudflare('192.0.2.13', VALID_KEY)).toBe(200);
    }
  });
});

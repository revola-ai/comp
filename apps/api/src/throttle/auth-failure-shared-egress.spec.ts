import type { INestApplication } from '@nestjs/common';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Agent } from 'node:http';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ApiKeyService } from '../auth/api-key.service';
import { HybridAuthGuard } from '../auth/hybrid-auth.guard';

// Many clients can share one egress IP (Gram's MCP servers, an office NAT of
// device agents). A client repeating one stale credential must exhaust only
// its own allowance, not lock everyone behind that IP out; a spray of many
// distinct junk credentials from one IP must still end in 429. The real
// HybridAuthGuard and limiter run; the credential lookups are mocked.
const mockGetSession = jest.fn();
jest.mock('../auth/auth.server', () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getMcpSession: () => Promise.resolve(null),
    },
  },
}));
jest.mock('@db', () => ({
  db: {
    member: {
      findFirst: () =>
        Promise.resolve({ id: 'mem_1', role: 'admin', department: null }),
    },
  },
}));
jest.mock('@trycompai/auth', () => ({
  BUILT_IN_ROLE_PERMISSIONS: { admin: { app: ['read'] } },
}));

import {
  AUTH_FAILURE_CREDENTIAL_LIMIT,
  AUTH_FAILURE_LIMIT,
  AuthFailureLimiter,
} from './auth-failure-limiter';
import { ThrottleModule } from './throttle.module';

const ORIGIN = 'E'.repeat(64);
const VALID_TOKEN = 'valid-session-token';
const VALID_KEY = 'comp_valid-key';
const SHARED_IP = '203.0.113.200';

@Controller({ path: 'probe' })
@UseGuards(HybridAuthGuard)
class ProbeController {
  @Get()
  guarded() {
    return { ok: true };
  }
}

const validateApiKey = jest.fn((key: string) =>
  Promise.resolve(
    key === VALID_KEY
      ? {
          organizationId: 'org_1',
          apiKeyId: 'apk_1',
          apiKeyName: 'valid',
          scopes: [],
          createdByMemberId: 'mem_1',
          organizationOwned: false,
          creatorRoles: null,
        }
      : null,
  ),
);

const agent = new Agent({ keepAlive: false });

describe('credential attempt limit behind a shared egress IP', () => {
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
          useValue: { extractApiKey: (value: string) => value, validateApiKey },
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
    mockGetSession.mockImplementation(({ headers }: { headers: Headers }) =>
      Promise.resolve(
        headers.get('authorization') === `Bearer ${VALID_TOKEN}`
          ? {
              user: { id: 'usr_1', email: 'u@example.com', role: null },
              session: { id: 'ses_1', activeOrganizationId: 'org_1' },
            }
          : null,
      ),
    );
  });

  const send = (client: string, headers: Record<string, string>) => {
    const call = request(app.getHttpServer() as App)
      .get('/probe')
      .agent(agent)
      .set('X-Comp-Origin-Auth', ORIGIN)
      .set('CF-Connecting-IP', client);
    for (const [name, value] of Object.entries(headers)) call.set(name, value);
    return call.then((response) => response.status);
  };
  const bearer = (client: string, token: string) =>
    send(client, { Authorization: `Bearer ${token}` });
  const apiKey = (client: string, key: string) =>
    send(client, { 'X-API-Key': key });

  it('lets a second user through while the first repeats a stale bearer token', async () => {
    const stale: number[] = [];
    for (let i = 0; i < 3 * AUTH_FAILURE_CREDENTIAL_LIMIT; i += 1) {
      stale.push(await bearer(SHARED_IP, 'expired-session-token'));
    }
    expect(stale.slice(0, AUTH_FAILURE_CREDENTIAL_LIMIT)).toEqual(
      Array(AUTH_FAILURE_CREDENTIAL_LIMIT).fill(401),
    );
    expect(stale.slice(AUTH_FAILURE_CREDENTIAL_LIMIT)).toEqual(
      Array(2 * AUTH_FAILURE_CREDENTIAL_LIMIT).fill(429),
    );

    expect(await bearer(SHARED_IP, VALID_TOKEN)).toBe(200);
    expect(await apiKey(SHARED_IP, VALID_KEY)).toBe(200);
  });

  it('still ends a spray of distinct junk API keys from one IP in 429', async () => {
    const client = '203.0.113.201';
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
      statuses.push(await apiKey(client, `comp_junk-${i}`));
    }
    expect(statuses).toEqual(Array(AUTH_FAILURE_LIMIT).fill(401));
    validateApiKey.mockClear();
    expect(await apiKey(client, 'comp_junk-next')).toBe(429);
    expect(await apiKey(client, VALID_KEY)).toBe(429);
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it('does not let refused repeats of a stale token use up the IP ceiling', async () => {
    const client = '203.0.113.202';
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
      await bearer(client, 'expired-session-token');
    }
    const statuses: number[] = [];
    const fresh = AUTH_FAILURE_LIMIT - AUTH_FAILURE_CREDENTIAL_LIMIT;
    for (let i = 0; i < fresh; i += 1) {
      statuses.push(await bearer(client, `other-junk-${i}`));
    }
    expect(statuses).toEqual(Array(fresh).fill(401));
    expect(await bearer(client, 'one-too-many')).toBe(429);
  });

  it('keys the stale-token allowance per IP: the same token elsewhere is unaffected', async () => {
    for (let i = 0; i <= AUTH_FAILURE_CREDENTIAL_LIMIT; i += 1) {
      await bearer('203.0.113.203', 'expired-elsewhere');
    }
    expect(await bearer('203.0.113.204', 'expired-elsewhere')).toBe(401);
  });
});

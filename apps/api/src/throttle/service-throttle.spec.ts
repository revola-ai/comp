import type { INestApplication } from '@nestjs/common';
import { Controller, Get, UseGuards, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Agent } from 'node:http';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ApiKeyService } from '../auth/api-key.service';
import { HybridAuthGuard } from '../auth/hybrid-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { EmailController } from '../email/email.controller';
import { AuthFailureLimiter } from './auth-failure-limiter';

// The real HybridAuthGuard, PermissionGuard and EmailController run; only the
// database, the session resolver and the Trigger.dev SDK are mocked.
const mockTrigger = jest.fn();
jest.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...args: unknown[]) => mockTrigger(...args) },
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
  db: {
    organization: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id }),
    },
  },
}));
jest.mock('@trycompai/auth', () => ({
  BUILT_IN_ROLE_PERMISSIONS: {},
  RESTRICTED_ROLES: ['employee', 'contractor'],
  PRIVILEGED_ROLES: ['owner', 'admin', 'auditor'],
}));

import { ThrottleModule } from './throttle.module';
import { SERVICE_THROTTLE_LIMIT } from './identity-throttler.guard';

const agent = new Agent({ keepAlive: false });
const TRIGGER_TOKEN = 'trigger-service-token-for-tests';

@Controller({ path: 'probe', version: '1' })
@UseGuards(HybridAuthGuard)
class ProbeController {
  @Get('default-limit')
  defaultLimit() {
    return { ok: true };
  }
}

describe('service-token throttling', () => {
  let app: INestApplication;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.SERVICE_TOKEN_TRIGGER = TRIGGER_TOKEN;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleModule],
      controllers: [EmailController, ProbeController],
      providers: [
        HybridAuthGuard,
        PermissionGuard,
        AuthFailureLimiter,
        { provide: ApiKeyService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.enableVersioning({ type: VersioningType.URI });
    await app.listen(0);
  });

  afterAll(async () => {
    agent.destroy();
    await app.close();
    jest.restoreAllMocks();
    process.env = savedEnv;
  });

  beforeEach(() => {
    mockTrigger.mockResolvedValue({ id: 'run_1' });
  });

  const asService = (organizationId: string) => ({
    'X-Service-Token': TRIGGER_TOKEN,
    'X-Organization-Id': organizationId,
  });

  const sendEmail = (organizationId: string, to: string) =>
    request(app.getHttpServer() as App)
      .post('/v1/internal/email/send')
      .agent(agent)
      .set(asService(organizationId))
      .send({ to, subject: 'Task reminder', html: '<p>hi</p>' })
      .then((response) => response.status);

  const probe = (organizationId: string) =>
    request(app.getHttpServer() as App)
      .get('/v1/probe/default-limit')
      .agent(agent)
      .set(asService(organizationId))
      .then((response) => response.status);

  /** Sends `count` requests, at most 50 at a time. */
  async function fanOut({
    count,
    send,
  }: {
    count: number;
    send: (index: number) => Promise<number>;
  }) {
    const statuses: number[] = [];
    for (let start = 0; start < count; start += 50) {
      const size = Math.min(50, count - start);
      const batch = Array.from({ length: size }, (_, i) => send(start + i));
      statuses.push(...(await Promise.all(batch)));
    }
    return statuses;
  }

  it('delivers a 150-recipient email fan-out from one service in one org', async () => {
    const statuses = await fanOut({
      count: 150,
      send: (i) => sendEmail('org_fanout', `employee-${i}@example.com`),
    });
    expect(statuses.filter((status) => status !== 200)).toEqual([]);
    expect(mockTrigger).toHaveBeenCalledTimes(150);
  });

  it('never throttles the service-only email routes', async () => {
    const statuses = await fanOut({
      count: SERVICE_THROTTLE_LIMIT + 1,
      send: (i) => sendEmail('org_bulk', `employee-${i}@example.com`),
    });
    expect(statuses.filter((status) => status !== 200)).toEqual([]);
  });

  it('allows a service far more than the 100/min default on other routes', async () => {
    const statuses = await fanOut({
      count: 150,
      send: () => probe('org_busy'),
    });
    expect(statuses.filter((status) => status !== 200)).toEqual([]);
  });

  it('gives each organization its own service bucket', async () => {
    const first = await fanOut({
      count: SERVICE_THROTTLE_LIMIT,
      send: () => probe('org_a'),
    });
    expect(first.filter((status) => status !== 200)).toEqual([]);
    expect(await probe('org_a')).toBe(429);
    expect(await probe('org_b')).toBe(200);
  });
});

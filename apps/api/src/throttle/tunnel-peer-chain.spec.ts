import type { INestApplication } from '@nestjs/common';
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
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
import {
  CLIENT_IP_HEADER,
  clientIpHeaderMiddleware,
} from './client-ip-header.middleware';
import { ThrottleModule } from './throttle.module';

const N = AUTH_FAILURE_LIMIT;
const LIMIT = { default: { limit: 2, ttl: 60_000 } };
// supertest connects from loopback; the server listens dual-stack, so the
// socket reports the peer as ::ffff:127.0.0.1 and the list must still match.
const TUNNEL_PEER = '127.0.0.1';
const OTHER_PEER = '172.30.0.10';

@Controller({ path: 'probe' })
class ProbeController {
  @Public()
  @Throttle(LIMIT)
  @Get('public')
  open() {
    return { ok: true };
  }

  @Public()
  @Throttle(LIMIT)
  @Get('public-forged')
  openForged() {
    return { ok: true };
  }

  @UseGuards(HybridAuthGuard)
  @Get('private')
  guarded() {
    return { ok: true };
  }

  @Public()
  @Get('client-ip')
  clientIp(@Req() req: Request) {
    return { ip: req.headers[CLIENT_IP_HEADER] ?? null };
  }
}

// A private, non-keep-alive agent: Node's global agent keeps sockets alive
// across the test files of a jest worker, so a request could otherwise ride a
// socket still served by an earlier file's app that had the same port.
const agent = new Agent({ keepAlive: false });

describe('client IP behind a Cloudflare Tunnel (throttler, failure limiter, better-auth header)', () => {
  let app: INestApplication;
  let port = 0;
  const savedEnv = { ...process.env };
  const validateApiKey = jest.fn().mockResolvedValue(null);

  beforeAll(async () => {
    delete process.env.COMP_ORIGIN_AUTH;
    delete process.env.COMP_ORIGIN_AUTH_PREVIOUS;
    delete process.env.COMP_FORWARDED_IP_TOKEN;
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
    app.use(clientIpHeaderMiddleware);
    await app.listen(0);
    port = (app.getHttpServer() as { address(): AddressInfo }).address().port;
  });

  afterAll(async () => {
    agent.destroy();
    await app.close();
    jest.restoreAllMocks();
    process.env = savedEnv;
  });

  const send = (path: string, headers: Record<string, string>) => {
    const call = request(app.getHttpServer() as App)
      .get(path)
      .agent(agent);
    for (const [name, value] of Object.entries(headers)) call.set(name, value);
    return call;
  };
  const status = (path: string, headers: Record<string, string>) =>
    send(path, headers).then((response) => response.status);
  const clientIpOf = (headers: Record<string, string>) =>
    send('/probe/client-ip', headers).then(
      (response) => (response.body as { ip: string | null }).ip,
    );
  // Sends CF-Connecting-IP as two header lines, which Node joins with ", ".
  const clientIpWithRepeatedHeader = (visitors: string[]) =>
    new Promise<string | null>((resolve, reject) => {
      const call = httpRequest(
        {
          agent,
          host: '127.0.0.1',
          port,
          path: '/probe/client-ip',
          headers: { 'CF-Connecting-IP': visitors },
        },
        (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => (body += chunk.toString()));
          response.on('end', () =>
            resolve((JSON.parse(body) as { ip: string | null }).ip),
          );
        },
      );
      call.on('error', reject);
      call.end();
    });
  const badKey = (visitor: string, i: number) =>
    status('/probe/private', {
      'CF-Connecting-IP': visitor,
      'X-API-Key': `junk-${visitor}-${i}`,
    });

  describe('from the tunnel peer', () => {
    beforeAll(() => {
      process.env.TRUSTED_EDGE_PROXY_IPS = `${OTHER_PEER}, ${TUNNEL_PEER}`;
    });

    it('gives each visitor its own throttler bucket', async () => {
      const statuses: number[] = [];
      for (const visitor of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
        statuses.push(
          await status('/probe/public', { 'CF-Connecting-IP': visitor }),
        );
      }
      expect(statuses).toEqual([200, 200, 200]);
      expect(
        await status('/probe/public', { 'CF-Connecting-IP': '192.0.2.1' }),
      ).toBe(200);
      expect(
        await status('/probe/public', { 'CF-Connecting-IP': '192.0.2.1' }),
      ).toBe(429);
    });

    it('gives each visitor its own credential-failure bucket', async () => {
      const first: number[] = [];
      for (let i = 0; i < N; i += 1) first.push(await badKey('192.0.2.10', i));
      expect(first).toEqual(Array(N).fill(401));
      expect(await badKey('192.0.2.10', N)).toBe(429);
      expect(await badKey('192.0.2.11', 0)).toBe(401);
    });

    it('hands better-auth the visitor address, replacing a client-supplied one', async () => {
      expect(
        await clientIpOf({
          'CF-Connecting-IP': '198.51.100.21',
          [CLIENT_IP_HEADER]: '203.0.113.1',
        }),
      ).toBe('198.51.100.21');
      expect(await clientIpOf({ 'CF-Connecting-IP': '198.51.100.22' })).toBe(
        '198.51.100.22',
      );
    });
    it('does not take a repeated CF-Connecting-IP as the visitor', async () => {
      for (const visitors of [
        ['198.51.100.23', '198.51.100.24'],
        ['198.51.100.25', '198.51.100.25'],
      ]) {
        expect(await clientIpWithRepeatedHeader(visitors)).toMatch(
          /(^|:)127\.0\.0\.1$/,
        );
      }
    });
  });

  // Last: it fills the shared credential-failure bucket of the loopback peer.
  describe('from any other peer (forged CF-Connecting-IP)', () => {
    beforeAll(() => {
      process.env.TRUSTED_EDGE_PROXY_IPS = OTHER_PEER;
    });

    it('keys the throttler on the peer', async () => {
      const statuses: number[] = [];
      for (const forged of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
        statuses.push(
          await status('/probe/public-forged', { 'CF-Connecting-IP': forged }),
        );
      }
      expect(statuses).toEqual([200, 200, 429]);
    });

    it('hands better-auth the peer address', async () => {
      expect(await clientIpOf({ 'CF-Connecting-IP': '198.51.100.31' })).toMatch(
        /(^|:)127\.0\.0\.1$/,
      );
    });

    it('keys the credential-failure limiter on the peer', async () => {
      const statuses: number[] = [];
      for (let i = 0; i <= N; i += 1) {
        statuses.push(await badKey(`198.51.100.${i + 40}`, i));
      }
      expect(statuses.slice(0, N)).toEqual(Array(N).fill(401));
      expect(statuses[N]).toBe(429);
    });
  });
});

import type { INestApplication } from '@nestjs/common';
import { VersioningType } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';

const mockCheckApiReadiness = jest.fn();
jest.mock('./readiness', () => ({
  checkApiReadiness: (...args: unknown[]) => mockCheckApiReadiness(...args),
}));

import { HealthController } from './health.controller';

describe('HealthController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => mockCheckApiReadiness.mockReset());

  it('is public, so the ALB and smoke tests need no credentials', () => {
    const reflector = new Reflector();
    expect(reflector.get<boolean>(IS_PUBLIC_KEY, HealthController)).toBe(true);
  });

  it('GET /v1/health answers liveness without touching the database', async () => {
    const response = await request(app.getHttpServer() as App).get(
      '/v1/health',
    );
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(mockCheckApiReadiness).not.toHaveBeenCalled();
  });

  it('GET /v1/health/ready answers 200 when the database is ready', async () => {
    mockCheckApiReadiness.mockResolvedValue({ status: 'ok' });
    const response = await request(app.getHttpServer() as App).get(
      '/v1/health/ready',
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it.each(['tls_SELF_SIGNED_CERT_IN_CHAIN', 'P1001', 'timeout', 'unknown'])(
    'GET /v1/health/ready answers 503 with reason %s and nothing else',
    async (reason) => {
      mockCheckApiReadiness.mockResolvedValue({
        status: 'unavailable',
        reason,
      });
      const response = await request(app.getHttpServer() as App).get(
        '/v1/health/ready',
      );
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ status: 'unavailable', reason });
    },
  );
});

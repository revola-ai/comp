import type { INestApplication } from '@nestjs/common';
import { Controller, Get } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  CREDENTIAL_STORE_RETRY_AFTER_SECONDS,
  CREDENTIAL_STORE_UNAVAILABLE,
  credentialStoreUnavailable,
} from './credential-store-error';
import { CredentialStoreUnavailableFilter } from './credential-store-unavailable.filter';

@Controller({ path: 'probe' })
class ProbeController {
  @Get('outage')
  outage() {
    throw credentialStoreUnavailable();
  }
}

describe('CredentialStoreUnavailableFilter', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: APP_FILTER, useClass: CredentialStoreUnavailableFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(() => app.close());

  it('answers 503 with Retry-After and the named reason', async () => {
    const response = await request(app.getHttpServer() as App).get(
      '/probe/outage',
    );
    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe(
      String(CREDENTIAL_STORE_RETRY_AFTER_SECONDS),
    );
    expect(response.body).toMatchObject({
      reason: CREDENTIAL_STORE_UNAVAILABLE,
    });
  });

  it('is registered globally by AuthModule', () => {
    const source = readFileSync(resolve(__dirname, 'auth.module.ts'), 'utf8');
    expect(source).toMatch(
      /provide: APP_FILTER,\s*useClass: CredentialStoreUnavailableFilter/,
    );
  });
});

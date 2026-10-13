import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ReadinessResult } from '@trycompai/db';

// better-auth answers any failure inside getSession with FAILED_TO_GET_SESSION
// (500), an outage or not. With its bearer plugin, `Authorization: Bearer
// <anything>` plus a malformed session_data cookie produces it without any
// database trouble, so a client could make every bearer guess answer 503 and
// get its attempt back (no rate limit). The guards now confirm an outage with
// a short database probe: the database answering means an invalid session
// (401, attempt kept); only a failing probe means 503. The real better-auth
// runs (loaded by Node, see test/native-module.ts) with an in-memory store.
function mockNativeModule(id: string): unknown {
  const loader: typeof import('../../test/native-module') = jest.requireActual(
    '../../test/native-module',
  );
  return loader.nativeModule(id);
}
jest.mock('better-auth', () => mockNativeModule('better-auth'));
jest.mock('better-auth/plugins', () => mockNativeModule('better-auth/plugins'));
jest.mock('better-auth/adapters/memory', () =>
  mockNativeModule('better-auth/adapters/memory'),
);
jest.mock('./auth.server', () => {
  const { betterAuth } =
    jest.requireMock<typeof import('better-auth')>('better-auth');
  const { memoryAdapter } = jest.requireMock<
    typeof import('better-auth/adapters/memory')
  >('better-auth/adapters/memory');
  const { bearer } = jest.requireMock<typeof import('better-auth/plugins')>(
    'better-auth/plugins',
  );
  return {
    auth: betterAuth({
      baseURL: 'http://localhost:3333',
      secret: 'test-secret-'.repeat(4),
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
      logger: { disabled: true },
      plugins: [bearer()],
    }),
  };
});
const mockReadiness = jest.fn<Promise<ReadinessResult>, []>();
jest.mock('../health/readiness', () => ({
  checkApiReadiness: () => mockReadiness(),
}));
jest.mock('@db', () => ({ db: {} }));
jest.mock('@trycompai/auth', () => ({
  statement: {},
  BUILT_IN_ROLE_PERMISSIONS: {},
}));

import { AuthFailureLimiter } from '../throttle/auth-failure-limiter';
import { ApiKeyService } from './api-key.service';
import { auth } from './auth.server';
import { CREDENTIAL_STORE_UNAVAILABLE } from './credential-store-error';
import { HybridAuthGuard } from './hybrid-auth.guard';
import { PlatformAdminGuard } from './platform-admin.guard';

const MALFORMED = {
  authorization: 'Bearer guessed-token',
  cookie: 'better-auth.session_data=%%%',
};

function contextWith(headers: Record<string, string>): ExecutionContext {
  const request = { headers };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: jest.fn() }),
    }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

async function statusOf(run: () => Promise<unknown>): Promise<HttpException> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

/** A limiter whose refunds are counted. */
function countingLimiter() {
  const limiter = new AuthFailureLimiter();
  const reserve = limiter.reserve.bind(limiter);
  const refunds = jest.fn();
  jest.spyOn(limiter, 'reserve').mockImplementation((args) => {
    const reservation = reserve(args);
    if (!reservation.granted) return reservation;
    return {
      ...reservation,
      refund: () => {
        refunds();
        reservation.refund();
      },
    };
  });
  return { limiter, refunds };
}

describe('a FAILED_TO_GET_SESSION from a malformed cookie', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockReadiness.mockReset();
  });

  it('is what the real better-auth throws, with no database failure', async () => {
    await expect(
      auth.api.getSession({ headers: new Headers(MALFORMED) }),
    ).rejects.toMatchObject({
      status: 'INTERNAL_SERVER_ERROR',
      body: { code: 'FAILED_TO_GET_SESSION' },
    });
  });

  describe.each([
    [
      'HybridAuthGuard',
      (limiter: AuthFailureLimiter) => {
        const reflector = new Reflector();
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
        return new HybridAuthGuard(new ApiKeyService(), reflector, limiter);
      },
    ],
    [
      'PlatformAdminGuard',
      (limiter: AuthFailureLimiter) => new PlatformAdminGuard(limiter),
    ],
  ])('%s', (_name, guardWith) => {
    it('answers 401 and keeps the attempt when the database answers', async () => {
      mockReadiness.mockResolvedValue({ status: 'ok' });
      const { limiter, refunds } = countingLimiter();
      const error = await statusOf(() =>
        guardWith(limiter).canActivate(contextWith(MALFORMED)),
      );
      expect(error.getStatus()).toBe(401);
      expect(mockReadiness).toHaveBeenCalledTimes(1);
      expect(refunds).not.toHaveBeenCalled();
    });

    it('answers 503 and gives the attempt back when the probe fails', async () => {
      mockReadiness.mockResolvedValue({
        status: 'unavailable',
        reason: 'timeout',
      });
      const { limiter, refunds } = countingLimiter();
      const error = await statusOf(() =>
        guardWith(limiter).canActivate(contextWith(MALFORMED)),
      );
      expect(error.getStatus()).toBe(503);
      expect(JSON.stringify(error.getResponse())).toContain(
        CREDENTIAL_STORE_UNAVAILABLE,
      );
      expect(refunds).toHaveBeenCalledTimes(1);
    });
  });
});

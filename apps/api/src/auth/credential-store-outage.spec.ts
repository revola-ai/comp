import {
  ExecutionContext,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// A database outage while checking a credential is the server's failure, not
// the caller's: it answers 503 with a named reason, never 401, which would
// log browser sessions out and tell clients their credential is wrong.
const mockGetSession = jest.fn();
const mockGetMcpSession = jest.fn();
jest.mock('./auth.server', () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getMcpSession: (...args: unknown[]) => mockGetMcpSession(...args),
    },
  },
}));
const mockApiKeyFindMany = jest.fn();
const mockOrgFindUnique = jest.fn();
const mockMemberFindFirst = jest.fn();
jest.mock('@db', () => ({
  db: {
    apiKey: {
      findMany: (...args: unknown[]) => mockApiKeyFindMany(...args),
      update: jest.fn(),
    },
    organization: {
      findUnique: (...args: unknown[]) => mockOrgFindUnique(...args),
    },
    member: {
      findFirst: (...args: unknown[]) => mockMemberFindFirst(...args),
    },
  },
}));
jest.mock('@trycompai/auth', () => ({
  statement: {},
  BUILT_IN_ROLE_PERMISSIONS: {},
}));
// The database probe that confirms a FAILED_TO_GET_SESSION outage
// (session-store-outage.ts) fails here, as it would during an outage.
jest.mock('../health/readiness', () => ({
  checkApiReadiness: () =>
    Promise.resolve({ status: 'unavailable', reason: 'P1001' }),
}));
jest.mock('./service-token.config', () => ({
  resolveServiceByToken: () => ({ definition: { name: 'portal' } }),
}));

import {
  betterAuthApiError,
  failedToGetSessionError,
} from '../../test/better-auth-errors';
import { ApiKeyService } from './api-key.service';
import {
  CREDENTIAL_STORE_UNAVAILABLE,
  isCredentialStoreFailure,
  isSessionLookupFailure,
} from './credential-store-error';
import { AuthFailureLimiter } from '../throttle/auth-failure-limiter';
import { HybridAuthGuard } from './hybrid-auth.guard';

function prismaOutage(): Error {
  const error = new Error("Can't reach database server at db.internal:5432");
  error.name = 'PrismaClientInitializationError';
  return error;
}

async function failureOf(run: () => Promise<unknown>): Promise<HttpException> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

function expectOutage(error: HttpException): void {
  expect(error.getStatus()).toBe(503);
  const body = JSON.stringify(error.getResponse());
  expect(body).toContain(CREDENTIAL_STORE_UNAVAILABLE);
  expect(body).not.toContain('db.internal');
}

describe('credential validation during a database outage', () => {
  let guard: HybridAuthGuard;

  function contextWith(headers: Record<string, string>): ExecutionContext {
    const request = { headers };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as unknown as ExecutionContext;
  }

  const savedEnv = { ...process.env };

  afterAll(() => {
    process.env = savedEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMcpSession.mockResolvedValue(null);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    guard = new HybridAuthGuard(
      new ApiKeyService(),
      reflector,
      new AuthFailureLimiter(),
    );
  });

  it('ApiKeyService.validateApiKey throws 503 instead of answering "invalid key"', async () => {
    mockApiKeyFindMany.mockRejectedValue(prismaOutage());
    expectOutage(
      await failureOf(() =>
        new ApiKeyService().validateApiKey(`comp_${'ab'.repeat(32)}`),
      ),
    );
  });

  it('an API-key request answers 503', async () => {
    mockApiKeyFindMany.mockRejectedValue(prismaOutage());
    expectOutage(
      await failureOf(() =>
        guard.canActivate(contextWith({ 'x-api-key': 'comp_x' })),
      ),
    );
  });

  it('a service-token request answers 503 when the organization lookup fails', async () => {
    mockOrgFindUnique.mockRejectedValue(prismaOutage());
    expectOutage(
      await failureOf(() =>
        guard.canActivate(
          contextWith({ 'x-service-token': 't', 'x-organization-id': 'org_1' }),
        ),
      ),
    );
  });

  // better-auth's getSession catches the store failure and throws its own
  // APIError (FAILED_TO_GET_SESSION, status 500) without the cause.
  it('a session request answers 503 when the session store is unreachable', async () => {
    mockGetSession.mockRejectedValue(failedToGetSessionError());
    expectOutage(
      await failureOf(() =>
        guard.canActivate(contextWith({ cookie: 'session=abc' })),
      ),
    );
  });

  it('a bearer request answers 503 when the session store is unreachable', async () => {
    mockGetSession.mockRejectedValue(failedToGetSessionError());
    expectOutage(
      await failureOf(() =>
        guard.canActivate(contextWith({ authorization: 'Bearer abc' })),
      ),
    );
  });

  it('a session lookup that fails for another reason still answers 401', async () => {
    mockGetSession.mockRejectedValue(new Error('malformed session token'));
    await expect(
      guard.canActivate(contextWith({ cookie: 'session=abc' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('a better-auth APIError with another code still answers 401', async () => {
    mockGetSession.mockRejectedValue(
      betterAuthApiError({ status: 'UNAUTHORIZED', code: 'INVALID_TOKEN' }),
    );
    await expect(
      guard.canActivate(contextWith({ cookie: 'session=abc' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('an MCP OAuth token lookup answers 503 when the token store is unreachable', async () => {
    Object.assign(process.env, {
      GRAM_OAUTH_CLIENT_ID: 'gram-client-id',
      GRAM_OAUTH_CLIENT_SECRET: 'gram-client-secret',
      GRAM_OAUTH_REDIRECT_URI: 'https://gram.example/callback',
    });
    mockGetSession.mockResolvedValue(null);
    mockGetMcpSession.mockRejectedValue(prismaOutage());
    expectOutage(
      await failureOf(() =>
        guard.canActivate(contextWith({ authorization: 'Bearer mcp' })),
      ),
    );
  });

  it('an MCP OAuth token lookup failing for another reason answers 401', async () => {
    mockGetSession.mockResolvedValue(null);
    mockGetMcpSession.mockRejectedValue(new TypeError('unexpected'));
    await expect(
      guard.canActivate(contextWith({ authorization: 'Bearer mcp' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('validateApiKey rethrows an error that is not a store failure (a bug stays a bug)', async () => {
    const bug = new TypeError('cannot read properties of undefined');
    mockApiKeyFindMany.mockRejectedValue(bug);
    await expect(
      new ApiKeyService().validateApiKey(`comp_${'ab'.repeat(32)}`),
    ).rejects.toBe(bug);
  });

  it('a service-token request answers 503 when the x-user-id member lookup fails', async () => {
    mockOrgFindUnique.mockResolvedValue({ id: 'org_1' });
    mockMemberFindFirst.mockRejectedValue(prismaOutage());
    expectOutage(
      await failureOf(() =>
        guard.canActivate(
          contextWith({
            'x-service-token': 't',
            'x-organization-id': 'org_1',
            'x-user-id': 'usr_1',
          }),
        ),
      ),
    );
  });

  it('a service-token organization lookup failing for another reason is not a 503', async () => {
    const bug = new TypeError('unexpected');
    mockOrgFindUnique.mockRejectedValue(bug);
    await expect(
      guard.canActivate(
        contextWith({ 'x-service-token': 't', 'x-organization-id': 'org_1' }),
      ),
    ).rejects.toBe(bug);
  });
});

describe('isCredentialStoreFailure and better-auth errors', () => {
  // A malformed cookie produces it too, so it is confirmed by a database
  // probe before it counts (session-store-outage.spec.ts).
  it('treats the error getSession throws on any lookup failure as ambiguous', () => {
    expect(isCredentialStoreFailure(failedToGetSessionError())).toBe(false);
    expect(isSessionLookupFailure(failedToGetSessionError())).toBe(true);
  });

  it('does not match other better-auth API errors', () => {
    expect(
      isCredentialStoreFailure(
        betterAuthApiError({ status: 'UNAUTHORIZED', code: 'INVALID_TOKEN' }),
      ),
    ).toBe(false);
    expect(
      isCredentialStoreFailure(
        betterAuthApiError({
          status: 'INTERNAL_SERVER_ERROR',
          code: 'FAILED_TO_CREATE_SESSION',
        }),
      ),
    ).toBe(false);
    expect(
      isCredentialStoreFailure(
        betterAuthApiError({
          status: 'BAD_REQUEST',
          code: 'FAILED_TO_GET_SESSION',
        }),
      ),
    ).toBe(false);
  });
});

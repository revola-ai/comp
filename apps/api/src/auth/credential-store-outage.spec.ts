import {
  ExecutionContext,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// A database outage while checking a credential is the server's failure, not
// the caller's: it answers 503 with a named reason (and the pre-auth limiter
// refunds the slot), never 401, which would count against the caller's IP
// and log browser sessions out.
const mockGetSession = jest.fn();
jest.mock('./auth.server', () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getMcpSession: jest.fn().mockResolvedValue(null),
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
jest.mock('./service-token.config', () => ({
  resolveServiceByToken: () => ({ definition: { name: 'portal' } }),
}));

import { ApiKeyService } from './api-key.service';
import { CREDENTIAL_STORE_UNAVAILABLE } from './credential-store-error';
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

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    guard = new HybridAuthGuard(new ApiKeyService(), reflector);
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

  it('a session request answers 503 when the session store is unreachable', async () => {
    mockGetSession.mockRejectedValue(
      new Error('session lookup failed', { cause: prismaOutage() }),
    );
    expectOutage(
      await failureOf(() =>
        guard.canActivate(contextWith({ cookie: 'session=abc' })),
      ),
    );
  });

  it('a session lookup that fails for another reason still answers 401', async () => {
    mockGetSession.mockRejectedValue(new Error('malformed session token'));
    await expect(
      guard.canActivate(contextWith({ cookie: 'session=abc' })),
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

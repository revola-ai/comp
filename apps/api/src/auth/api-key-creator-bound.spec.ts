import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// A personal API key acts for its creator, so at every use its scopes are
// cut to what the creator's roles grant now (built-in roles from the real
// role table on the real better-auth access control, custom roles from
// organization_role). Role changes no longer revoke keys: a promotion keeps
// the key working, a demotion makes the scopes outside the new role fail
// (403) without revoking it, and a custom-role edit applies at once.
function mockNativeModule(id: string): unknown {
  const loader: typeof import('../../test/native-module') = jest.requireActual(
    '../../test/native-module',
  );
  return loader.nativeModule(id);
}
jest.mock('better-auth/plugins/access', () =>
  mockNativeModule('better-auth/plugins/access'),
);
jest.mock('better-auth/plugins/organization/access', () =>
  mockNativeModule('better-auth/plugins/organization/access'),
);
jest.mock('@trycompai/auth', () =>
  jest.requireActual('../../../../packages/auth/src/permissions'),
);
jest.mock('./auth.server', () => ({ auth: { api: {} } }));

type Creator = { isActive: boolean; deactivated: boolean; role: string };
const mockKey = {
  organizationOwned: false,
  createdByMemberId: 'mem_1' as string | null,
  legacyCreatorless: false,
  scopes: [] as string[],
  creator: { isActive: true, deactivated: false, role: 'admin' } as Creator,
};
let mockCustomRoles: Record<string, Record<string, string[]>> = {};
const mockKeyUpdate = jest.fn();
jest.mock('@db', () => {
  const { hashApiKey } =
    jest.requireActual<typeof import('./api-key-lookup')>('./api-key-lookup');
  return {
    db: {
      apiKey: {
        findMany: () =>
          Promise.resolve([
            {
              id: 'apk_1',
              name: 'CI',
              key: hashApiKey({ apiKey: `comp_${'ab'.repeat(32)}`, salt: 's' }),
              salt: 's',
              organizationId: 'org_1',
              scopes: mockKey.scopes,
              createdByMemberId: mockKey.createdByMemberId,
              organizationOwned: mockKey.organizationOwned,
              legacyCreatorless: mockKey.legacyCreatorless,
              createdBy: mockKey.createdByMemberId ? mockKey.creator : null,
            },
          ]),
        update: (...args: unknown[]) => mockKeyUpdate(...args),
      },
      organizationRole: {
        findMany: ({ where }: { where: { name: { in: string[] } } }) =>
          Promise.resolve(
            where.name.in
              .filter((name) => mockCustomRoles[name])
              .map((name) => ({ permissions: mockCustomRoles[name] })),
          ),
      },
    },
  };
});

import { authenticateApiKey } from './api-key-auth';
import { ApiKeyService } from './api-key.service';
import { PERMISSIONS_KEY, PermissionGuard } from './permission.guard';
import type { AuthenticatedRequest } from './types';

const KEY = `comp_${'ab'.repeat(32)}`;

/** Authenticates KEY and runs PermissionGuard for `resource:action`. */
async function use(scope: string): Promise<string> {
  const request = { headers: {} } as AuthenticatedRequest;
  await authenticateApiKey({
    request,
    header: KEY,
    apiKeyService: new ApiKeyService(),
    takeAttempt: () => () => undefined,
  });
  const [resource, action] = scope.split(':');
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key) =>
      key === PERMISSIONS_KEY ? [{ resource, actions: [action] }] : undefined,
    );
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
  try {
    await new PermissionGuard(reflector).canActivate(context);
    return 'allowed';
  } catch (error) {
    if (error instanceof ForbiddenException) return error.message;
    throw error;
  }
}

const revoked = () =>
  mockKeyUpdate.mock.calls.some(
    ([args]: [{ data: Record<string, unknown> }]) => 'isActive' in args.data,
  );

describe('personal API keys are bounded by their creator current permissions', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockKeyUpdate.mockReset();
    mockCustomRoles = {};
    Object.assign(mockKey, {
      organizationOwned: false,
      createdByMemberId: 'mem_1',
      legacyCreatorless: false,
      scopes: ['risk:read', 'risk:update', 'vendor:read'],
      creator: { isActive: true, deactivated: false, role: 'admin' },
    });
  });

  it('a promotion (admin to owner) keeps the key working', async () => {
    mockKey.creator.role = 'owner';
    expect(await use('risk:update')).toBe('allowed');
    expect(await use('vendor:read')).toBe('allowed');
  });

  it('a demotion makes out-of-role scopes fail (403) without revoking the key', async () => {
    mockKey.creator.role = 'auditor';
    expect(await use('risk:read')).toBe('allowed');
    expect(await use('risk:update')).toMatch(
      /creator no longer holds risk:update/,
    );
    expect(revoked()).toBe(false);
    mockKey.creator.role = 'admin';
    expect(await use('risk:update')).toBe('allowed');
  });

  it('a scope the key never had is refused as before', async () => {
    expect(await use('vendor:update')).toBe(
      'API key lacks required permission scope',
    );
  });

  it('a creator with no remaining overlap gets the creator message, not "regenerate"', async () => {
    mockKey.creator.role = 'employee';
    expect(await use('risk:read')).toMatch(/creator no longer holds risk:read/);
  });

  it('a custom-role permission edit takes effect on the next request', async () => {
    mockKey.creator.role = 'ci-bot';
    mockCustomRoles = { 'ci-bot': { risk: ['read', 'update'] } };
    expect(await use('risk:update')).toBe('allowed');
    mockCustomRoles = { 'ci-bot': { risk: ['read'] } };
    expect(await use('risk:update')).toMatch(/creator no longer holds/);
    expect(await use('risk:read')).toBe('allowed');
  });

  it('roles are a union, also across built-in and custom roles', async () => {
    mockKey.creator.role = 'employee, ci-bot';
    mockCustomRoles = { 'ci-bot': { risk: ['read', 'update'] } };
    expect(await use('risk:update')).toBe('allowed');
  });

  it('organization-owned and legacy creatorless keys are not bounded by a member', async () => {
    mockKey.creator.role = 'employee';
    mockKey.organizationOwned = true;
    expect(await use('risk:update')).toBe('allowed');
    Object.assign(mockKey, {
      organizationOwned: false,
      createdByMemberId: null,
      legacyCreatorless: true,
    });
    expect(await use('risk:update')).toBe('allowed');
  });
});

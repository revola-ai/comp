// GET api-keys/available-scopes feeds the web app's "Full Access" preset, so it
// must list exactly the scopes the caller may grant: otherwise an owner (whose
// built-in role holds only finding:read and finding:update) is refused the
// default create. The real role table (packages/auth, on the real better-auth
// access control, loaded by Node: see test/native-module.ts) and the real
// scope list are used; only the custom-role lookup is a mock.
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
// The role table itself, without the package index (which loads the server).
jest.mock('@trycompai/auth', () =>
  jest.requireActual('../../../../packages/auth/src/permissions'),
);
const mockOrganizationRoleFindMany = jest.fn();
jest.mock('@db', () => ({
  db: {
    organizationRole: {
      findMany: (...args: unknown[]) => mockOrganizationRoleFindMany(...args),
    },
  },
}));
jest.mock('../auth/auth.server', () => ({
  auth: { api: { getSession: jest.fn() } },
}));

import { BUILT_IN_ROLE_PERMISSIONS } from '@trycompai/auth';
import { ApiKeyService } from '../auth/api-key.service';
import type { AuthContext } from '../auth/types';
import { OrganizationApiKeysController } from './organization-api-keys.controller';
import type { OrganizationService } from './organization.service';

const ORG = 'org_1';
const member = (roles: string[]): AuthContext => ({
  organizationId: ORG,
  authType: 'session',
  isApiKey: false,
  isPlatformAdmin: false,
  userId: 'usr_1',
  memberId: 'mem_1',
  userEmail: 'm@example.com',
  userRoles: roles,
});

describe('available scopes are the scopes the caller can grant', () => {
  const service = new ApiKeyService();
  const create = jest.spyOn(service, 'create').mockImplementation(({ name }) =>
    Promise.resolve({
      id: 'apk_1',
      name,
      key: 'comp_x',
      createdAt: '2026-10-13T00:00:00.000Z',
      expiresAt: null,
    }),
  );
  const controller = new OrganizationApiKeysController(
    {} as OrganizationService,
    service,
  );

  const available = async (caller: AuthContext) =>
    (await controller.getAvailableScopes(caller)).data;
  const createWith = (caller: AuthContext, scopes: string[]) =>
    controller.createApiKey(ORG, caller, { name: 'CI', scopes });
  const roleScopes = (role: string) =>
    Object.entries(BUILT_IN_ROLE_PERMISSIONS[role]).flatMap(
      ([resource, actions]) => actions.map((action) => `${resource}:${action}`),
    );

  beforeEach(() => {
    create.mockClear();
    mockOrganizationRoleFindMany.mockReset();
    mockOrganizationRoleFindMany.mockResolvedValue([]);
  });

  it.each(['owner', 'admin'])(
    'a built-in %s gets its role scopes, and the Full Access create succeeds',
    async (role) => {
      const caller = member([role]);
      const scopes = await available(caller);
      const all = service.getAvailableScopes();
      expect(scopes).toEqual(
        all.filter((scope) => roleScopes(role).includes(scope)),
      );
      expect(scopes).toContain('finding:update');
      expect(scopes).not.toContain('finding:create');
      await expect(createWith(caller, scopes)).resolves.toMatchObject({
        id: 'apk_1',
      });
      expect(create).toHaveBeenCalledTimes(1);
      await expect(
        createWith(caller, [...scopes, 'finding:create']),
      ).rejects.toThrow(/finding:create/);
      expect(create).toHaveBeenCalledTimes(1);
    },
  );

  it('a custom role gets exactly its permissions', async () => {
    mockOrganizationRoleFindMany.mockResolvedValue([
      { permissions: { apiKey: ['create', 'read'], vendor: ['read'] } },
    ]);
    const caller = member(['ci-bot']);
    const scopes = await available(caller);
    expect(scopes).toEqual(['vendor:read', 'apiKey:create', 'apiKey:read']);
    await expect(createWith(caller, scopes)).resolves.toBeDefined();
    await expect(createWith(caller, ['risk:read'])).rejects.toThrow(
      /risk:read/,
    );
  });

  it('an API key gets the scopes it holds, a full-access key all of them', async () => {
    const all = service.getAvailableScopes();
    const scoped: AuthContext = {
      organizationId: ORG,
      authType: 'api-key',
      isApiKey: true,
      isPlatformAdmin: false,
      userRoles: null,
      apiKeyScopes: ['apiKey:read', 'risk:read', 'not:a-scope'],
    };
    expect(await available(scoped)).toEqual(['risk:read', 'apiKey:read']);
    expect(await available({ ...scoped, apiKeyScopes: all })).toEqual(all);
  });

  it('a platform admin gets only what their membership roles grant, as key validation allows', async () => {
    const caller = { ...member([]), isPlatformAdmin: true };
    expect(await available(caller)).toEqual([]);
  });
});

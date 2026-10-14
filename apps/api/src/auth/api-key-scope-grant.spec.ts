const mockOrganizationRoleFindMany = jest.fn();
jest.mock('@db', () => ({
  db: {
    organizationRole: {
      findMany: (...args: unknown[]) => mockOrganizationRoleFindMany(...args),
    },
  },
}));
jest.mock('@trycompai/auth', () => ({
  BUILT_IN_ROLE_PERMISSIONS: {
    admin: { apiKey: ['create', 'read'], risk: ['read', 'update'] },
    auditor: { risk: ['read'], vendor: ['read'] },
  },
}));

import { ForbiddenException } from '@nestjs/common';
import {
  assertScopesGrantable,
  type ScopeGrantCaller,
} from './api-key-scope-grant';

// A caller may only hand a new key scopes it holds itself; otherwise anyone
// with apiKey:create could mint a key with more access than they have.
describe('assertScopesGrantable', () => {
  const AVAILABLE = [
    'apiKey:create',
    'risk:read',
    'risk:update',
    'vendor:read',
  ];
  const ORG = 'org_1';

  beforeEach(() => {
    mockOrganizationRoleFindMany.mockReset();
    mockOrganizationRoleFindMany.mockResolvedValue([]);
  });

  const grant = (
    caller: Omit<ScopeGrantCaller, 'organizationId'>,
    requestedScopes: string[],
  ) =>
    assertScopesGrantable({
      caller: { organizationId: ORG, ...caller },
      requestedScopes,
      availableScopes: AVAILABLE,
    });

  describe('API-key callers', () => {
    it('may grant a subset of their own scopes', async () => {
      await expect(
        grant(
          { authType: 'api-key', apiKeyScopes: ['apiKey:create', 'risk:read'] },
          ['risk:read'],
        ),
      ).resolves.toBeUndefined();
    });

    it('are refused a scope they do not hold, which is named', async () => {
      const result = grant(
        { authType: 'api-key', apiKeyScopes: ['apiKey:create'] },
        ['apiKey:create', 'risk:update'],
      );
      await expect(result).rejects.toThrow(ForbiddenException);
      await expect(result).rejects.toThrow(/risk:update/);
    });

    it('with every available scope may grant any', async () => {
      await expect(
        grant({ authType: 'api-key', apiKeyScopes: [...AVAILABLE] }, [
          'vendor:read',
          'risk:update',
        ]),
      ).resolves.toBeUndefined();
    });

    it('with no recorded scopes hold none (fail closed)', async () => {
      for (const apiKeyScopes of [[], undefined]) {
        await expect(
          grant({ authType: 'api-key', apiKeyScopes }, ['risk:read']),
        ).rejects.toThrow(ForbiddenException);
      }
    });
  });

  describe('session callers', () => {
    it('may grant scopes their built-in role holds', async () => {
      await expect(
        grant({ authType: 'session', userRoles: ['admin'] }, [
          'apiKey:create',
          'risk:update',
        ]),
      ).resolves.toBeUndefined();
    });

    it('are refused scopes beyond their role, which are named', async () => {
      const result = grant({ authType: 'session', userRoles: ['admin'] }, [
        'risk:read',
        'vendor:read',
      ]);
      await expect(result).rejects.toThrow(ForbiddenException);
      await expect(result).rejects.toThrow(/vendor:read/);
    });

    it('hold the union of comma-separated roles (untrimmed as stored)', async () => {
      await expect(
        grant({ authType: 'session', userRoles: ['admin', ' auditor'] }, [
          'risk:update',
          'vendor:read',
        ]),
      ).resolves.toBeUndefined();
    });

    it('with a custom role are bounded by that role permissions', async () => {
      mockOrganizationRoleFindMany.mockResolvedValue([
        {
          permissions: JSON.stringify({ apiKey: ['create'], vendor: ['read'] }),
        },
      ]);
      const caller = { authType: 'session' as const, userRoles: ['ci-bot'] };
      await expect(
        grant(caller, ['apiKey:create', 'vendor:read']),
      ).resolves.toBeUndefined();
      await expect(grant(caller, ['risk:read'])).rejects.toThrow(/risk:read/);
      expect(mockOrganizationRoleFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: ORG, name: { in: ['ci-bot'] } },
        }),
      );
    });

    it('with no roles hold nothing', async () => {
      await expect(
        grant({ authType: 'session', userRoles: null }, ['risk:read']),
      ).rejects.toThrow(ForbiddenException);
    });

    it('who are platform admins are bounded by their membership roles, as key validation is', async () => {
      await expect(
        grant(
          { authType: 'session', userRoles: null, isPlatformAdmin: true },
          ['risk:read'],
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('service callers', () => {
    it('are bounded by their service permissions', async () => {
      const trigger = { authType: 'service' as const, serviceName: 'trigger' };
      await expect(grant(trigger, ['risk:read'])).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        grant({ authType: 'service', serviceName: 'unknown' }, []),
      ).resolves.toBeUndefined();
      await expect(
        grant({ authType: 'service', serviceName: 'unknown' }, ['risk:read']),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

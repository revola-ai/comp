import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

// DELETE /v1/auth/invitations/:id through the real PermissionGuard. The session
// layer is faked: HybridAuthGuard is replaced by a guard that signs the caller
// into org_1 with the role named in the `role` cookie, and better-auth's
// hasPermission answers from the built-in role table in @trycompai/auth.

type Invitation = {
  id: string;
  organizationId: string;
  email: string;
  status: 'pending' | 'accepted' | 'canceled';
};
type Where = Partial<Invitation>;
type PermissionCheck = {
  headers: Headers;
  body: { permissions: Record<string, string[]> };
};

const ORG = 'org_1';
const rows: Invitation[] = [];
const matches = (row: Invitation, where: Where) =>
  Object.entries(where).every(
    ([field, value]) => row[field as keyof Invitation] === value,
  );

const mockFindFirst = jest.fn(({ where }: { where: Where }) =>
  Promise.resolve(rows.find((row) => matches(row, where)) ?? null),
);
const mockDelete = jest.fn(({ where }: { where: { id: string } }) => {
  const index = rows.findIndex((row) => row.id === where.id);
  if (index < 0)
    return Promise.reject(new Error('Record to delete does not exist.'));
  return Promise.resolve(rows.splice(index, 1)[0]);
});
const mockHasPermission = jest.fn();

jest.mock('@db', () => ({
  db: {
    invitation: {
      findFirst: (args: { where: Where }) => mockFindFirst(args),
      delete: (args: { where: { id: string } }) => mockDelete(args),
    },
  },
}));

jest.mock('./auth.server', () => ({
  auth: {
    api: {
      hasPermission: (check: PermissionCheck) => mockHasPermission(check),
    },
  },
}));

jest.mock('./hybrid-auth.guard', () => ({
  HybridAuthGuard: class implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest<{
        headers: Record<string, string | undefined>;
        organizationId?: string;
        authType?: string;
        userId?: string;
        userRoles?: string[];
      }>();
      const role = /(?:^|;\s*)role=([a-z]+)/.exec(
        req.headers.cookie ?? '',
      )?.[1];
      Object.assign(req, {
        organizationId: ORG,
        authType: 'session',
        userId: 'usr_1',
        userRoles: role ? [role] : [],
      });
      return true;
    }
  },
}));

// better-auth ships ESM that ts-jest does not load. Stub its entry points so
// @trycompai/auth evaluates the real role definitions (as in
// training/permissions-regression.spec.ts); every role names `member` itself.
jest.mock('better-auth', () => ({ betterAuth: jest.fn() }));
jest.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: jest.fn() }));
jest.mock('better-auth/plugins', () => ({}));
jest.mock('better-auth/plugins/access', () => ({
  createAccessControl: () => ({
    newRole: (statements: Record<string, readonly string[]>) => ({
      statements,
    }),
  }),
}));
jest.mock('better-auth/plugins/organization/access', () => ({
  defaultStatements: {},
  ownerAc: { statements: {} },
  adminAc: { statements: {} },
}));

import { BUILT_IN_ROLE_PERMISSIONS } from '@trycompai/auth';
import { AuthController } from './auth.controller';

const invitation = (
  overrides: Partial<Invitation> & { id: string },
): Invitation => ({
  organizationId: ORG,
  email: `${overrides.id}@example.com`,
  status: 'pending',
  ...overrides,
});

describe('DELETE /v1/auth/invitations/:id', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    rows.splice(
      0,
      rows.length,
      invitation({ id: 'inv_pending' }),
      invitation({ id: 'inv_accepted', status: 'accepted' }),
      invitation({ id: 'inv_other_org', organizationId: 'org_2' }),
    );
    mockHasPermission.mockImplementation(
      ({ headers, body }: PermissionCheck) => {
        const role =
          /role=([a-z]+)/.exec(headers.get('cookie') ?? '')?.[1] ?? '';
        const granted = BUILT_IN_ROLE_PERMISSIONS[role] ?? {};
        const success = Object.entries(body.permissions).every(
          ([resource, actions]) =>
            actions.every(
              (action) => granted[resource]?.includes(action) ?? false,
            ),
        );
        return Promise.resolve({ success });
      },
    );
  });

  const revoke = (id: string, role: string) =>
    request(app.getHttpServer() as App)
      .delete(`/v1/auth/invitations/${id}`)
      .set('Cookie', `role=${role}`);

  it('revokes a pending invitation of the caller organization', async () => {
    const response = await revoke('inv_pending', 'admin');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'inv_pending' } });
    expect(rows.map((row) => row.id)).not.toContain('inv_pending');
  });

  it.each([
    ['a missing invitation', 'inv_missing'],
    ['an accepted invitation', 'inv_accepted'],
    ["another organization's invitation", 'inv_other_org'],
  ])('answers 404 and deletes nothing for %s', async (_case, id) => {
    const before = rows.map((row) => row.id);

    const response = await revoke(id, 'admin');

    expect(response.status).toBe(404);
    expect(response.body).toEqual(
      expect.objectContaining({
        message: 'Invitation not found or already accepted.',
      }),
    );
    expect(mockDelete).not.toHaveBeenCalled();
    expect(rows.map((row) => row.id)).toEqual(before);
  });

  it('asks the permission check for member:delete', async () => {
    await revoke('inv_pending', 'admin');

    expect(mockHasPermission).toHaveBeenCalledTimes(1);
    expect(mockHasPermission.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({ permissions: { member: ['delete'] } }),
      }),
    );
  });

  it.each(['owner', 'admin'])('lets the %s role revoke', async (role) => {
    expect((await revoke('inv_pending', role)).status).toBe(200);
  });

  it.each(['auditor', 'employee', 'contractor'])(
    'refuses the %s role (no member:delete) before any lookup',
    async (role) => {
      const response = await revoke('inv_pending', role);

      expect(response.status).toBe(403);
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
      expect(rows.map((row) => row.id)).toContain('inv_pending');
    },
  );
});

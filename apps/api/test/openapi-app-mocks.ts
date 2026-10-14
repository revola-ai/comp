// The module mocks that let a spec boot the whole AppModule to build the
// OpenAPI document (openapi-docs.spec.ts, gen-openapi.spec.ts) with no
// database, Redis or ESM-only packages. jest.mock factories must sit in the
// spec, so each spec delegates to this file:
//
//   function mockOpenApiModule(id: string): unknown {
//     return jest
//       .requireActual<typeof import('../test/openapi-app-mocks')>(
//         '../test/openapi-app-mocks',
//       )
//       .openApiAppMock(id);
//   }
//   jest.mock('@db', () => mockOpenApiModule('@db'));
import { Module } from '@nestjs/common';

/** better-auth is ESM only; AuthModule only needs the instance to exist. */
function authServer() {
  return {
    auth: {
      api: {},
      handler: () => Promise.resolve(new Response(null, { status: 204 })),
      options: {},
    },
    getTrustedOrigins: () => [],
    isTrustedOrigin: () => Promise.resolve(false),
    isStaticTrustedOrigin: () => false,
  };
}

function betterAuthNest() {
  @Module({})
  class AuthModuleStub {
    static forRoot() {
      return {
        module: AuthModuleStub,
        imports: [],
        providers: [],
        exports: [],
      };
    }
  }
  return { AuthModule: AuthModuleStub };
}

/** @trycompai/auth resolves better-auth's ESM access plugin. */
function trycompaiAuth() {
  const emptyRole = { statements: {} };
  const roles = {
    owner: emptyRole,
    admin: emptyRole,
    auditor: emptyRole,
    employee: emptyRole,
    contractor: emptyRole,
  };
  return {
    ac: { newRole: () => emptyRole },
    statement: {},
    allRoles: roles,
    ...roles,
    ROLE_HIERARCHY: ['contractor', 'employee', 'auditor', 'admin', 'owner'],
    RESTRICTED_ROLES: ['employee', 'contractor'],
    PRIVILEGED_ROLES: ['owner', 'admin', 'auditor'],
    BUILT_IN_ROLE_PERMISSIONS: {},
    BUILT_IN_ROLE_OBLIGATIONS: {},
  };
}

/**
 * Keeps every Prisma enum from @prisma/client and replaces only the db
 * instance, so module-level enum references (IsEnum(CommentEntityType))
 * resolve.
 */
function database() {
  const prismaClient =
    jest.requireActual<typeof import('@prisma/client')>('@prisma/client');
  return {
    ...prismaClient,
    db: {
      $connect: jest.fn(),
      $disconnect: jest.fn(),
      organization: { findFirst: jest.fn(), findMany: jest.fn() },
      auditLog: { create: jest.fn() },
      trust: { findMany: jest.fn().mockResolvedValue([]) },
      dynamicIntegration: { findMany: jest.fn().mockResolvedValue([]) },
      apiKey: { findFirst: jest.fn() },
      session: { findFirst: jest.fn() },
      member: { findFirst: jest.fn() },
    },
  };
}

const MOCKS: Record<string, () => unknown> = {
  './auth/auth.server': authServer,
  '@thallesp/nestjs-better-auth': betterAuthNest,
  // @inference/tracing is ESM only, like better-auth.
  '@inference/tracing': () => ({ setup: jest.fn() }),
  '@inference/tracing/ai-sdk': () => ({
    createAISdkTelemetrySettings: jest.fn(() => ({})),
  }),
  'better-auth/plugins/access': () => ({
    createAccessControl: () => ({ newRole: () => ({}), statement: {} }),
  }),
  'better-auth/plugins/organization/access': () => ({
    defaultStatements: {},
    adminAc: {},
    ownerAc: {},
  }),
  '@trycompai/auth': trycompaiAuth,
  '@db': database,
  // No real Redis connections.
  '@upstash/redis': () => ({
    Redis: jest.fn().mockImplementation(() => ({
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    })),
  }),
};

export function openApiAppMock(id: string): unknown {
  const factory = MOCKS[id];
  if (!factory) throw new Error(`openapi-app-mocks has no mock for ${id}`);
  return factory();
}

/**
 * Environment the config factories (aws.config.ts, better-auth...) need at
 * module load. Applied before AppModule is imported.
 */
export const OPENAPI_APP_ENV = {
  SECRET_KEY: 'test-secret-key-at-least-16-chars',
  BASE_URL: 'http://localhost:3333',
  APP_AWS_ACCESS_KEY_ID: 'test-access-key-id',
  APP_AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
  APP_AWS_BUCKET_NAME: 'test-bucket',
  APP_AWS_REGION: 'us-east-1',
  MACED_API_KEY: 'mc_dev_test-openapi-gen',
};

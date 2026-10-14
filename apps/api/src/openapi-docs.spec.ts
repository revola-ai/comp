// Boots the whole AppModule with its database, Redis and ESM-only packages
// mocked (test/openapi-app-mocks.ts). jest.mock calls are hoisted above the
// imports; the environment is set before AppModule loads.
function mockOpenApiModule(id: string): unknown {
  return jest
    .requireActual<typeof import('../test/openapi-app-mocks')>(
      '../test/openapi-app-mocks',
    )
    .openApiAppMock(id);
}
jest.mock('./auth/auth.server', () => mockOpenApiModule('./auth/auth.server'));
jest.mock('@thallesp/nestjs-better-auth', () =>
  mockOpenApiModule('@thallesp/nestjs-better-auth'),
);
jest.mock('@inference/tracing', () => mockOpenApiModule('@inference/tracing'));
jest.mock('@inference/tracing/ai-sdk', () =>
  mockOpenApiModule('@inference/tracing/ai-sdk'),
);
jest.mock('better-auth/plugins/access', () =>
  mockOpenApiModule('better-auth/plugins/access'),
);
jest.mock('better-auth/plugins/organization/access', () =>
  mockOpenApiModule('better-auth/plugins/organization/access'),
);
jest.mock('@trycompai/auth', () => mockOpenApiModule('@trycompai/auth'));
jest.mock('@db', () => mockOpenApiModule('@db'));
jest.mock('@upstash/redis', () => mockOpenApiModule('@upstash/redis'));

Object.assign(
  process.env,
  jest.requireActual<typeof import('../test/openapi-app-mocks')>(
    '../test/openapi-app-mocks',
  ).OPENAPI_APP_ENV,
);

import { Test } from '@nestjs/testing';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { INestApplication, VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';
import {
  applyPublicOpenApiMetadata,
  PUBLIC_OPENAPI_DESCRIPTION,
  PUBLIC_OPENAPI_TIMEOUT_MS,
  PUBLIC_OPENAPI_TITLE,
  PUBLIC_SERVER_URL,
} from './openapi/public-docs-metadata';
import {
  KNOWN_PUBLIC_OPENAPI_ISSUES,
  sortPublicOpenApiIssues,
} from './openapi/public-docs-known-issues';
import { collectPublicOpenApiIssues } from './openapi/public-docs-quality';

describe('OpenAPI document', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();

    const config = new DocumentBuilder()
      .setTitle(PUBLIC_OPENAPI_TITLE)
      .setDescription(PUBLIC_OPENAPI_DESCRIPTION)
      .setVersion('1.0')
      .build();
    document = SwaggerModule.createDocument(app, config);
    applyPublicOpenApiMetadata(document);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('public metadata', () => {
    it('uses production API servers in the generated Mintlify spec', () => {
      expect(document.info.title).toBe(PUBLIC_OPENAPI_TITLE);
      expect(document.info.description).toBe(PUBLIC_OPENAPI_DESCRIPTION);
      expect(document.servers).toEqual([
        {
          url: PUBLIC_SERVER_URL,
          description: 'Production API Server',
        },
      ]);
    });

    it('bakes a finite default request timeout into the generated SDK + MCP server', () => {
      // Without x-speakeasy-timeout the generated request funcs use -1 ("no
      // timeout") and a hung upstream wedges the MCP connection forever.
      expect(
        (document as { 'x-speakeasy-timeout'?: number })['x-speakeasy-timeout'],
      ).toBe(PUBLIC_OPENAPI_TIMEOUT_MS);
    });

    // Exactly the committed known issues: a new one (a private surface
    // leaking into the spec, say) fails, and so does a fixed one until its
    // entry is deleted from openapi/public-docs-known-issues.ts.
    it('keeps the public spec free of issues beyond the committed known ones', () => {
      const issues = collectPublicOpenApiIssues(document);
      expect(sortPublicOpenApiIssues(issues)).toEqual(
        KNOWN_PUBLIC_OPENAPI_ISSUES,
      );
    });

    it('curates high-value API pages with operation-specific SEO copy', () => {
      expect(
        document.paths['/v1/questionnaire/parse/upload/token'],
      ).toBeUndefined();

      const upload = document.paths['/v1/questionnaire/parse/upload']?.post as
        | {
            summary?: string;
            description?: string;
            'x-mint'?: { href?: string; metadata?: { title?: string } };
          }
        | undefined;

      expect(upload?.summary).toBe('Auto-answer uploaded questionnaire');
      expect(upload?.description).toContain('approved organization evidence');
      expect(upload?.['x-mint']?.href).toBe(
        '/api-reference/questionnaire/upload-a-questionnaire-file-and-auto-answer-with-export',
      );

      const policies = document.paths['/v1/policies']?.get as
        | {
            summary?: string;
            description?: string;
            'x-mint'?: { metadata?: { title?: string } };
          }
        | undefined;

      expect(policies?.summary).toBe('List compliance policies');
      expect(policies?.description).toContain('SOC 2');
      expect(policies?.['x-mint']?.metadata?.title).toBe(
        'List compliance policies | Comp AI API',
      );
    });
  });

  // Guardrail against the regression in PR #2961: the Speakeasy mcp-typescript
  // generator DROPS a tool whenever an operation declares more than one security
  // scheme (it can no longer supply the credential from the server's global
  // config). Adding a second auth method (oauth2) to every endpoint silently
  // gutted ~300 of ~335 MCP tools. Rule: keep exactly ONE auth method in the
  // base spec; handle any extra auth (e.g. OAuth) at the hosting layer, never here.
  describe('MCP generator safety', () => {
    it('never declares more than one security scheme on any operation', () => {
      const offenders: string[] = [];

      for (const [routePath, methods] of Object.entries(document.paths)) {
        for (const [method, operation] of Object.entries(
          methods as Record<string, { security?: unknown }>,
        )) {
          const security = operation?.security;
          if (Array.isArray(security) && security.length > 1) {
            offenders.push(
              `${method.toUpperCase()} ${routePath} (${security.length} schemes)`,
            );
          }
        }
      }

      // If this fails: an operation has 2+ security schemes, which breaks the
      // Speakeasy MCP generator (it drops the tool). Move the extra auth to the
      // hosting layer instead of the base OpenAPI spec.
      expect(offenders).toEqual([]);
    });

    it('still gates protected operations with the API key', () => {
      const apiKeyOps = Object.values(document.paths)
        .flatMap((methods) =>
          Object.values(methods as Record<string, { security?: unknown }>),
        )
        .filter(
          (op) =>
            Array.isArray(op?.security) &&
            op.security.some(
              (req) => req && typeof req === 'object' && 'apikey' in req,
            ),
        );

      expect(apiKeyOps.length).toBeGreaterThan(0);
    });
  });

  // Guardrail against the CS-761 regression: two DTO classes were both named
  // `CreateVersionDto` — one in policies (optional sourceVersionId/changelog),
  // one in tasks/automations (REQUIRED version + scriptKey). They collided on
  // the OpenAPI component name, so the automations shape overwrote the policies
  // component. That made the create-policy-version MCP tool demand version +
  // scriptKey, which the policies endpoint's ValidationPipe (whitelist +
  // forbidNonWhitelisted) then rejected with 400 — no valid path through it.
  describe('create-policy-version tool schema', () => {
    type SchemaLike = {
      $ref?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };

    const resolveRequestBodyComponent = (
      routePath: string,
    ): { name: string; schema: SchemaLike } | undefined => {
      const operation = (
        document.paths[routePath] as
          { post?: { requestBody?: unknown } } | undefined
      )?.post;
      const bodySchema = (
        operation?.requestBody as
          | { content?: { 'application/json'?: { schema?: SchemaLike } } }
          | undefined
      )?.content?.['application/json']?.schema;
      const ref = bodySchema?.$ref;
      if (!ref) return undefined;
      const name = ref.replace('#/components/schemas/', '');
      const schema = (
        document.components?.schemas as Record<string, SchemaLike> | undefined
      )?.[name];
      if (!schema) return undefined;
      return { name, schema };
    };

    it('does not share an OpenAPI component with the automations create-version body', () => {
      // Root-cause guard: the two `CreateVersionDto` classes must resolve to
      // DISTINCT components, or one silently overwrites the other.
      const policy = resolveRequestBodyComponent('/v1/policies/{id}/versions');
      const automation = resolveRequestBodyComponent(
        '/v1/tasks/{taskId}/automations/{automationId}/versions',
      );

      expect(policy).toBeDefined();
      expect(automation).toBeDefined();
      expect(policy?.name).not.toBe(automation?.name);
    });

    it('exposes the optional policies shape, not the automations version/scriptKey fields', () => {
      const policy = resolveRequestBodyComponent('/v1/policies/{id}/versions');
      expect(policy).toBeDefined();

      const properties = policy?.schema.properties ?? {};
      const required = policy?.schema.required ?? [];

      // The policies endpoint accepts only these optional fields; the tool
      // schema must match so an MCP client can call it without being blocked.
      expect(Object.keys(properties)).toEqual(
        expect.arrayContaining(['sourceVersionId', 'changelog']),
      );
      // The automations-only fields must be absent — their presence (required)
      // is exactly what triggered the "property scriptKey should not exist" 400.
      expect(properties).not.toHaveProperty('scriptKey');
      expect(properties).not.toHaveProperty('version');
      expect(required).not.toContain('scriptKey');
      expect(required).not.toContain('version');
    });
  });
});

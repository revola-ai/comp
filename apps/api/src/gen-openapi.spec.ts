// Script-style Jest spec: generates packages/docs/openapi.json using the same
// mocks as openapi-docs.spec.ts (no live DB or env vars needed).
// Skipped by default to avoid side effects in CI.
// Run manually with: cd apps/api && GEN_OPENAPI=1 bunx jest src/gen-openapi.spec.ts

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

import path from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { INestApplication, VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';
import {
  applyPublicOpenApiMetadata,
  PUBLIC_OPENAPI_DESCRIPTION,
  PUBLIC_OPENAPI_TITLE,
  PUBLIC_SERVER_URL,
} from './openapi/public-docs-metadata';
import { collectPublicOpenApiIssues } from './openapi/public-docs-quality';

const shouldRun = process.env.GEN_OPENAPI === '1';
const maybeDescribe = shouldRun ? describe : describe.skip;

maybeDescribe('Generate openapi.json', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('writes openapi.json without excluded paths', () => {
    const config = new DocumentBuilder()
      .setTitle(PUBLIC_OPENAPI_TITLE)
      .setDescription(PUBLIC_OPENAPI_DESCRIPTION)
      .setVersion('1.0')
      .addApiKey(
        {
          type: 'apiKey',
          name: 'X-API-Key',
          in: 'header',
          description: 'API key for authentication',
        },
        'apikey',
      )
      .build();

    const document = SwaggerModule.createDocument(app, config);
    applyPublicOpenApiMetadata(document);

    const openapiPath = path.join(
      __dirname,
      '../../../packages/docs/openapi.json',
    );

    const docsDir = path.dirname(openapiPath);
    if (!existsSync(docsDir)) {
      mkdirSync(docsDir, { recursive: true });
    }

    writeFileSync(openapiPath, JSON.stringify(document, null, 2));
    console.log(`OpenAPI documentation written to ${openapiPath}`);

    expect(document.servers).toEqual([
      {
        url: PUBLIC_SERVER_URL,
        description: 'Production API Server',
      },
    ]);

    const issues = collectPublicOpenApiIssues(document);
    expect(issues.excludedPaths).toEqual([]);
    expect(issues.exposedTags).toEqual([]);
    expect(issues.sensitiveSchemaDetails).toEqual([]);
  });
});

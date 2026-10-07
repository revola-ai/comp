import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

// Guard: server, Trigger, email, Sentry and device-agent code must never name upstream
// Comp's hosts (trycomp.ai, trust.inc). Laptops share the production database and send
// real email, so a default such as `NEXT_PUBLIC_APP_URL ?? 'https://app.trycomp.ai'`
// hands recipients, addresses, record ids and tokens to upstream. Upstream merges that
// add one fail here; leave the link out instead (utils/public-url.ts).
//
// Only string literals and template parts are read, through the TypeScript AST, so
// comments are ignored and nothing that looks like a comment (`'/v1/*'`) can hide code.
// UPSTREAM_GUARD_ROOT points the scan at a scratch copy of the repository.

const REPO_ROOT =
  process.env.UPSTREAM_GUARD_ROOT ?? resolve(__dirname, '../../../..');
const ROOTS = [
  'apps/api/src',
  'packages/email/lib',
  'packages/email/emails',
  'packages/email/components',
  'apps/app/src/trigger',
  'apps/app/src/lib',
  'apps/app/src/app/api',
  'apps/app/src/app/unsubscribe',
  'apps/app/src/app/(app)/no-access',
  'apps/app/sentry.server.config.ts',
  'apps/app/sentry.edge.config.ts',
  'apps/app/src/instrumentation-client.ts',
  'apps/portal/sentry.server.config.ts',
  'apps/portal/sentry.edge.config.ts',
  'apps/portal/src/instrumentation-client.ts',
  'packages/device-agent/src',
  'packages/device-agent/electron.vite.config.ts',
  'packages/device-agent/electron-builder.config.js',
];
/**
 * Any host (or address) on an upstream domain, or upstream's Sentry ingest host, with
 * or without a scheme, any case.
 */
const UPSTREAM_HOST =
  /(?:https?:\/\/)?[a-z0-9._@-]*(?:trycomp\.ai|trust\.inc|o4509214247813120\.ingest(?:\.us)?\.sentry\.io)(?![a-z0-9-])/gi;
const SOURCE_FILE = /\.(tsx?|c?js)$/;
const TEST_FILE = /\.(spec|test)\.tsx?$/;

/** Upstream mentions allowed per file (lower case), and why they send nothing upstream. */
const ALLOWED: Record<string, { values: string[]; reason: string }> = {
  'apps/api/src/auth/origin-policy.ts': {
    values: [
      'https://app.trycomp.ai',
      'https://portal.trycomp.ai',
      'https://api.trycomp.ai',
      'https://app.staging.trycomp.ai',
      'https://portal.staging.trycomp.ai',
      'https://api.staging.trycomp.ai',
      'https://dev.trycomp.ai',
      'https://framework-editor.trycomp.ai',
      '.trycomp.ai',
      '.staging.trycomp.ai',
      '.trust.inc',
      'trust.inc',
    ],
    reason:
      'inbound trusted-origin defaults, skipped when SELF_HOSTED=true or AUTH_TRUSTED_ORIGINS is set',
  },
  'apps/api/src/auth/cookie-domain.ts': {
    values: [
      'staging.trycomp.ai',
      '.staging.trycomp.ai',
      'trycomp.ai',
      '.trycomp.ai',
    ],
    reason:
      'derives upstream cookie domains from upstream URLs; Revola sets AUTH_COOKIE_DOMAIN',
  },
  'apps/api/src/auth/auth.server.ts': {
    values: ['.staging.trycomp.ai'],
    reason: 'compares the cookie domain; sends nothing',
  },
  'apps/api/src/main.ts': {
    values: ['api.staging.trycomp.ai', 'api.trycomp.ai'],
    reason: 'names the Swagger server when BASE_URL is upstream',
  },
  'apps/api/src/billing/billing-redirect-urls.ts': {
    values: ['app.trycomp.ai', 'app.staging.trycomp.ai'],
    reason: 'inbound allowlist for client-supplied Stripe return URLs',
  },
  'apps/api/src/organization-access/organization-access.service.ts': {
    values: ['trycomp.ai'],
    reason: 'internal-staff email check; self-hosted grants before it',
  },
  'apps/api/src/organization-access/organization-access.controller.ts': {
    values: ['trycomp.ai'],
    reason: 'OpenAPI description text',
  },
  'apps/api/src/background-checks/background-checks.controller.ts': {
    values: ['api-key@trycomp.ai'],
    reason:
      'requester label for API-key callers; an address, not a host that is called',
  },
  'apps/api/src/comments/dto/create-comment.dto.ts': {
    values: ['https://app.trycomp.ai'],
    reason: 'OpenAPI example value',
  },
  'apps/api/src/comments/dto/update-comment.dto.ts': {
    values: ['https://app.trycomp.ai'],
    reason: 'OpenAPI example value',
  },
  'apps/api/src/openapi/operation-metadata.ts': {
    values: ['https://api.trycomp.ai'],
    reason: 'curl samples in the public API docs',
  },
  'apps/api/src/openapi/public-docs-metadata.ts': {
    values: ['https://api.trycomp.ai'],
    reason: 'server URL of the public API docs',
  },
  'apps/api/src/training/training-certificate-pdf.service.ts': {
    values: ['https://trycomp.ai'],
    reason: 'marketing text printed on the certificate; not fetched',
  },
  'apps/api/src/email/components/footer.tsx': {
    values: ['https://trycomp.ai'],
    reason: 'marketing footer link (upstream marketing string, left alone)',
  },
  'packages/email/components/footer.tsx': {
    values: ['https://trycomp.ai'],
    reason: 'marketing footer link (upstream marketing string, left alone)',
  },
  'packages/email/components/get-started.tsx': {
    values: ['https://trycomp.ai'],
    reason: 'marketing button (upstream marketing string, left alone)',
  },
};

/** Upstream mentions in the string literals and template parts of one source file. */
function findUpstreamHosts({
  file,
  source,
}: {
  file: string;
  source: string;
}): string[] {
  const kind = file.endsWith('x')
    ? ts.ScriptKind.TSX
    : /\.c?js$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    kind,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const match of node.text.matchAll(UPSTREAM_HOST)) {
        found.push(match[0].toLowerCase());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function sourceFiles(): string[] {
  return ROOTS.flatMap((root) => {
    const path = join(REPO_ROOT, root);
    if (statSync(path).isFile()) return [root];
    return readdirSync(path, { recursive: true, encoding: 'utf8' })
      .filter((file) => SOURCE_FILE.test(file) && !TEST_FILE.test(file))
      .map((file) => join(root, file));
  });
}

describe('findUpstreamHosts', () => {
  const find = (source: string) => findUpstreamHosts({ file: 'x.ts', source });

  it.each([
    [
      "const a = process.env.X ?? 'https://app.trycomp.ai';",
      'https://app.trycomp.ai',
    ],
    ["const a = 'http://api.trycomp.ai/v1';", 'http://api.trycomp.ai'],
    ["const a = 'HTTPS://PORTAL.TRYCOMP.AI';", 'https://portal.trycomp.ai'],
    ["const a = 'portal.trycomp.ai';", 'portal.trycomp.ai'],
    [
      "const a = 'https://assets.trycomp.ai/logo.png';",
      'https://assets.trycomp.ai',
    ],
    ["const a = 'https://acme.trust.inc';", 'https://acme.trust.inc'],
    [
      "const dsn = 'https://k@o4509214247813120.ingest.us.sentry.io/1';",
      'https://k@o4509214247813120.ingest.us.sentry.io',
    ],
    [
      'const a = `${base ?? "x"}https://app.trycomp.ai/${id}`;',
      'https://app.trycomp.ai',
    ],
    [
      "const a = '/v1/*'; const b = 'https://app.trycomp.ai'; const c = '*/';",
      'https://app.trycomp.ai',
    ],
  ])('finds %s', (source, expected) => {
    expect(find(source)).toContain(expected);
  });

  it('ignores comments and package names', () => {
    expect(
      find(
        "// https://app.trycomp.ai\n/* trust.inc */\nimport x from '@trycompai/email';",
      ),
    ).toEqual([]);
  });
});

describe('no upstream hosts in server, Trigger, email, Sentry and device-agent code', () => {
  const files = sourceFiles();
  const findings = files.flatMap((file) =>
    findUpstreamHosts({
      file,
      source: readFileSync(join(REPO_ROOT, file), 'utf8'),
    }).map((value) => ({ file, value })),
  );

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it('has no upstream host outside the documented allowlist', () => {
    const unexpected = findings
      .filter(({ file, value }) => !ALLOWED[file]?.values.includes(value))
      .map(({ file, value }) => `${file}: ${value}`);
    expect([...new Set(unexpected)]).toEqual([]);
  });

  it('keeps the allowlist current', () => {
    const stale = Object.entries(ALLOWED).flatMap(([file, { values }]) =>
      values
        .filter(
          (value) =>
            !findings.some((f) => f.file === file && f.value === value),
        )
        .map((value) => `${file}: ${value}`),
    );
    expect(stale).toEqual([]);
  });
});

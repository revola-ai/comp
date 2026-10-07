import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Guard: server, Trigger and email code must never fall back to upstream Comp's hosts.
// Laptops share the production database and send real email, so a default such as
// `process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.trycomp.ai'` hands recipients, their
// addresses, record ids and signed tokens to upstream. Upstream merges that add one fail
// here; leave the link out instead (utils/public-url.ts).

const REPO_ROOT = resolve(__dirname, '../../../..');
// The API (and its Trigger tasks), the email package it renders, and the app's server
// and Trigger code that builds email and notification links.
const ROOTS = [
  'apps/api/src',
  'packages/email/lib',
  'packages/email/emails',
  'packages/email/components',
  'apps/app/src/trigger',
  'apps/app/src/lib',
  'apps/app/src/app/api',
  'apps/app/src/app/unsubscribe',
];
const UPSTREAM_URL = /https:\/\/(?:app|portal|api)(?:\.staging)?\.trycomp\.ai/;
const TEST_FILE = /\.(spec|test)\.tsx?$/;

/** Files allowed to mention an upstream URL, and why it never sends Revola data there. */
const ALLOWED: Record<string, string> = {
  'apps/api/src/auth/origin-policy.ts':
    'inbound trusted-origin defaults, used only on a non-self-hosted install without AUTH_TRUSTED_ORIGINS; nothing is sent',
  'apps/api/src/comments/dto/create-comment.dto.ts': 'OpenAPI example value',
  'apps/api/src/comments/dto/update-comment.dto.ts': 'OpenAPI example value',
  'apps/api/src/openapi/operation-metadata.ts':
    'curl samples in the public API docs',
  'apps/api/src/openapi/public-docs-metadata.ts':
    'server URL of the public API docs',
};

/** Source without comments, which may name upstream hosts as examples. */
function code(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(): string[] {
  return ROOTS.flatMap((root) =>
    readdirSync(join(REPO_ROOT, root), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file) && !TEST_FILE.test(file))
      .map((file) => join(root, file)),
  );
}

describe('no upstream host fallbacks in server, Trigger and email code', () => {
  const offending = sourceFiles().filter((file) =>
    UPSTREAM_URL.test(code(file)),
  );

  it('finds source files to scan', () => {
    expect(sourceFiles().length).toBeGreaterThan(1000);
  });

  it('has no upstream URL outside the documented allowlist', () => {
    const unexpected = offending.filter((file) => !(file in ALLOWED));
    expect(unexpected).toEqual([]);
  });

  it('keeps the allowlist current', () => {
    const stale = Object.keys(ALLOWED).filter(
      (file) => !offending.includes(file),
    );
    expect(stale).toEqual([]);
  });
});

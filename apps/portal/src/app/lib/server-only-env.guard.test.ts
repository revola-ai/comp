import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Whole-tree source scans read thousands of files; under a parallel run they
// can exceed vitest's 5 s default without anything being wrong.
const SCAN_TIMEOUT_MS = 30_000;

/**
 * Server-side portal code must reach the API through getServerApiBaseUrl() so
 * that, in production, it uses the ECS Service Connect address
 * (BACKEND_API_URL). Browser modules keep NEXT_PUBLIC_API_URL because only
 * the public hostname is reachable from a browser.
 */

const SRC = resolve(__dirname, '../..');
const HELPER = 'app/lib/server-api-base-url.ts';
const BROWSER_MODULES = [
  'app/lib/auth-client.ts',
  'hooks/use-training-completions.ts',
  'app/(public)/auth/device-callback/page.tsx',
];

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : listSourceFiles(full);
    }
    return /\.(ts|tsx|mts)$/.test(entry.name) ? [full] : [];
  });
}

function hasUseClient(source: string): boolean {
  return /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(source);
}

function isServerOnly({ file, source }: { file: string; source: string }): boolean {
  const name = basename(file);
  if (name === 'route.ts' || name === 'proxy.ts' || name === 'middleware.ts') return true;
  if (/['"]use server['"]/.test(source)) return true;
  if (/^import ['"]server-only['"]/m.test(source)) return true;
  if (/from ['"]next\/headers['"]/.test(source)) return true;
  if (/^(page|layout)\.tsx$/.test(name)) return !hasUseClient(source);
  return false;
}

const files = listSourceFiles(SRC)
  .map((file) => ({ file, rel: relative(SRC, file) }))
  .filter(({ rel }) => !rel.startsWith('trigger/') && !/\.(test|spec)\.tsx?$/.test(rel));

describe('portal server-only modules use getServerApiBaseUrl()', () => {
  it('classifies known server callers as server-only (scanner sanity check)', () => {
    for (const rel of [
      'app/api/auth/get-session/route.ts',
      'app/api/portal/complete-training/route.ts',
    ]) {
      const source = readFileSync(resolve(SRC, rel), 'utf8');
      expect(isServerOnly({ file: rel, source }), rel).toBe(true);
    }
  });

  it(
    'no server-only module reads NEXT_PUBLIC_API_URL or BACKEND_API_URL directly',
    () => {
      const offenders = files
        .filter(({ rel }) => rel !== HELPER)
        .filter(({ file }) => {
          const source = readFileSync(file, 'utf8');
          return (
            isServerOnly({ file, source }) && /NEXT_PUBLIC_API_URL|BACKEND_API_URL/.test(source)
          );
        })
        .map(({ rel }) => rel);
      expect(offenders).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it('modules that call the API server-side do not read the env directly', () => {
    for (const rel of ['app/lib/auth.ts', 'app/api/device-agent/proxy.ts']) {
      const source = readFileSync(resolve(SRC, rel), 'utf8');
      expect(source, rel).not.toMatch(/NEXT_PUBLIC_API_URL|BACKEND_API_URL/);
      expect(source, rel).toContain('getServerApiBaseUrl');
    }
  });

  it(
    'no client module imports the server helper',
    () => {
      const offenders = files
        .filter(({ file }) => {
          const source = readFileSync(file, 'utf8');
          return hasUseClient(source) && source.includes('server-api-base-url');
        })
        .map(({ rel }) => rel);
      expect(offenders).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it.each(BROWSER_MODULES)('browser module %s keeps the public NEXT_PUBLIC_API_URL', (rel) => {
    const source = readFileSync(resolve(SRC, rel), 'utf8');
    expect(source).toContain('NEXT_PUBLIC_API_URL');
    expect(source).not.toContain('server-api-base-url');
  });
});

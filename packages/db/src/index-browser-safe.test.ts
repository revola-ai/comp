import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The package index is reachable from Next.js client bundles through the apps'
// `@db` re-exports (apps/*/prisma/index.ts). A static import of a Node built-in
// anywhere in that module graph breaks the browser bundle at runtime
// ("Cannot find module 'node:fs'"), so server-only code must load built-ins
// lazily (process.getBuiltinModule) or live outside the index's graph.
const STATIC_IMPORT = /^\s*import\s+(?!type\s)[^;]*?from\s+['"](node:[a-z_/]+|fs|path|tls|os|child_process|crypto)['"]/gm;
const RELATIVE_IMPORT = /^\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm;

function resolveModule(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`cannot resolve ${specifier} from ${fromFile}`);
}

function collectGraph({ entry, seen }: { entry: string; seen: Set<string> }): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(entry, 'utf8');
  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    collectGraph({ entry: resolveModule(entry, match[1]), seen });
  }
  return seen;
}

describe('package index module graph', () => {
  it('has no static Node built-in imports (browser bundles reach it via the apps\' @db re-exports)', () => {
    const files = collectGraph({ entry: resolve(import.meta.dir, 'index.ts'), seen: new Set() });
    expect(files.size).toBeGreaterThan(3);
    const offenders = [...files].flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)].map((m) => `${file}: ${m[0].trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});

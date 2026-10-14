import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const SERVER_DIR = resolve(import.meta.dir, '..');
const ROOT = resolve(SERVER_DIR, '../..');

const manifestSchema = z.object({
  workspaces: z.array(z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

function readManifest({ dir }: { dir: string }): z.infer<typeof manifestSchema> {
  return manifestSchema.parse(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));
}

function sourceFiles(): string[] {
  const top = readdirSync(SERVER_DIR).filter((name) => name.endsWith('.ts'));
  const secrets = readdirSync(join(SERVER_DIR, 'secrets'), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join('secrets', name));
  return [...top, ...secrets].map((name) => join(SERVER_DIR, name));
}

/** The package each bare import names: "zod", "@scope/name" (not node:, bun: or relative). */
function importedPackages(): Set<string> {
  const packages = new Set<string>();
  for (const file of sourceFiles()) {
    for (const match of readFileSync(file, 'utf8').matchAll(/^import .+ from '([^']+)';$/gm)) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('.') || /^(node|bun):/.test(specifier)) continue;
      const parts = specifier.split('/');
      packages.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? ''));
    }
  }
  return packages;
}

describe('deploy/server workspace', () => {
  test('the root package.json lists deploy/server as a workspace', () => {
    expect(readManifest({ dir: ROOT }).workspaces ?? []).toContain('deploy/server');
  });

  test('every package push-secrets imports is a dependency', () => {
    const declared = Object.keys(readManifest({ dir: SERVER_DIR }).dependencies ?? {});
    expect([...importedPackages()].sort()).toEqual(['dotenv', 'zod']);
    for (const name of importedPackages()) expect(declared).toContain(name);
  });

  test('the tools its scripts and tsconfig use are dev dependencies', () => {
    const declared = Object.keys(readManifest({ dir: SERVER_DIR }).devDependencies ?? {});
    for (const name of ['@types/bun', 'typescript', 'eslint', 'typescript-eslint']) {
      expect(declared).toContain(name);
    }
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// The api image replaces each @trycompai/* workspace symlink with that package's built
// output (assemble-api-context.sh). A workspace package the api reaches at runtime but
// missing from the script's list would be a dangling link in the image, so the list must
// equal the api's transitive production dependencies inside the workspace.

const REPO_ROOT = join(import.meta.dir, '../../..');
const SCRIPT_PATH = join(import.meta.dir, '../assemble-api-context.sh');
const WORKSPACE_DIRS = ['apps', 'packages'] as const;

const manifestSchema = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
});

/** Workspace package name to its production dependency names. */
export function readWorkspaceGraph({ repoRoot }: { repoRoot: string }): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const dir of WORKSPACE_DIRS) {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let raw: string;
      try {
        raw = readFileSync(join(repoRoot, dir, entry.name, 'package.json'), 'utf8');
      } catch {
        continue;
      }
      const manifest = manifestSchema.parse(JSON.parse(raw));
      graph.set(manifest.name, Object.keys(manifest.dependencies ?? {}));
    }
  }
  return graph;
}

/** Workspace packages `from` reaches through production dependencies, excluding itself. */
export function workspaceClosure({
  graph,
  from,
}: {
  graph: Map<string, string[]>;
  from: string;
}): string[] {
  const seen = new Set<string>();
  const queue = [...(graph.get(from) ?? [])];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name) || !graph.has(name)) continue;
    seen.add(name);
    queue.push(...(graph.get(name) ?? []));
  }
  return [...seen].sort();
}

/** The names in the script's `readonly WORKSPACE_PACKAGES=(...)` array, as @trycompai/<name>. */
export function readScriptPackages({ script }: { script: string }): string[] {
  const match = script.match(/^readonly WORKSPACE_PACKAGES=\(([^)]*)\)$/m);
  if (!match) throw new Error('assemble-api-context.sh has no readonly WORKSPACE_PACKAGES=(...) line');
  return (match[1] as string)
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => `@trycompai/${name}`)
    .sort();
}

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeManifest({
  root,
  path,
  manifest,
}: {
  root: string;
  path: string;
  manifest: z.infer<typeof manifestSchema> & { devDependencies?: Record<string, string> };
}): void {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, 'package.json'), JSON.stringify(manifest));
}

describe('workspaceClosure', () => {
  test('follows production dependencies transitively and ignores dev and published ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-'));
    tempRoots.push(root);
    writeManifest({
      root,
      path: 'apps/api',
      manifest: {
        name: '@x/api',
        dependencies: { '@x/a': 'workspace:*', '@x/published': '1.0.0', zod: '^4' },
        devDependencies: { '@x/dev-only': 'workspace:*' },
      },
    });
    writeManifest({ root, path: 'packages/a', manifest: { name: '@x/a', dependencies: { '@x/b': 'workspace:*' } } });
    writeManifest({ root, path: 'packages/b', manifest: { name: '@x/b', dependencies: { '@x/a': 'workspace:*' } } });
    writeManifest({ root, path: 'packages/dev-only', manifest: { name: '@x/dev-only' } });
    const graph = readWorkspaceGraph({ repoRoot: root });
    expect(workspaceClosure({ graph, from: '@x/api' })).toEqual(['@x/a', '@x/b']);
  });
});

describe('readScriptPackages', () => {
  test('reads the readonly array', () => {
    const script = '#!/usr/bin/env bash\nreadonly WORKSPACE_PACKAGES=(db auth)\n';
    expect(readScriptPackages({ script })).toEqual(['@trycompai/auth', '@trycompai/db']);
  });

  test('throws when the array is missing', () => {
    expect(() => readScriptPackages({ script: 'PACKAGES="db"' })).toThrow(/WORKSPACE_PACKAGES/);
  });
});

describe('assemble-api-context.sh package list', () => {
  test('equals the workspace packages apps/api depends on transitively', () => {
    const graph = readWorkspaceGraph({ repoRoot: REPO_ROOT });
    const expected = workspaceClosure({ graph, from: '@trycompai/api' });
    expect(expected.length).toBeGreaterThan(0);
    expect(readScriptPackages({ script: readFileSync(SCRIPT_PATH, 'utf8') })).toEqual(expected);
  });
});

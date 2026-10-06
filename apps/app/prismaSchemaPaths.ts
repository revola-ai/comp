import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type SchemaResolution = {
  path?: string;
  searched: string[];
};

// Where the Prisma schema of @trycompai/db can live for a Trigger build, in order.
function schemaCandidates({
  workingDir,
  workspaceDir,
}: {
  workingDir: string;
  workspaceDir?: string;
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const resolved = resolve(p);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      candidates.push(resolved);
    }
  };

  // Strategy 1: Resolve @trycompai/db via Node module resolution (follows workspace symlinks)
  try {
    const dbPkgJson = require.resolve('@trycompai/db/package.json', {
      paths: [workingDir],
    });
    const dbRoot = dirname(dbPkgJson);
    add(join(dbRoot, 'dist', 'schema.prisma'));
    add(join(dbRoot, 'prisma', 'schema', 'schema.prisma'));
  } catch {
    // Package not resolvable yet (pre-install), fall through to other strategies
  }

  // Strategy 2: Walk up node_modules hierarchy from workingDir and workspaceDir
  const addNodeModuleCandidates = (start: string | undefined) => {
    if (!start) return;
    let current = start;
    while (true) {
      const dbDir = resolve(current, 'node_modules', '@trycompai', 'db');
      add(join(dbDir, 'dist', 'schema.prisma'));
      add(join(dbDir, 'prisma', 'schema', 'schema.prisma'));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  addNodeModuleCandidates(workingDir);
  addNodeModuleCandidates(workspaceDir);

  // Strategy 3: Relative monorepo paths (apps/api → packages/db, apps/app → packages/db)
  for (const rel of ['../../packages/db', '../packages/db']) {
    const dbDir = resolve(workingDir, rel);
    add(join(dbDir, 'dist', 'schema.prisma'));
    add(join(dbDir, 'prisma', 'schema', 'schema.prisma'));
  }

  return candidates;
}

export function resolvePrismaSchemaPath({
  workingDir,
  workspaceDir,
}: {
  workingDir: string;
  workspaceDir?: string;
}): SchemaResolution {
  const searched = schemaCandidates({ workingDir, workspaceDir });
  return { path: searched.find((candidate) => existsSync(candidate)), searched };
}

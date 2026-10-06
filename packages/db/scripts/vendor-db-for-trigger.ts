// Packages this fork's @trycompai/db into a Trigger.dev deploy build. npm's
// @trycompai/db is upstream's package and lacks the fork's exports (resolveSslConfig,
// buildPgAdapterOptions, ...), so the deploy copies packages/db/dist into
// <outputPath>/node_modules/@trycompai/db instead and installs only its runtime
// dependencies. Trigger's Containerfile copies the build directory after `npm i`, so
// the vendored tree survives the install.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const BUILD_HINT = 'run bun run build in packages/db';

const dbPackageSchema = z
  .object({
    name: z.literal('@trycompai/db'),
    version: z.string(),
    dependencies: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();

const installedPackageSchema = z.object({ version: z.string().min(1) }).passthrough();

function dbDirOf(repoRoot: string): string {
  return join(repoRoot, 'packages', 'db');
}

export function assertWorkspaceDbBuilt({ repoRoot }: { repoRoot: string }): void {
  const entry = join(dbDirOf(repoRoot), 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(`@trycompai/db is not built (${entry} is missing): ${BUILD_HINT}`);
  }
}

// The version actually installed for packages/db, found the way Node resolves it: the
// nearest node_modules from packages/db upwards, stopping at the repository root.
function installedVersion({ name, repoRoot }: { name: string; repoRoot: string }): string {
  const root = resolve(repoRoot);
  let current = dbDirOf(root);
  while (true) {
    const manifest = join(current, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) {
      return installedPackageSchema.parse(JSON.parse(readFileSync(manifest, 'utf8'))).version;
    }
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `${name}, a runtime dependency of @trycompai/db, is not installed: run bun install`,
  );
}

export function vendorWorkspaceDb({
  repoRoot,
  outputPath,
}: {
  repoRoot: string;
  outputPath: string;
}): { dependencies: Record<string, string> } {
  assertWorkspaceDbBuilt({ repoRoot });
  const dbDir = dbDirOf(repoRoot);
  const pkg = dbPackageSchema.parse(JSON.parse(readFileSync(join(dbDir, 'package.json'), 'utf8')));

  const dependencies: Record<string, string> = {};
  for (const name of Object.keys(pkg.dependencies)) {
    dependencies[name] = installedVersion({ name, repoRoot });
  }

  const destination = join(outputPath, 'node_modules', '@trycompai', 'db');
  // A dev build may have linked the workspace package here; remove the link itself
  // (never its target) or a stale copy before writing.
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(join(dbDir, 'dist'), join(destination, 'dist'), { recursive: true, dereference: true });

  // Runtime fields only: no install scripts (the generate postinstall needs the
  // workspace) and no dev dependencies.
  const { scripts: _scripts, devDependencies: _devDependencies, ...runtimePackage } = pkg;
  writeFileSync(
    join(destination, 'package.json'),
    `${JSON.stringify({ ...runtimePackage, dependencies }, null, 2)}\n`,
  );
  return { dependencies };
}

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { type SecretKeySpec, SOURCE_FILES } from './keys.ts';
import type { SourceValues } from './resolve.ts';

// The operator's env files, parsed in memory with dotenv (what the apps themselves use) and
// never echoed. Ported from the parked deploy/aws/sync-secrets.ts (revola/aws-infra).

export function loadSources({
  sourceDir,
  secretKeys,
}: {
  sourceDir: string;
  secretKeys: Readonly<Record<string, SecretKeySpec>>;
}): { sources: SourceValues; problems: string[]; notes: string[] } {
  const required = new Set(Object.values(secretKeys).map(({ file }) => file));
  const sources: SourceValues = {};
  const problems: string[] = [];
  const notes: string[] = [];
  for (const file of SOURCE_FILES) {
    const path = join(sourceDir, file);
    if (!existsSync(path)) {
      if (required.has(file)) problems.push(`${file} not found under ${sourceDir}`);
      else notes.push(`${file} not found under the source; its copies of shared values are not compared`);
      continue;
    }
    sources[file] = parseDotenv(readFileSync(path));
  }
  return { sources, problems, notes };
}

/** Refuses a linked git worktree (its env files name its own database) or a non-checkout. */
export function sourceCheckoutProblem({ sourceDir }: { sourceDir: string }): string | undefined {
  const notCheckout = `${sourceDir} is not a git checkout; pass the main checkout of the repository`;
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) return notCheckout;
  const result = Bun.spawnSync(
    ['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
    { cwd: sourceDir, stdout: 'pipe', stderr: 'pipe' },
  );
  const [gitDir, commonDir] = `${result.stdout}`.trim().split('\n');
  if (result.exitCode !== 0 || !gitDir || !commonDir) {
    return notCheckout;
  }
  if (resolve(gitDir) !== resolve(commonDir)) {
    return `${sourceDir} is a linked git worktree; push from the main checkout, whose env files hold the shared values`;
  }
  return undefined;
}

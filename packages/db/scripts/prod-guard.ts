#!/usr/bin/env bun
// Refuses destructive schema and data commands (prisma migrate dev / migrate reset /
// db push, db:seed) when DATABASE_URL points at the production database. Laptops and
// production share one Supabase database (D7), so a local command is one typo away from
// production. Usage, from packages/db scripts:
//
//   bun scripts/prod-guard.ts prisma migrate dev
//
// COMP_I_AM_TOUCHING_PROD=1 runs the command anyway. The child gets exactly the
// environment checked here (Bun has already loaded packages/db's env files and Prisma's
// dotenv never overrides a variable that is set), so the URL checked is the URL used.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type CommandEnv, type RunCommand, runCommand } from './run-command';

const productionTargetSchema = z.object({
  projectRef: z.string().min(1),
  poolerHost: z.string().min(1),
});

export type ProductionTarget = z.infer<typeof productionTargetSchema>;

export type ProdGuardErrorCode = 'production_target_refused' | 'database_url_unverifiable';

export class ProdGuardError extends Error {
  readonly code: ProdGuardErrorCode;

  constructor({ code, detail }: { code: ProdGuardErrorCode; detail: string }) {
    super(`${code}: ${detail}`);
    this.name = 'ProdGuardError';
    this.code = code;
  }
}

const OPT_IN = 'COMP_I_AM_TOUCHING_PROD';

// The single committed source of the production database identity. Read on demand so
// a missing or malformed file fails the guarded command, never silently allows it.
export function loadProductionTarget(): ProductionTarget {
  const path = join(import.meta.dir, '..', 'production-target.json');
  return productionTargetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function isProductionUrl({ url, target }: { url: URL; target: ProductionTarget }): boolean {
  const host = url.hostname.toLowerCase();
  if (host === target.poolerHost.toLowerCase()) return true;
  // The direct connection to the same project, and the pooler's per-project user name
  // (postgres.<ref>) on any regional pooler host.
  if (host === `db.${target.projectRef}.supabase.co`.toLowerCase()) return true;
  return decodeURIComponent(url.username).endsWith(`.${target.projectRef}`);
}

export function assertNotProduction({
  databaseUrl,
  env,
  target,
}: {
  databaseUrl: string | undefined;
  env: CommandEnv;
  target?: ProductionTarget;
}): void {
  if (env[OPT_IN] === '1') return;
  if (!databaseUrl || !URL.canParse(databaseUrl)) {
    throw new ProdGuardError({
      code: 'database_url_unverifiable',
      detail: `DATABASE_URL is missing or not a valid URL, so the production guard cannot check it. Set ${OPT_IN}=1 to run anyway.`,
    });
  }
  const resolvedTarget = target ?? loadProductionTarget();
  if (!isProductionUrl({ url: new URL(databaseUrl), target: resolvedTarget })) return;
  throw new ProdGuardError({
    code: 'production_target_refused',
    detail:
      'DATABASE_URL points at the production database (packages/db/production-target.json). ' +
      'Author migrations with `bun run db:migrate:create` against the local comp_dev database; ' +
      `production schema changes ship with release.sh migrate. Set ${OPT_IN}=1 only to touch production on purpose.`,
  });
}

export function runGuarded({
  argv,
  env,
  target,
  spawn = runCommand,
  printError = (line: string) => console.error(line),
}: {
  argv: string[];
  env: CommandEnv;
  target?: ProductionTarget;
  spawn?: RunCommand;
  printError?: (line: string) => void;
}): number {
  const [command, ...args] = argv;
  if (!command) {
    printError('usage: bun scripts/prod-guard.ts <command> [args...]');
    return 2;
  }
  try {
    assertNotProduction({ databaseUrl: env.DATABASE_URL, env, target });
  } catch (error) {
    if (!(error instanceof ProdGuardError)) throw error;
    printError(`refusing \`${argv.join(' ')}\`: ${error.message}`);
    return 1;
  }
  if (env[OPT_IN] === '1') {
    printError(`${OPT_IN}=1: running \`${argv.join(' ')}\` without the production check`);
  }
  return spawn({ command, args, env });
}

if (import.meta.main) {
  process.exit(runGuarded({ argv: process.argv.slice(2), env: process.env }));
}

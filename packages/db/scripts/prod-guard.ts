#!/usr/bin/env bun
// Refuses destructive schema and data commands (prisma migrate dev / migrate reset /
// migrate deploy / db push / db execute, db:seed) when DATABASE_URL points at the
// production database. Laptops and
// production share one Supabase database (D7), so a local command is one typo away from
// production. Usage, from packages/db scripts:
//
//   bun scripts/prod-guard.ts prisma migrate dev
//
// prisma.config.ts guards Prisma CLI commands at the root; this wrapper is for commands
// that never load it (the seed script) and for scripts that want the check explicit.
// It stays silent on the opt-in so a wrapped Prisma command reports it once.
//
// COMP_I_AM_TOUCHING_PROD=1 runs the command anyway. The child gets exactly the
// environment checked here (Bun has already loaded packages/db's env files and Prisma's
// dotenv never overrides a variable that is set), so the URL checked is the URL used.
import {
  type ProductionTarget,
  ProdGuardError,
  assertNotProduction,
} from './production-target-guard';
import { type CommandEnv, type RunCommand, runCommand } from './run-command';

export {
  ProdGuardError,
  assertNotProduction,
  loadProductionTarget,
  type ProductionTarget,
} from './production-target-guard';

// Arguments that look like a connection string (a scheme, or any mention of postgres,
// which covers pooler user names) never reach the terminal.
function redactArgument(arg: string): string {
  return arg.includes('://') || /postgres/i.test(arg) ? '<redacted>' : arg;
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
    printError(`refusing \`${argv.map(redactArgument).join(' ')}\`: ${error.message}`);
    return 1;
  }
  return spawn({ command, args, env });
}

if (import.meta.main) {
  process.exit(runGuarded({ argv: process.argv.slice(2), env: process.env }));
}

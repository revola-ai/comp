#!/usr/bin/env bun
// Authors a new migration without touching the shared database: runs
// `prisma migrate dev --create-only` against the local comp_dev database (Prisma creates
// it when missing), whatever DATABASE_URL the environment or env files hold. Commit the
// generated folder; production applies it with `release.sh migrate --sha` after review.
//
//   bun run db:migrate:create --name add_widget
//   bun run db:migrate:create --url postgresql://postgres:postgres@127.0.0.1:55432/comp_dev --name add_widget
//
// --url may name another local server; anything that is not localhost, 127.0.0.1 or ::1
// is refused.
import { isLocalhostUrl } from '../src/ssl-config';
import { type CommandEnv, type RunCommand, runCommand } from './run-command';

export const LOCAL_DEV_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/comp_dev';

// Variables some configs use for a second connection; none may survive into the child.
const OTHER_CONNECTION_VARS = [
  'DIRECT_URL',
  'DIRECT_DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'SHADOW_DATABASE_URL',
];

export type MigrateCreateInvocation = { command: string; args: string[]; env: CommandEnv };

function splitUrlFlag(argv: string[]): { url: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let url: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length);
      continue;
    }
    if (arg !== '--url') {
      rest.push(arg);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`--url needs a value, e.g. --url ${LOCAL_DEV_DATABASE_URL}`);
    }
    url = value;
    index += 1;
  }
  return { url, rest };
}

export function buildMigrateCreateInvocation({
  argv,
  env,
}: {
  argv: string[];
  env: CommandEnv;
}): MigrateCreateInvocation {
  const { url, rest } = splitUrlFlag(argv);
  const target = url ?? LOCAL_DEV_DATABASE_URL;
  if (!URL.canParse(target) || !isLocalhostUrl(target)) {
    // Never echo the URL: it may carry a password.
    throw new Error(
      'db:migrate:create only targets a local database (localhost, 127.0.0.1 or ::1)',
    );
  }
  const childEnv: CommandEnv = { ...env, DATABASE_URL: target };
  for (const name of OTHER_CONNECTION_VARS) delete childEnv[name];
  return {
    command: 'bunx',
    args: ['prisma', 'migrate', 'dev', '--create-only', ...rest],
    env: childEnv,
  };
}

export function runMigrateCreate({
  argv,
  env,
  spawn = runCommand,
  printError = (line: string) => console.error(line),
}: {
  argv: string[];
  env: CommandEnv;
  spawn?: RunCommand;
  printError?: (line: string) => void;
}): number {
  let invocation: MigrateCreateInvocation;
  try {
    invocation = buildMigrateCreateInvocation({ argv, env });
  } catch (error) {
    printError(`db:migrate:create: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return spawn(invocation);
}

if (import.meta.main) {
  process.exit(runMigrateCreate({ argv: process.argv.slice(2), env: process.env }));
}

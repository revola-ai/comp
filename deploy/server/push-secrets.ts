import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type ProductionTarget,
  readProductionTargetFile,
} from '../../packages/db/src/production-target.ts';
import { spawnAws } from './secrets/aws-cli.ts';
import { KEYS_DIR, SECRET_KEYS } from './secrets/keys.ts';
import { NO_TERMINAL, runPush } from './secrets/run.ts';
import { awsSecretStore } from './secrets/secret-store.ts';
import { openTerminal } from './secrets/terminal.ts';

// Builds the production secret comp/production/config (us-east-2, account 455986776194) from
// the operator's env files, for exactly the keys in deploy/server/env/*.keys, and writes it
// after the typed word `push` (read from the terminal, never from stdin). The env files are
// parsed in memory and never echoed: the output names keys and files only. Production-only
// values (the tunnel token and the Trigger.dev prod keys) live in
// <source>/deploy/server/.env.production.local. Runbook: docs/self-hosting-server.md.
//
//   bun deploy/server/push-secrets.ts --source <main checkout> --dry-run
//   bun deploy/server/push-secrets.ts --source <main checkout>

const USAGE = 'usage: bun deploy/server/push-secrets.ts --source <main checkout> [--dry-run]';

function parse(argv: readonly string[]): { source: string; dryRun: boolean } | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: { source: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: true,
    });
    if (!values.source || positionals.length > 0) return undefined;
    return { source: values.source, dryRun: values['dry-run'] };
  } catch {
    return undefined;
  }
}

/** The CLI; `target` is the production database the URLs must name (tests pass a fake one). */
export async function main({
  argv,
  target,
}: {
  argv: readonly string[];
  target?: ProductionTarget;
}): Promise<number> {
  const args = parse(argv);
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  // Like lib/provision-common.sh: without a terminal, refuse before reading or calling anything.
  const terminal = args.dryRun ? undefined : openTerminal();
  if (!args.dryRun && !terminal) {
    console.error(`error: ${NO_TERMINAL}`);
    return 1;
  }
  try {
    return await runPush({
      sourceDir: resolve(args.source),
      dryRun: args.dryRun,
      terminal,
      store: awsSecretStore({ run: spawnAws }),
      run: spawnAws,
      log: (line) => console.log(line),
      env: process.env,
      keysDir: KEYS_DIR,
      secretKeys: SECRET_KEYS,
      target: target ?? readProductionTargetFile(),
    });
  } finally {
    terminal?.close();
  }
}

if (import.meta.main) {
  process.exit(await main({ argv: process.argv.slice(2) }));
}

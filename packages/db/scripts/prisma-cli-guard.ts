// The production guard at the root of every Prisma CLI command: each prisma.config.ts
// calls enforcePrismaCliGuard() after its dotenv load. The Prisma CLI loads the config
// in its own process, so process.argv is the CLI's argv and process.env.DATABASE_URL is
// the URL the command is about to use. Running Prisma directly (`bunx prisma migrate
// dev`) therefore cannot bypass it the way it bypasses package scripts.
import {
  type GuardEnv,
  OPT_IN,
  ProdGuardError,
  type ProductionTarget,
  assertNotProduction,
} from './production-target-guard';

// Commands that reset, rewrite or seed the database they point at.
const GUARDED: Record<string, ReadonlySet<string>> = {
  migrate: new Set(['dev', 'reset']),
  db: new Set(['push', 'seed']),
};

// Known subcommands, so a flag value (`--schema prisma/schema`) is never taken for one.
const SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  migrate: new Set(['dev', 'reset', 'deploy', 'status', 'resolve', 'diff']),
  db: new Set(['push', 'pull', 'seed', 'execute']),
};

const HELP_FLAGS = new Set(['--help', '-h']);

export function classifyPrismaCommand(args: string[]): { guarded: boolean; command: string } {
  const words = args.filter((arg) => !arg.startsWith('-'));
  const commandIndex = words.findIndex((word) => Object.hasOwn(SUBCOMMANDS, word));
  if (commandIndex === -1) return { guarded: false, command: words[0] ?? '' };

  const command = words[commandIndex] ?? '';
  const subcommands = SUBCOMMANDS[command] ?? new Set<string>();
  const subcommand = words.slice(commandIndex + 1).find((word) => subcommands.has(word));
  if (!subcommand) return { guarded: false, command };

  const name = `${command} ${subcommand}`;
  const asksForHelp = args.some((arg) => HELP_FLAGS.has(arg));
  return { guarded: !asksForHelp && (GUARDED[command]?.has(subcommand) ?? false), command: name };
}

export function enforcePrismaCliGuard({
  argv = process.argv,
  env = process.env,
  target,
  exit = (code: number) => process.exit(code),
  printError = (line: string) => console.error(line),
}: {
  argv?: string[];
  env?: GuardEnv;
  target?: ProductionTarget;
  exit?: (code: number) => void;
  printError?: (line: string) => void;
} = {}): void {
  const { guarded, command } = classifyPrismaCommand(argv.slice(2));
  if (!guarded) return;
  try {
    const outcome = assertNotProduction({ databaseUrl: env.DATABASE_URL, env, target });
    if (outcome === 'production_opted_in') {
      printError(`${OPT_IN}=1: running \`prisma ${command}\` against the production database`);
    }
  } catch (error) {
    if (!(error instanceof ProdGuardError)) throw error;
    printError(`refusing \`prisma ${command}\`: ${error.message}`);
    exit(1);
  }
}

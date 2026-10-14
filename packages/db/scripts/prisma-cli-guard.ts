// The production guard at the root of every Prisma CLI command: each prisma.config.ts
// calls enforcePrismaCliGuard() after its dotenv load. The Prisma CLI loads the config
// in its own process, so process.argv is the CLI's argv and process.env.DATABASE_URL is
// the URL the config hands the command. A command picks its database from that config
// URL or from a `--url` flag that overrides it, so the guard checks both. Running Prisma
// directly (`bunx prisma migrate dev`) still loads the config and meets the guard; only
// a command run without any prisma.config.ts (another working directory, `--config`
// naming a file without the guard) or a client outside Prisma escapes it.
import {
  type GuardEnv,
  OPT_IN,
  ProdGuardError,
  type ProductionTarget,
  assertNotProduction,
} from './production-target-guard';

// Commands that reset, rewrite, migrate, seed or run SQL against the database they point
// at. `migrate deploy` and `migrate resolve` change production's schema or migration
// history, so they also need the opt-in (the release path sets it after review).
const GUARDED: Record<string, ReadonlySet<string>> = {
  migrate: new Set(['dev', 'reset', 'deploy', 'resolve']),
  db: new Set(['push', 'seed', 'execute']),
};

// Commands without subcommands that write to the database: Studio edits rows.
const GUARDED_TOP_LEVEL: ReadonlySet<string> = new Set(['studio']);

// Known subcommands, so a flag value (`--schema prisma/schema`) is never taken for one.
const SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  migrate: new Set(['dev', 'reset', 'deploy', 'status', 'resolve', 'diff']),
  db: new Set(['push', 'pull', 'seed', 'execute']),
};

const HELP_FLAGS = new Set(['--help', '-h']);

export function classifyPrismaCommand(args: string[]): { guarded: boolean; command: string } {
  const words = args.filter((arg) => !arg.startsWith('-'));
  const asksForHelp = args.some((arg) => HELP_FLAGS.has(arg));
  const topLevel = words.find((word) => GUARDED_TOP_LEVEL.has(word));
  if (topLevel && !words.some((word) => Object.hasOwn(SUBCOMMANDS, word))) {
    return { guarded: !asksForHelp, command: topLevel };
  }
  const commandIndex = words.findIndex((word) => Object.hasOwn(SUBCOMMANDS, word));
  if (commandIndex === -1) return { guarded: false, command: words[0] ?? '' };

  const command = words[commandIndex] ?? '';
  const subcommands = SUBCOMMANDS[command] ?? new Set<string>();
  const subcommand = words.slice(commandIndex + 1).find((word) => subcommands.has(word));
  if (!subcommand) return { guarded: false, command };

  const name = `${command} ${subcommand}`;
  return { guarded: !asksForHelp && (GUARDED[command]?.has(subcommand) ?? false), command: name };
}

const URL_FLAG = '--url';

/** Every database URL given with `--url <value>` or `--url=<value>`, in order. */
export function urlFlagValues(args: string[]): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg.startsWith(`${URL_FLAG}=`)) values.push(arg.slice(URL_FLAG.length + 1));
    if (arg === URL_FLAG && index + 1 < args.length) values.push(args[index + 1] ?? '');
  });
  return values;
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
  const args = argv.slice(2);
  const { guarded, command } = classifyPrismaCommand(args);
  if (!guarded) return;
  const sources = [
    { label: 'DATABASE_URL', databaseUrl: env.DATABASE_URL },
    ...urlFlagValues(args).map((databaseUrl) => ({ label: URL_FLAG, databaseUrl })),
  ];
  for (const { label, databaseUrl } of sources) {
    try {
      const outcome = assertNotProduction({ databaseUrl, env, target });
      if (outcome === 'production_opted_in') {
        printError(
          `${OPT_IN}=1: running \`prisma ${command}\` against the production database (${label})`,
        );
      }
    } catch (error) {
      if (!(error instanceof ProdGuardError)) throw error;
      printError(`refusing \`prisma ${command}\` (${label}): ${error.message}`);
      exit(1);
      return;
    }
  }
}

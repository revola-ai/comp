import type { ProductionTarget } from '../../../packages/db/src/production-target.ts';
import { accountProblem, ACCOUNT_ID, type AwsRunner, REGION, regionProblem } from './aws-cli.ts';
import { keyTableProblems, readKeyUnion, type SecretKeySpec } from './keys.ts';
import { formatPlan, planPush } from './plan.ts';
import { resolveDesired } from './resolve.ts';
import { SECRET_ID, type SecretStore } from './secret-store.ts';
import { loadSources, sourceCheckoutProblem } from './sources.ts';
import type { Terminal } from './terminal.ts';

// One push: local checks first (region, checkout, key table, sources and values), then the
// account, then the names-only diff against the current secret, then the typed word `push` and
// the write. Anything refused ends the run with nothing written.

export const CONFIRM_WORD = 'push';
const MIN_REDACTED_LENGTH = 12;

type Log = (line: string) => void;

export type PushOptions = Readonly<{
  sourceDir: string;
  dryRun: boolean;
  /** Required unless dryRun; opened by the caller before anything else happens. */
  terminal: Terminal | undefined;
  store: SecretStore;
  run: AwsRunner;
  log: Log;
  env: Readonly<Record<string, string | undefined>>;
  keysDir: string;
  secretKeys: Readonly<Record<string, SecretKeySpec>>;
  target: ProductionTarget;
}>;

function sortedJson(values: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
}

/** Belt and braces: an error message never carries a value, even if a tool echoed one. */
function redact({ text, values }: { text: string; values: readonly string[] }): string {
  return values
    .filter((value) => value.length >= MIN_REDACTED_LENGTH)
    .reduce((result, value) => result.replaceAll(value, '<a secret value>'), text);
}

function refuse({ log, problems }: { log: Log; problems: readonly string[] }): number {
  for (const problem of problems) log(`error: ${problem}`);
  return 1;
}

export const NO_TERMINAL =
  'push-secrets needs a terminal to confirm the write; run it from an interactive shell (piped answers are never accepted), or pass --dry-run';

async function diffAndWrite({
  options,
  desired,
}: {
  options: PushOptions;
  desired: Readonly<Record<string, string>>;
}): Promise<number> {
  const { store, run, log, terminal } = options;
  const account = await accountProblem({ run });
  if (account) return refuse({ log, problems: [account] });
  const state = await store.read();
  const create = state.kind === 'absent';
  log(`${SECRET_ID} (account ${ACCOUNT_ID}, ${REGION}):`);
  if (create) log(`  ${SECRET_ID} does not exist yet; the push creates it`);
  const plan = planPush({ desired, current: state.kind === 'present' ? state.values : undefined });
  for (const line of formatPlan({ plan })) log(`  ${line}`);
  if (plan.problems.length > 0) return refuse({ log, problems: plan.problems });
  const unchanged = plan.added.length + plan.changed.length + plan.removed.length === 0;
  if (state.kind === 'present' && unchanged) {
    log('no changes');
    return 0;
  }
  if (options.dryRun) {
    log('dry run: nothing written');
    return 0;
  }
  if (!terminal) return refuse({ log, problems: [NO_TERMINAL] });
  log('the write runs:');
  log(`  ${store.describeWrite({ create })}`);
  const answer = terminal.ask(`Type ${CONFIRM_WORD} to write ${SECRET_ID}: `);
  if (answer !== CONFIRM_WORD) {
    log('nothing written');
    return 1;
  }
  const { versionId } = await store.write({ json: sortedJson(desired), create });
  log(`${create ? 'created' : 'wrote'} ${SECRET_ID} version ${versionId}`);
  log('the server reads it at the next deploy/server/release.sh release (render-env.sh)');
  return 0;
}

export async function runPush(options: PushOptions): Promise<number> {
  const { sourceDir, log } = options;
  log(`source: ${sourceDir}`);
  const local = [regionProblem({ env: options.env }), sourceCheckoutProblem({ sourceDir })].filter(
    (problem): problem is string => problem !== undefined,
  );
  if (local.length > 0) return refuse({ log, problems: local });
  const tableProblems = keyTableProblems({
    union: readKeyUnion({ keysDir: options.keysDir }),
    secretKeys: options.secretKeys,
  });
  if (tableProblems.length > 0) return refuse({ log, problems: tableProblems });
  const loaded = loadSources({ sourceDir, secretKeys: options.secretKeys });
  const resolved = resolveDesired({
    secretKeys: options.secretKeys,
    sources: loaded.sources,
    target: options.target,
  });
  for (const note of [...loaded.notes, ...resolved.notes]) log(`note: ${note}`);
  const inputProblems = [...loaded.problems, ...resolved.problems];
  if (inputProblems.length > 0) return refuse({ log, problems: inputProblems });
  try {
    return await diffAndWrite({ options, desired: resolved.values });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refuse({ log, problems: [redact({ text: message, values: Object.values(resolved.values) })] });
  }
}

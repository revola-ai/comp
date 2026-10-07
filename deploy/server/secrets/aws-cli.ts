// The AWS CLI for push-secrets: every call names the region, never takes stdin, and fails with
// the CLI's own error message (Secrets Manager errors carry codes and names, never the secret
// string). The same account and region guards as lib/provision-common.sh.

export const ACCOUNT_ID = '455986776194';
export const REGION = 'us-east-2';

export type AwsResult = Readonly<{ status: number; stdout: string; stderr: string }>;
/** Runs `aws <args>`; injected so tests can count and inspect every call. */
export type AwsRunner = (args: readonly string[]) => Promise<AwsResult>;

export class AwsError extends Error {
  readonly stderr: string;

  constructor({ args, stderr }: { args: readonly string[]; stderr: string }) {
    super(`aws ${args.slice(0, 2).join(' ')} failed: ${stderr.trim() || 'no error output'}`);
    this.name = 'AwsError';
    this.stderr = stderr;
  }
}

type Killable = Readonly<{ kill: (signal?: NodeJS.Signals) => void }>;

/** The aws processes running now, so an interrupted push can stop them too. */
const inFlight = new Set<Killable>();

/** Stops every aws process this one started and that is still running (SIGTERM). */
export function stopAwsChildren(): void {
  for (const child of inFlight) child.kill('SIGTERM');
}

/** The aws executable on PATH, with no pager and no stdin. */
export const spawnAws: AwsRunner = async (args) => {
  let child: Killable | undefined;
  try {
    const spawned = Bun.spawn({
      cmd: ['aws', ...args],
      env: { ...process.env, AWS_PAGER: '' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child = spawned;
    inFlight.add(spawned);
    const [stdout, stderr, status] = await Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
      spawned.exited,
    ]);
    return { status, stdout, stderr };
  } catch (error) {
    return { status: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    if (child) inFlight.delete(child);
  }
};

/** One CLI call in REGION; returns stdout, throws AwsError on a non-zero exit. */
export async function aws({ run, args }: { run: AwsRunner; args: readonly string[] }): Promise<string> {
  const result = await run([...args, '--region', REGION]);
  if (result.status !== 0) throw new AwsError({ args, stderr: result.stderr });
  return result.stdout;
}

/** AWS_REGION or AWS_DEFAULT_REGION naming another region (the CLI would follow it elsewhere). */
export function regionProblem({ env }: { env: Readonly<Record<string, string | undefined>> }): string | undefined {
  for (const name of ['AWS_REGION', 'AWS_DEFAULT_REGION']) {
    const value = env[name];
    if (value && value !== REGION) {
      return `${name} is ${value}; comp/production/config lives in ${REGION} (unset it or set it to ${REGION})`;
    }
  }
  return undefined;
}

/** The credentials' account, refused unless it is ACCOUNT_ID. */
export async function accountProblem({ run }: { run: AwsRunner }): Promise<string | undefined> {
  const account = (
    await aws({ run, args: ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'] })
  ).trim();
  if (account === ACCOUNT_ID) return undefined;
  return `the AWS credentials are for account ${account}, not ${ACCOUNT_ID}`;
}

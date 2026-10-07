import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FakeAwsState } from './fake-aws.ts';

// Runs push-secrets as the operator would: a separate process, with `aws` on PATH being
// testing/fake-aws.ts, and either a pseudo-terminal to type into or no terminal at all
// (deploy/server/tests/tty_run.py, shared with the bash suites). The entry point is
// testing/cli-under-test.ts, which is push-secrets.ts with the fixtures' production target.

const TTY_RUN = join(import.meta.dir, '../../tests/tty_run.py');
const CLI = join(import.meta.dir, 'cli-under-test.ts');
const FAKE_AWS = join(import.meta.dir, 'fake-aws.ts');

export type Sandbox = Readonly<{ root: string; bin: string; log: string; state: string }>;

export function makeSandbox({ roots }: { roots: string[] }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'push-secrets-cli-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const aws = join(bin, 'aws');
  writeFileSync(aws, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AWS}" "$@"\n`);
  chmodSync(aws, 0o755);
  return { root, bin, log: join(root, 'aws.log'), state: join(root, 'aws-state.json') };
}

export function seedSecret({ sandbox, value }: { sandbox: Sandbox; value: string | null }): void {
  const state: FakeAwsState = {
    secret: { name: 'comp/production/config', value, tags: ['Key=Project,Value=comp'], versions: 1 },
    writes: [],
  };
  writeFileSync(sandbox.state, JSON.stringify(state));
}

export type Terminal = { typed: string } | 'none';

export type CliRun = Readonly<{ code: number; output: string; calls: string[][]; state: FakeAwsState }>;

function cliEnv({ sandbox, env }: { sandbox: Sandbox; env: Record<string, string> }): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== 'AWS_REGION' && entry[0] !== 'AWS_DEFAULT_REGION' && entry[1] !== undefined,
    ),
  );
  return {
    ...inherited,
    PATH: `${sandbox.bin}:${process.env.PATH ?? ''}`,
    FAKE_AWS_LOG: sandbox.log,
    FAKE_AWS_STATE: sandbox.state,
    TTY_RUN_TIMEOUT: '60',
    ...env,
  };
}

function ttyCommand({ sandbox, args, terminal, stdin }: { sandbox: Sandbox; args: string[]; terminal: Terminal; stdin: string }): string[] {
  const mode = terminal === 'none' ? ['--no-tty'] : ['--typed', terminal.typed];
  const out = join(sandbox.root, 'output.txt');
  return ['python3', TTY_RUN, ...mode, '--stdin', stdin, '--out', out, '--', process.execPath, CLI, ...args];
}

/** The aws calls and the fake's state after a run. */
export function readFake({ sandbox }: { sandbox: Sandbox }): { calls: string[][]; state: FakeAwsState } {
  const calls = existsSync(sandbox.log)
    ? readFileSync(sandbox.log, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line): string[] => JSON.parse(line))
    : [];
  const state: FakeAwsState = existsSync(sandbox.state)
    ? JSON.parse(readFileSync(sandbox.state, 'utf8'))
    : { secret: null, writes: [] };
  return { calls, state };
}

export function runCli({
  sandbox,
  args,
  terminal,
  stdin = '',
  env = {},
}: {
  sandbox: Sandbox;
  args: string[];
  terminal: Terminal;
  stdin?: string;
  env?: Record<string, string>;
}): CliRun {
  const result = Bun.spawnSync(ttyCommand({ sandbox, args, terminal, stdin }), {
    env: cliEnv({ sandbox, env }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = readFileSync(join(sandbox.root, 'output.txt'), 'utf8');
  return { code: result.exitCode, output, ...readFake({ sandbox }) };
}

/** Starts a run in the background (for signalling it); `exited` resolves to its status. */
export function startCli({
  sandbox,
  args,
  terminal,
  env = {},
}: {
  sandbox: Sandbox;
  args: string[];
  terminal: Terminal;
  env?: Record<string, string>;
}): { exited: Promise<number>; output: () => string } {
  const child = Bun.spawn(ttyCommand({ sandbox, args, terminal, stdin: '' }), {
    env: cliEnv({ sandbox, env }),
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return { exited: child.exited, output: () => readFileSync(join(sandbox.root, 'output.txt'), 'utf8') };
}

/** A --dry-run (no terminal needed) with stdout and stderr kept apart. */
export function runPiped({ sandbox, args }: { sandbox: Sandbox; args: string[] }): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: cliEnv({ sandbox, env: {} }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, stdout: `${result.stdout}`, stderr: `${result.stderr}` };
}

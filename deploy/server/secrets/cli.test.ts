import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  type CliRun,
  makeSandbox,
  readFake,
  runCli,
  runPiped,
  type Sandbox,
  seedSecret,
  startCli,
  type Terminal,
} from './testing/cli-harness.ts';
import {
  expectedSecret,
  expectNoValues,
  git,
  makeCheckout,
  MARKER,
  sources,
  without,
  writeEnvFiles,
} from './testing/fixtures.ts';

const PUSH = { typed: 'push\n' };

describe('push-secrets', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) Bun.spawnSync(['rm', '-rf', root]);
  });

  function setup(files = sources()): { sandbox: Sandbox; checkout: string } {
    return { sandbox: makeSandbox({ roots }), checkout: makeCheckout({ files, roots }) };
  }

  function push({
    sandbox,
    checkout,
    terminal = PUSH,
    extra = [],
    stdin,
    env,
  }: {
    sandbox: Sandbox;
    checkout: string;
    terminal?: Terminal;
    extra?: string[];
    stdin?: string;
    env?: Record<string, string>;
  }): CliRun {
    const run = runCli({ sandbox, args: ['--source', checkout, ...extra], terminal, stdin, env });
    expectNoValues(run.output);
    expect(JSON.stringify(run.calls)).not.toContain(MARKER);
    return run;
  }

  const operations = (run: CliRun) => run.calls.map((call) => `${call[1]} ${call[2]}`);

  test('a dry run prints the names-only diff and never writes, with no terminal', () => {
    const { sandbox, checkout } = setup();
    const run = push({ sandbox, checkout, terminal: 'none', extra: ['--dry-run'] });
    expect(run.code).toBe(0);
    expect(run.output).toContain('comp/production/config does not exist yet; the push creates it');
    expect(run.output).toContain('added (35): ');
    expect(run.output).toContain('dry run: nothing written');
    expect(operations(run)).toEqual(['sts get-caller-identity', 'secretsmanager get-secret-value']);
  });

  test('the first push creates the secret from a private file, after the typed word', () => {
    const { sandbox, checkout } = setup();
    const run = push({ sandbox, checkout });
    expect(run.code).toBe(0);
    const create = run.calls.find((call) => call[2] === 'create-secret') ?? [];
    const path = run.state.writes[0]?.path ?? '';
    expect(create).toEqual([
      'aws', 'secretsmanager', 'create-secret', '--name', 'comp/production/config',
      '--description', 'Comp production config (deploy/server/push-secrets.ts)',
      '--tags', 'Key=Project,Value=comp', '--secret-string', `file://${path}`,
      '--query', 'VersionId', '--output', 'text', '--region', 'us-east-2',
    ]);
    expect(run.state.writes).toEqual([{ operation: 'create-secret', path, fileMode: 0o600, dirMode: 0o700 }]);
    expect(existsSync(path)).toBe(false);
    expect(JSON.parse(run.state.secret?.value ?? '{}')).toEqual(expectedSecret());
    expect(run.output).toContain('Type push to write comp/production/config');
    expect(run.output).toContain('created comp/production/config version fake-version-1');
  });

  test('a later push puts a new value and names what changed', () => {
    const { sandbox, checkout } = setup();
    const current = without({ record: expectedSecret(), keys: ['OPENAI_API_KEY'] });
    seedSecret({ sandbox, value: JSON.stringify({ ...current, RESEND_API_KEY: 'fakesecret-old', OLD_KEY: 'fakesecret' }) });
    const run = push({ sandbox, checkout });
    expect(run.code).toBe(0);
    expect(run.output).toContain('added (1): OPENAI_API_KEY');
    expect(run.output).toContain('changed (1): RESEND_API_KEY');
    expect(run.output).toContain('removed (1): OLD_KEY');
    expect(run.output).toContain('unchanged: 33');
    expect(operations(run)).toEqual([
      'sts get-caller-identity',
      'secretsmanager get-secret-value',
      'secretsmanager put-secret-value',
    ]);
    expect(run.state.writes.map((write) => [write.fileMode, write.dirMode])).toEqual([[0o600, 0o700]]);
    expect(JSON.parse(run.state.secret?.value ?? '{}')).toEqual(expectedSecret());
    expect(run.output).toContain('wrote comp/production/config version fake-version-2');
  });

  test('a secret with no current value yet is put, not created', () => {
    const { sandbox, checkout } = setup();
    seedSecret({ sandbox, value: null });
    const run = push({ sandbox, checkout });
    expect(run.code).toBe(0);
    expect(operations(run)).toContain('secretsmanager put-secret-value');
  });

  test('nothing to change writes nothing and asks nothing', () => {
    const { sandbox, checkout } = setup();
    seedSecret({ sandbox, value: JSON.stringify(expectedSecret()) });
    const run = push({ sandbox, checkout });
    expect(run.code).toBe(0);
    expect(run.output).toContain('no changes');
    expect(run.output).not.toContain('Type push');
  });

  test.each([
    ['no terminal', 'none', ''],
    ['no terminal with push piped in', 'none', 'push\n'],
  ] as const)('%s: refuses before reading anything or calling aws', (...[, terminal, stdin]) => {
    const { sandbox, checkout } = setup();
    const run = push({ sandbox, checkout, terminal, stdin });
    expect(run.code).toBe(1);
    expect(run.output).toContain('push-secrets needs a terminal to confirm the write');
    expect(run.calls).toEqual([]);
  });

  test.each(['yes\n', 'Push\n', ' push\n', '\n', ''])('typing %j writes nothing', (typed) => {
    const { sandbox, checkout } = setup();
    const run = push({ sandbox, checkout, terminal: { typed } });
    expect(run.code).toBe(1);
    expect(run.output).toContain('nothing written');
    expect(run.state.writes).toEqual([]);
    expect(operations(run)).not.toContain('secretsmanager create-secret');
  });

  test('a changed ENCRYPTION_KEY is refused before the question', () => {
    const { sandbox, checkout } = setup();
    seedSecret({ sandbox, value: JSON.stringify({ ...expectedSecret(), ENCRYPTION_KEY: 'fakesecret-older' }) });
    const run = push({ sandbox, checkout });
    expect(run.code).toBe(1);
    expect(run.output).toContain('ENCRYPTION_KEY would change');
    expect(run.output).not.toContain('Type push');
    expect(run.state.writes).toEqual([]);
  });

  test('a secret that is not a JSON object of strings is refused', () => {
    const { sandbox, checkout } = setup();
    seedSecret({ sandbox, value: '{"A": 1}' });
    const run = push({ sandbox, checkout });
    expect(run.code).toBe(1);
    expect(run.output).toContain('comp/production/config does not hold a JSON object of strings');
  });

  test('a refused value stops the push before any aws call', () => {
    const { sandbox, checkout } = setup(sources({ prod: { TRIGGER_SECRET_KEY_APP: 'tr_dev_fakesecret' } }));
    const run = push({ sandbox, checkout });
    expect(run.code).toBe(1);
    expect(run.output).toContain('error: TRIGGER_SECRET_KEY_APP is a dev key');
    expect(run.calls).toEqual([]);
  });

  test('another account is refused before the secret is read', () => {
    const { sandbox, checkout } = setup();
    const run = push({ sandbox, checkout, env: { FAKE_AWS_ACCOUNT: '111111111111' } });
    expect(run.code).toBe(1);
    expect(run.output).toContain('the AWS credentials are for account 111111111111, not 455986776194');
    expect(operations(run)).toEqual(['sts get-caller-identity']);
  });

  test.each(['AWS_REGION', 'AWS_DEFAULT_REGION'])('%s naming another region is refused', (name) => {
    const { sandbox, checkout } = setup();
    const run = push({ sandbox, checkout, env: { [name]: 'us-west-2' } });
    expect(run.code).toBe(1);
    expect(run.output).toContain(`${name} is us-west-2; comp/production/config lives in us-east-2`);
    expect(run.calls).toEqual([]);
  });

  test('an aws failure on the write is reported and the private file is gone', () => {
    const { sandbox, checkout } = setup();
    const run = push({ sandbox, checkout, env: { FAKE_AWS_DENY: 'secretsmanager create-secret' } });
    expect(run.code).toBe(1);
    expect(run.output).toContain('error: aws secretsmanager create-secret failed: ');
    expect(run.output).toContain('AccessDeniedException');
    expect(run.state.secret).toBeNull();
  });

  test('refuses a --source that is a linked git worktree', () => {
    const { sandbox, checkout } = setup();
    git({ cwd: checkout, args: ['commit', '--allow-empty', '-q', '-m', 'fixture'] });
    const linked = join(checkout, '.worktrees', 'feature');
    git({ cwd: checkout, args: ['worktree', 'add', '-q', linked] });
    writeEnvFiles({ dir: linked, files: sources() });
    const run = push({ sandbox, checkout: linked, terminal: 'none', extra: ['--dry-run'] });
    expect(run.code).toBe(1);
    expect(run.output).toContain('is a linked git worktree');
    expect(run.calls).toEqual([]);
  });

  const blockedSchema = z.object({ pid: z.number(), ppid: z.number(), path: z.string() });

  async function waitForBlocked(file: string): Promise<z.infer<typeof blockedSchema>> {
    for (let tries = 0; tries < 300; tries++) {
      if (existsSync(file)) return blockedSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      await Bun.sleep(100);
    }
    throw new Error('the fake aws never blocked');
  }

  test.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)('%s while aws holds the payload removes it and exits %d', async (signal, expected) => {
    const { sandbox, checkout } = setup();
    const run = startCli({
      sandbox,
      args: ['--source', checkout],
      terminal: PUSH,
      env: { FAKE_AWS_BLOCK: 'secretsmanager create-secret' },
    });
    const blocked = await waitForBlocked(`${sandbox.state}.blocked`);
    expect(existsSync(blocked.path)).toBe(true);
    process.kill(blocked.ppid, signal);
    const code = await run.exited;
    try {
      process.kill(blocked.pid, 'SIGKILL');
    } catch {
      // The fake aws already went down with the terminal.
    }
    expect(code).toBe(expected);
    expect(existsSync(dirname(blocked.path))).toBe(false);
    expectNoValues(run.output());
    expect(readFake({ sandbox }).state.secret).toBeNull();
  }, 60_000);

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  test('SIGTERM to push-secrets alone also stops the aws child and says the write is unknown', async () => {
    const { sandbox, checkout } = setup();
    const run = startCli({
      sandbox,
      args: ['--source', checkout],
      terminal: PUSH,
      env: { FAKE_AWS_BLOCK: 'secretsmanager create-secret', FAKE_AWS_IGNORE_HUP: '1' },
    });
    const blocked = await waitForBlocked(`${sandbox.state}.blocked`);
    process.kill(blocked.ppid, 'SIGTERM');
    expect(await run.exited).toBe(143);
    for (let tries = 0; tries < 50 && alive(blocked.pid); tries++) await Bun.sleep(100);
    const survived = alive(blocked.pid);
    if (survived) process.kill(blocked.pid, 'SIGKILL');
    expect(survived).toBe(false);
    expect(existsSync(dirname(blocked.path))).toBe(false);
    expect(run.output()).toContain('the secret write may or may not have completed; check with --dry-run');
    expectNoValues(run.output());
  }, 60_000);

  test('refusals go to stderr and the plan to stdout', () => {
    const { sandbox, checkout } = setup(sources({ prod: { TUNNEL_TOKEN: '' } }));
    const run = runPiped({ sandbox, args: ['--source', checkout, '--dry-run'] });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('error: TUNNEL_TOKEN not found in deploy/server/.env.production.local');
    expect(run.stdout).toContain('source: ');
    expect(run.stdout).not.toContain('error:');
    expectNoValues(run.stdout + run.stderr);
  });

  test('a missing --source or an unknown flag prints the usage', () => {
    const sandbox = makeSandbox({ roots });
    for (const args of [[], ['--source'], ['--source', '/x', '--force']]) {
      const run = runCli({ sandbox, args, terminal: 'none' });
      expect(run.code).toBe(2);
      expect(run.output).toContain('usage: bun deploy/server/push-secrets.ts --source <main checkout> [--dry-run]');
    }
  });
});

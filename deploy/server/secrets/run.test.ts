import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AwsResult, AwsRunner } from './aws-cli.ts';
import { KEYS_DIR, SECRET_KEYS } from './keys.ts';
import { runPush } from './run.ts';
import { awsSecretStore } from './secret-store.ts';
import type { Terminal } from './terminal.ts';
import {
  API_ENV,
  expectNoValues,
  type FixtureFiles,
  makeCheckout,
  sources,
  TARGET,
  without,
} from './testing/fixtures.ts';

// runPush in-process, with a scripted aws runner: the paths the CLI tests cannot reach cheaply.

type Script = (args: readonly string[]) => AwsResult;

const OK = (stdout: string): AwsResult => ({ status: 0, stdout, stderr: '' });
const ACCOUNT: Script = () => OK('455986776194\n');
const NOT_FOUND: AwsResult = {
  status: 254,
  stdout: '',
  stderr: 'An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: not found',
};

describe('runPush', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function push({
    files = sources(),
    script,
    keysDir = KEYS_DIR,
    sourceDir,
    typed = 'push',
  }: {
    files?: FixtureFiles;
    script: (args: readonly string[]) => AwsResult;
    keysDir?: string;
    sourceDir?: string;
    typed?: string;
  }) {
    const calls: string[][] = [];
    const run: AwsRunner = async (args) => {
      calls.push([...args]);
      return script(args);
    };
    const lines: string[] = [];
    const errorLines: string[] = [];
    const terminal: Terminal = { ask: () => typed, close: () => undefined };
    const code = await runPush({
      sourceDir: sourceDir ?? makeCheckout({ files, roots }),
      dryRun: false,
      terminal,
      store: awsSecretStore({ run }),
      run,
      log: (line) => lines.push(line),
      logError: (line) => errorLines.push(line),
      env: {},
      keysDir,
      secretKeys: SECRET_KEYS,
      target: TARGET,
    });
    const output = lines.join('\n');
    const errors = errorLines.join('\n');
    expectNoValues(output);
    expectNoValues(errors);
    expect(output).not.toContain('error:');
    return { code, output, errors, calls };
  }

  function byOperation(handlers: Record<string, Script>): Script {
    return (args) => {
      const handler = handlers[`${args[0]} ${args[1]}`];
      if (!handler) throw new Error(`unexpected aws ${args.slice(0, 2).join(' ')}`);
      return handler(args);
    };
  }

  test('a key in env/*.keys with no source stops the push before any aws call', async () => {
    const keysDir = mkdtempSync(join(tmpdir(), 'push-secrets-keys-'));
    roots.push(keysDir);
    writeFileSync(join(keysDir, 'api.keys'), `${Object.keys(SECRET_KEYS).join('\n')}\nBRAND_NEW_KEY\n`);
    const { code, errors, calls } = await push({ keysDir, script: ACCOUNT });
    expect(code).toBe(1);
    expect(errors).toContain('error: BRAND_NEW_KEY is in env/*.keys but has no source in secrets/keys.ts');
    expect(calls).toEqual([]);
  });

  test('a missing production-only file is named', async () => {
    const files = without({ record: sources(), keys: ['deploy/server/.env.production.local'] });
    const { code, errors, calls } = await push({ files, script: ACCOUNT });
    expect(code).toBe(1);
    expect(errors).toContain('error: deploy/server/.env.production.local not found under ');
    expect(calls).toEqual([]);
  });

  test('a missing portal file is only a note', async () => {
    const files = without({ record: sources(), keys: ['apps/portal/.env'] });
    const script = byOperation({
      'sts get-caller-identity': ACCOUNT,
      'secretsmanager get-secret-value': () => NOT_FOUND,
      'secretsmanager create-secret': () => OK('v-1\n'),
    });
    const { code, output } = await push({ files, script });
    expect(code).toBe(0);
    expect(output).toContain(
      'note: apps/portal/.env not found under the source; its copies of shared values are not compared',
    );
  });

  test('a source that is not a git checkout is refused', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'push-secrets-plain-'));
    roots.push(plain);
    const { code, errors, calls } = await push({ sourceDir: plain, script: ACCOUNT });
    expect(code).toBe(1);
    expect(errors).toContain('is not a git checkout; pass the main checkout of the repository');
    expect(calls).toEqual([]);
  });

  test('a source directory that does not exist is refused, not a crash', async () => {
    const missing = join(tmpdir(), 'push-secrets-missing-source-does-not-exist');
    const { code, errors, calls } = await push({ sourceDir: missing, script: ACCOUNT });
    expect(code).toBe(1);
    expect(errors).toBe(`error: ${missing} is not a git checkout; pass the main checkout of the repository`);
    expect(calls).toEqual([]);
  });

  test('a failed read is reported and nothing is written', async () => {
    const script = byOperation({
      'sts get-caller-identity': ACCOUNT,
      'secretsmanager get-secret-value': () => ({
        status: 254,
        stdout: '',
        stderr: 'An error occurred (AccessDeniedException) when calling the GetSecretValue operation: denied',
      }),
    });
    const { code, errors, calls } = await push({ script });
    expect(code).toBe(1);
    expect(errors).toContain('error: aws secretsmanager get-secret-value failed: An error occurred (AccessDeniedException)');
    expect(calls.map((call) => call[1])).toEqual(['get-caller-identity', 'get-secret-value']);
  });

  test('an error that echoes a value is redacted', async () => {
    const script = byOperation({
      'sts get-caller-identity': ACCOUNT,
      'secretsmanager get-secret-value': () => NOT_FOUND,
      'secretsmanager create-secret': () => ({
        status: 254,
        stdout: '',
        stderr: `An error occurred (ValidationException): bad value ${API_ENV.OPENAI_API_KEY}`,
      }),
    });
    const { code, errors } = await push({ script });
    expect(code).toBe(1);
    expect(errors).toContain('bad value <a secret value>');
  });

  test('every call names the region and none carries a value', async () => {
    const script = byOperation({
      'sts get-caller-identity': ACCOUNT,
      'secretsmanager get-secret-value': () => NOT_FOUND,
      'secretsmanager create-secret': () => OK('v-1\n'),
    });
    const { code, calls } = await push({ script });
    expect(code).toBe(0);
    for (const call of calls) expect(call.slice(-2)).toEqual(['--region', 'us-east-2']);
    expectNoValues(JSON.stringify(calls));
  });
});

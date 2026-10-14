import { describe, expect, it } from 'bun:test';
import {
  LOCAL_DEV_DATABASE_URL,
  buildMigrateCreateInvocation,
  runMigrateCreate,
} from './migrate-create';

const PROD_POOLER_URL =
  'postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres';

type Call = { command: string; args: string[]; env: Record<string, string | undefined> };

function recorder(exitCode = 0): { calls: Call[]; run: (call: Call) => number } {
  const calls: Call[] = [];
  return { calls, run: (call) => (calls.push(call), exitCode) };
}

describe('buildMigrateCreateInvocation', () => {
  it('targets comp_dev on 127.0.0.1', () => {
    expect(LOCAL_DEV_DATABASE_URL).toBe('postgresql://postgres:postgres@127.0.0.1:5432/comp_dev');
  });

  it('forces DATABASE_URL to comp_dev even when the environment points at the production pooler', () => {
    const invocation = buildMigrateCreateInvocation({
      argv: ['--name', 'add_widget'],
      env: { DATABASE_URL: PROD_POOLER_URL, PATH: '/bin' },
    });
    expect(invocation.env.DATABASE_URL).toBe(LOCAL_DEV_DATABASE_URL);
    expect(invocation.env.PATH).toBe('/bin');
    expect(invocation.command).toBe('bunx');
    expect(invocation.args).toEqual([
      'prisma',
      'migrate',
      'dev',
      '--create-only',
      '--name',
      'add_widget',
    ]);
  });

  it('drops other connection URLs so nothing can reach the shared database', () => {
    const invocation = buildMigrateCreateInvocation({
      argv: [],
      env: {
        DATABASE_URL: PROD_POOLER_URL,
        DIRECT_URL: PROD_POOLER_URL,
        DIRECT_DATABASE_URL: PROD_POOLER_URL,
        DATABASE_MIGRATION_URL: PROD_POOLER_URL,
        SHADOW_DATABASE_URL: PROD_POOLER_URL,
      },
    });
    const values = Object.values(invocation.env);
    expect(values).not.toContain(PROD_POOLER_URL);
  });

  it('accepts another local target given with --url', () => {
    const local = 'postgresql://postgres:postgres@localhost:55432/comp_dev';
    const invocation = buildMigrateCreateInvocation({
      argv: ['--url', local, '--name', 'x'],
      env: {},
    });
    expect(invocation.env.DATABASE_URL).toBe(local);
    expect(invocation.args).toEqual(['prisma', 'migrate', 'dev', '--create-only', '--name', 'x']);
  });

  it('accepts --url=<value>', () => {
    const local = 'postgresql://postgres:postgres@[::1]:5432/comp_dev';
    const invocation = buildMigrateCreateInvocation({ argv: [`--url=${local}`], env: {} });
    expect(invocation.env.DATABASE_URL).toBe(local);
  });

  it('refuses a non-local target', () => {
    expect(() =>
      buildMigrateCreateInvocation({ argv: ['--url', PROD_POOLER_URL], env: {} }),
    ).toThrow(/local/);
  });

  it('refuses --url without a value', () => {
    expect(() => buildMigrateCreateInvocation({ argv: ['--url'], env: {} })).toThrow(/--url/);
  });
});

describe('runMigrateCreate', () => {
  it('spawns prisma against comp_dev and returns its exit code', () => {
    const spawned = recorder(0);
    const code = runMigrateCreate({
      argv: ['--name', 'add_widget'],
      env: { DATABASE_URL: PROD_POOLER_URL },
      spawn: spawned.run,
      printError: () => undefined,
    });
    expect(code).toBe(0);
    expect(spawned.calls).toHaveLength(1);
    expect(spawned.calls[0]?.env.DATABASE_URL).toBe(LOCAL_DEV_DATABASE_URL);
  });

  it('exits non-zero with a message and spawns nothing when forced to a non-local host', () => {
    const spawned = recorder(0);
    const errors: string[] = [];
    const code = runMigrateCreate({
      argv: ['--url', PROD_POOLER_URL],
      env: {},
      spawn: spawned.run,
      printError: (line) => errors.push(line),
    });
    expect(code).not.toBe(0);
    expect(spawned.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/local/);
    expect(errors.join('\n')).not.toContain(':pw@');
  });

  it('propagates a failing prisma exit code', () => {
    const spawned = recorder(2);
    expect(
      runMigrateCreate({ argv: [], env: {}, spawn: spawned.run, printError: () => undefined }),
    ).toBe(2);
  });
});

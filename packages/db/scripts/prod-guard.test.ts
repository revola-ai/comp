import { describe, expect, it } from 'bun:test';
import { assertNotProduction, loadProductionTarget, runGuarded } from './prod-guard';

const TARGET = { projectRef: 'abcdefghijklmnop', poolerHost: 'aws-9-xx-test-1.pooler.example.com' };
const PROD_POOLER_URL = `postgresql://postgres.${TARGET.projectRef}:pw@${TARGET.poolerHost}:5432/postgres`;
const OTHER_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/comp';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('assertNotProduction', () => {
  it('refuses the production pooler host', () => {
    const run = () =>
      assertNotProduction({ databaseUrl: PROD_POOLER_URL, env: {}, target: TARGET });
    expect(run).toThrow(/COMP_I_AM_TOUCHING_PROD=1/);
    expect(codeOf(run)).toBe('production_target_refused');
  });

  it('compares the host case-insensitively', () => {
    const url = PROD_POOLER_URL.replace(TARGET.poolerHost, TARGET.poolerHost.toUpperCase());
    expect(codeOf(() => assertNotProduction({ databaseUrl: url, env: {}, target: TARGET }))).toBe(
      'production_target_refused',
    );
  });

  it("refuses the project's direct host too", () => {
    const url = `postgresql://postgres:pw@db.${TARGET.projectRef}.supabase.co:5432/postgres`;
    expect(codeOf(() => assertNotProduction({ databaseUrl: url, env: {}, target: TARGET }))).toBe(
      'production_target_refused',
    );
  });

  it('never prints the URL, host or password in the refusal', () => {
    try {
      assertNotProduction({ databaseUrl: PROD_POOLER_URL, env: {}, target: TARGET });
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(TARGET.poolerHost);
      expect(message).not.toContain(TARGET.projectRef);
      expect(message).not.toContain(':pw@');
    }
  });

  it('allows the production host with COMP_I_AM_TOUCHING_PROD=1', () => {
    expect(() =>
      assertNotProduction({
        databaseUrl: PROD_POOLER_URL,
        env: { COMP_I_AM_TOUCHING_PROD: '1' },
        target: TARGET,
      }),
    ).not.toThrow();
  });

  it('does not treat other values of COMP_I_AM_TOUCHING_PROD as consent', () => {
    for (const value of ['true', 'yes', '0', '']) {
      expect(
        codeOf(() =>
          assertNotProduction({
            databaseUrl: PROD_POOLER_URL,
            env: { COMP_I_AM_TOUCHING_PROD: value },
            target: TARGET,
          }),
        ),
      ).toBe('production_target_refused');
    }
  });

  it('allows another host', () => {
    expect(() =>
      assertNotProduction({ databaseUrl: OTHER_URL, env: {}, target: TARGET }),
    ).not.toThrow();
    expect(() =>
      assertNotProduction({
        databaseUrl: 'postgresql://u:p@db.other.example.com:5432/x',
        env: {},
        target: TARGET,
      }),
    ).not.toThrow();
  });

  it('fails closed on a missing or malformed URL', () => {
    expect(
      codeOf(() => assertNotProduction({ databaseUrl: undefined, env: {}, target: TARGET })),
    ).toBe('database_url_unverifiable');
    expect(
      codeOf(() => assertNotProduction({ databaseUrl: 'not a url', env: {}, target: TARGET })),
    ).toBe('database_url_unverifiable');
  });

  it('reads the committed production target by default', () => {
    const committed = loadProductionTarget();
    expect(committed.poolerHost.length).toBeGreaterThan(0);
    expect(committed.projectRef.length).toBeGreaterThan(0);
    const url = `postgresql://postgres.${committed.projectRef}:pw@${committed.poolerHost}:5432/postgres`;
    expect(codeOf(() => assertNotProduction({ databaseUrl: url, env: {} }))).toBe(
      'production_target_refused',
    );
  });
});

describe('runGuarded', () => {
  type Call = { command: string; args: string[]; env: Record<string, string | undefined> };

  function recorder(exitCode = 0): { calls: Call[]; run: (call: Call) => number } {
    const calls: Call[] = [];
    return { calls, run: (call) => (calls.push(call), exitCode) };
  }

  it('does not spawn the command against production and exits non-zero', () => {
    const spawned = recorder();
    const errors: string[] = [];
    const code = runGuarded({
      argv: ['prisma', 'migrate', 'dev'],
      env: { DATABASE_URL: PROD_POOLER_URL },
      target: TARGET,
      spawn: spawned.run,
      printError: (line) => errors.push(line),
    });
    expect(code).not.toBe(0);
    expect(spawned.calls).toHaveLength(0);
    expect(errors.join('\n')).toContain('prisma migrate dev');
    expect(errors.join('\n')).not.toContain(TARGET.poolerHost);
  });

  it('spawns the command with the same environment and returns its exit code', () => {
    const spawned = recorder(3);
    const env = { DATABASE_URL: OTHER_URL, OTHER: 'x' };
    const code = runGuarded({
      argv: ['prisma', 'migrate', 'reset', '--force'],
      env,
      target: TARGET,
      spawn: spawned.run,
      printError: () => undefined,
    });
    expect(code).toBe(3);
    expect(spawned.calls).toEqual([
      { command: 'prisma', args: ['migrate', 'reset', '--force'], env },
    ]);
  });

  it('spawns against production when the opt-in is set', () => {
    const spawned = recorder();
    const code = runGuarded({
      argv: ['bun', 'prisma/seed/seed.ts'],
      env: { DATABASE_URL: PROD_POOLER_URL, COMP_I_AM_TOUCHING_PROD: '1' },
      target: TARGET,
      spawn: spawned.run,
      printError: () => undefined,
    });
    expect(code).toBe(0);
    expect(spawned.calls).toHaveLength(1);
  });

  it('exits non-zero with usage when no command is given', () => {
    const spawned = recorder();
    const errors: string[] = [];
    const code = runGuarded({
      argv: [],
      env: { DATABASE_URL: OTHER_URL },
      target: TARGET,
      spawn: spawned.run,
      printError: (line) => errors.push(line),
    });
    expect(code).not.toBe(0);
    expect(spawned.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/usage/i);
  });
});

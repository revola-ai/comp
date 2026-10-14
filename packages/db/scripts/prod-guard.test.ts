import { describe, expect, it } from 'bun:test';
import { assertNotProduction, loadProductionTarget, runGuarded } from './prod-guard';
import { hashProjectRef } from './production-target';

const REF = 'abcdefghijklmnopqrst';
const TARGET = {
  projectRefSha256: hashProjectRef(REF),
  poolerHost: 'aws-9-xx-test-1.pooler.supabase.com',
};
const PROD_POOLER_URL = `postgresql://postgres.${REF}:pw@${TARGET.poolerHost}:5432/postgres`;
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
  it('refuses the production pooler user', () => {
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
    const url = `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`;
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
      expect(message).not.toContain(REF);
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

  it('reads the committed production target by default (the ref only as a hash)', () => {
    const committed = loadProductionTarget();
    expect(committed.projectRefSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(committed.poolerHost.endsWith('.pooler.supabase.com')).toBe(true);
    // The shared regional pooler host alone is not production: another project's user is allowed.
    const url = `postgresql://postgres.zyxwvutsrqponmlkjihg:pw@${committed.poolerHost}:5432/postgres`;
    expect(assertNotProduction({ databaseUrl: url, env: {} })).toBe('not_production');
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

  it('redacts URL-looking arguments in the refusal', () => {
    const errors: string[] = [];
    runGuarded({
      argv: ['bunx', 'prisma', 'db', 'execute', '--url', PROD_POOLER_URL, '--file', 'x.sql'],
      env: { DATABASE_URL: PROD_POOLER_URL },
      target: TARGET,
      spawn: recorder().run,
      printError: (line) => errors.push(line),
    });
    const message = errors.join('\n');
    expect(message).toContain('bunx prisma db execute --url <redacted> --file x.sql');
    for (const secret of [REF, TARGET.poolerHost, ':pw@', 'postgresql://']) {
      expect(message).not.toContain(secret);
    }
  });

  it('redacts any argument that mentions postgres, even without a scheme', () => {
    const errors: string[] = [];
    runGuarded({
      argv: ['psql', `postgres.${REF}@somewhere`],
      env: { DATABASE_URL: PROD_POOLER_URL },
      target: TARGET,
      spawn: recorder().run,
      printError: (line) => errors.push(line),
    });
    expect(errors.join('\n')).toContain('psql <redacted>');
    expect(errors.join('\n')).not.toContain(REF);
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

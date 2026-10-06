import { describe, expect, it } from 'bun:test';
import { classifyPrismaCommand, enforcePrismaCliGuard } from './prisma-cli-guard';

const TARGET = { projectRef: 'abcdefghijklmnop', poolerHost: 'aws-9-xx-test-1.pooler.example.com' };
const PROD_URL = `postgresql://postgres.${TARGET.projectRef}:pw@${TARGET.poolerHost}:5432/postgres`;
const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/comp';

describe('classifyPrismaCommand', () => {
  const table: Array<[string[], boolean, string]> = [
    [['migrate', 'dev'], true, 'migrate dev'],
    [['migrate', 'dev', '--create-only', '--name', 'add_widget'], true, 'migrate dev'],
    [['migrate', 'reset', '--force'], true, 'migrate reset'],
    [['db', 'push', '--skip-generate', '--accept-data-loss'], true, 'db push'],
    [['db', 'seed'], true, 'db seed'],
    [['--schema', 'prisma/schema', 'migrate', 'dev'], true, 'migrate dev'],
    [['migrate', '--schema', 'prisma/schema', 'reset'], true, 'migrate reset'],
    [['generate'], false, 'generate'],
    [['generate', '--schema=prisma/schema'], false, 'generate'],
    [['migrate', 'deploy'], false, 'migrate deploy'],
    [['migrate', 'status'], false, 'migrate status'],
    [['migrate', 'diff', '--from-empty', '--to-schema', 'dev'], false, 'migrate diff'],
    [['studio'], false, 'studio'],
    [['db', 'pull'], false, 'db pull'],
    [['validate'], false, 'validate'],
    [['migrate', 'dev', '--help'], false, 'migrate dev'],
    [['db', 'push', '-h'], false, 'db push'],
    [[], false, ''],
  ];
  for (const [args, guarded, command] of table) {
    it(`${guarded ? 'guards' : 'allows'} \`prisma ${args.join(' ')}\``, () => {
      expect(classifyPrismaCommand(args)).toEqual({ guarded, command });
    });
  }
});

type Outcome = { exitCode: number | undefined; errors: string[] };

function run({ args, env }: { args: string[]; env: Record<string, string | undefined> }): Outcome {
  const outcome: Outcome = { exitCode: undefined, errors: [] };
  enforcePrismaCliGuard({
    argv: ['/usr/bin/node', '/repo/node_modules/prisma/build/index.js', ...args],
    env,
    target: TARGET,
    exit: (code) => {
      outcome.exitCode = code;
    },
    printError: (line) => outcome.errors.push(line),
  });
  return outcome;
}

describe('enforcePrismaCliGuard', () => {
  for (const args of [
    ['migrate', 'dev'],
    ['migrate', 'reset'],
    ['db', 'push'],
    ['db', 'seed'],
  ]) {
    it(`refuses \`prisma ${args.join(' ')}\` against the production target and exits 1`, () => {
      const outcome = run({ args, env: { DATABASE_URL: PROD_URL } });
      expect(outcome.exitCode).toBe(1);
      const message = outcome.errors.join('\n');
      expect(message).toContain(`prisma ${args.join(' ')}`);
      expect(message).toContain('COMP_I_AM_TOUCHING_PROD=1');
      expect(message).not.toContain(TARGET.poolerHost);
      expect(message).not.toContain(':pw@');
    });
  }

  it('lets a guarded command through with COMP_I_AM_TOUCHING_PROD=1 and says so once', () => {
    const outcome = run({
      args: ['migrate', 'dev'],
      env: { DATABASE_URL: PROD_URL, COMP_I_AM_TOUCHING_PROD: '1' },
    });
    expect(outcome.exitCode).toBeUndefined();
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toContain('COMP_I_AM_TOUCHING_PROD=1');
  });

  it('lets a guarded command through silently for a local host', () => {
    const outcome = run({
      args: ['migrate', 'reset', '--force'],
      env: { DATABASE_URL: LOCAL_URL },
    });
    expect(outcome).toEqual({ exitCode: undefined, errors: [] });
  });

  it('lets allowed commands through against production', () => {
    for (const args of [['generate'], ['migrate', 'deploy'], ['migrate', 'status'], ['studio']]) {
      expect(run({ args, env: { DATABASE_URL: PROD_URL } })).toEqual({
        exitCode: undefined,
        errors: [],
      });
    }
  });

  it('refuses a guarded command when DATABASE_URL is missing', () => {
    expect(run({ args: ['db', 'push'], env: {} }).exitCode).toBe(1);
  });
});

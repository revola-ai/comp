import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertNotProduction,
  hashProjectRef,
  productionTargetSchema,
  readProductionTargetFile,
  refuseProductionEntryPoint,
} from './production-target';

const REF = 'abcdefghijklmnopqrst';
const POOLER = 'aws-9-xx-test-1.pooler.supabase.com';
const TARGET = { projectRefSha256: hashProjectRef(REF), poolerHost: POOLER };
const PROD_POOLER_URL = `postgresql://postgres.${REF}:pw@${POOLER}:5432/postgres`;

describe('hashProjectRef', () => {
  it('is the lowercase hex SHA-256 of the lowercased ref', () => {
    const expected = createHash('sha256').update(REF).digest('hex');
    expect(hashProjectRef(REF)).toBe(expected);
    expect(hashProjectRef(REF.toUpperCase())).toBe(expected);
  });
});

describe('productionTargetSchema', () => {
  it('accepts a hash and a pooler host', () => {
    expect(productionTargetSchema.parse(TARGET)).toEqual(TARGET);
  });

  it('refuses a plain projectRef key, so the ref is never committed again', () => {
    expect(() => productionTargetSchema.parse({ ...TARGET, projectRef: REF })).toThrow();
  });

  it('refuses a hash that is not 64 lowercase hex characters', () => {
    for (const bad of [REF, 'A'.repeat(64), 'a'.repeat(63)]) {
      expect(() => productionTargetSchema.parse({ ...TARGET, projectRefSha256: bad })).toThrow(
        /projectRefSha256/,
      );
    }
  });

  it('refuses a pooler host outside pooler.supabase.com', () => {
    expect(() => productionTargetSchema.parse({ ...TARGET, poolerHost: 'db.example.com' })).toThrow(
      /poolerHost/,
    );
  });
});

describe('the committed production-target.json', () => {
  const raw = readFileSync(resolve(import.meta.dir, '..', 'production-target.json'), 'utf8');

  it('holds only the ref hash and the pooler host', () => {
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['poolerHost', 'projectRefSha256']);
  });

  it('parses with the shared schema', () => {
    expect(readProductionTargetFile()).toEqual(productionTargetSchema.parse(JSON.parse(raw)));
  });
});

describe('assertNotProduction identifies production by the project ref', () => {
  const check = (databaseUrl: string) =>
    assertNotProduction({ databaseUrl, env: {}, target: TARGET });

  it('refuses the pooler user postgres.<ref>', () => {
    expect(() => check(PROD_POOLER_URL)).toThrow(/production_target_refused/);
  });

  it('refuses the pooler user on another regional pooler host', () => {
    expect(() =>
      check(`postgresql://postgres.${REF}:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`),
    ).toThrow(/production_target_refused/);
  });

  it('refuses the direct host db.<ref>.supabase.co', () => {
    expect(() => check(`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`)).toThrow(
      /production_target_refused/,
    );
  });

  it('allows another project on the same regional pooler host', () => {
    expect(check(`postgresql://postgres.zyxwvutsrqponmlkjihg:pw@${POOLER}:5432/postgres`)).toBe(
      'not_production',
    );
  });

  it('allows a local database', () => {
    expect(check('postgresql://postgres:postgres@127.0.0.1:5432/comp_dev')).toBe('not_production');
  });

  it('never puts the URL, ref, host or password in the refusal', () => {
    let message = '';
    try {
      check(PROD_POOLER_URL);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('COMP_I_AM_TOUCHING_PROD=1');
    for (const secret of [REF, POOLER, ':pw@']) expect(message).not.toContain(secret);
  });
});

describe('refuseProductionEntryPoint', () => {
  type Outcome = { exitCode: number | undefined; errors: string[] };

  function run(env: Record<string, string | undefined>): Outcome {
    const outcome: Outcome = { exitCode: undefined, errors: [] };
    refuseProductionEntryPoint({
      name: 'bun prisma/seed/seed.ts',
      env,
      target: TARGET,
      exit: (code) => {
        outcome.exitCode = code;
      },
      printError: (line) => outcome.errors.push(line),
    });
    return outcome;
  }

  it('exits 1 against production, naming the entry point and the opt-in', () => {
    const outcome = run({ DATABASE_URL: PROD_POOLER_URL });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.errors.join('\n')).toContain('bun prisma/seed/seed.ts');
    expect(outcome.errors.join('\n')).toContain('COMP_I_AM_TOUCHING_PROD=1');
    expect(outcome.errors.join('\n')).not.toContain(REF);
  });

  it('exits 1 when DATABASE_URL cannot be checked', () => {
    expect(run({}).exitCode).toBe(1);
  });

  it('lets production through with the opt-in and says so once', () => {
    const outcome = run({ DATABASE_URL: PROD_POOLER_URL, COMP_I_AM_TOUCHING_PROD: '1' });
    expect(outcome.exitCode).toBeUndefined();
    expect(outcome.errors).toHaveLength(1);
  });

  it('is silent for another database', () => {
    expect(run({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/comp_dev' })).toEqual({
      exitCode: undefined,
      errors: [],
    });
  });
});

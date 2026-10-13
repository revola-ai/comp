import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPgAdapterOptions, tlsModeOf } from './pg-adapter-options';
import { hashProjectRef } from './production-target';

// Laptops share production's database (D7) and run with NODE_ENV=development, so the
// production TLS rules follow the database the URL names, not NODE_ENV. The committed
// target holds only the ref's hash, so these tests inject a target of their own.
const REF = 'abcdefghijklmnopqrst';
const POOLER = 'aws-9-xx-test-1.pooler.supabase.com';
const TARGET = { projectRefSha256: hashProjectRef(REF), poolerHost: POOLER };
const PROD_POOLER_URL = `postgresql://postgres.${REF}:s3cret@${POOLER}:5432/postgres`;
const PROD_DIRECT_URL = `postgresql://postgres:s3cret@db.${REF}.supabase.co:5432/postgres`;
const OTHER_PROJECT_URL = `postgresql://postgres.zyxwvutsrqponmlkjihg:s3cret@${POOLER}:5432/postgres`;
const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/comp';

let caDir = '';
let caPath = '';

beforeAll(() => {
  caDir = mkdtempSync(join(tmpdir(), 'pg-adapter-production-target-'));
  caPath = join(caDir, 'ca.crt');
  writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
});

afterAll(() => {
  rmSync(caDir, { recursive: true, force: true });
});

function build({ databaseUrl, env }: { databaseUrl: string; env: Record<string, string> }) {
  return buildPgAdapterOptions({ databaseUrl, env, target: TARGET, log: () => undefined });
}

function failureOf(run: () => unknown): { code?: string; message: string } {
  try {
    run();
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { code, message };
  }
  return { message: '' };
}

describe('buildPgAdapterOptions: the production database outside NODE_ENV=production', () => {
  for (const nodeEnv of ['development', 'test', undefined]) {
    for (const [name, databaseUrl] of [
      ['pooler user', PROD_POOLER_URL],
      ['direct host', PROD_DIRECT_URL],
    ] as const) {
      it(`requires DATABASE_SSL_CA for the ${name} with NODE_ENV=${nodeEnv ?? '(unset)'}`, () => {
        const env: Record<string, string> = nodeEnv ? { NODE_ENV: nodeEnv } : {};
        const failure = failureOf(() => build({ databaseUrl, env }));
        expect(failure.code).toBe('ca_file_missing');
        expect(failure.message).toContain('deploy/aws/certs/supabase-ca.crt');
        expect(failure.message).not.toContain('s3cret');
        expect(failure.message).not.toContain(REF);
      });
    }
  }

  for (const param of ['ssl=false', 'ssl=0', 'sslmode=disable', 'sslrootcert=/no/such/ca.crt']) {
    it(`refuses ${param} on the production database with ssl_param_conflict`, () => {
      const failure = failureOf(() =>
        build({
          databaseUrl: `${PROD_POOLER_URL}?${param}`,
          env: { NODE_ENV: 'development', DATABASE_SSL_CA: caPath },
        }),
      );
      expect(failure.code).toBe('ssl_param_conflict');
      expect(failure.message).not.toContain('s3cret');
    });
  }

  it('verifies chain and hostname for the production database with DATABASE_SSL_CA set', () => {
    const options = build({
      databaseUrl: `${PROD_POOLER_URL}?sslmode=require`,
      env: { NODE_ENV: 'development', DATABASE_SSL_CA: caPath },
    });
    expect(tlsModeOf(options.ssl)).toBe('verified');
    expect(options.connectionString).not.toContain('sslmode');
  });

  it('keeps PRISMA_ALLOW_INSECURE_TLS=1 as the explicit opt-out', () => {
    const options = build({
      databaseUrl: PROD_POOLER_URL,
      env: { NODE_ENV: 'development', PRISMA_ALLOW_INSECURE_TLS: '1' },
    });
    expect(tlsModeOf(options.ssl)).toBe('insecure');
  });
});

describe('buildPgAdapterOptions: other databases outside production keep the current behaviour', () => {
  it('allows chain-only TLS for another project on the same pooler', () => {
    const options = build({ databaseUrl: OTHER_PROJECT_URL, env: { NODE_ENV: 'development' } });
    expect(tlsModeOf(options.ssl)).toBe('chain-only');
  });

  it('does not refuse TLS parameters on another project', () => {
    expect(() =>
      build({ databaseUrl: `${OTHER_PROJECT_URL}?ssl=false`, env: { NODE_ENV: 'development' } }),
    ).not.toThrow();
  });

  it('leaves a local database untouched', () => {
    const options = build({ databaseUrl: LOCAL_URL, env: { NODE_ENV: 'development' } });
    expect(options.ssl).toBeUndefined();
    expect(options.connectionString).toBe(LOCAL_URL);
  });

  it('defaults to the committed production target', () => {
    const options = buildPgAdapterOptions({
      databaseUrl: OTHER_PROJECT_URL,
      env: { NODE_ENV: 'development' },
      log: () => undefined,
    });
    expect(tlsModeOf(options.ssl)).toBe('chain-only');
  });
});

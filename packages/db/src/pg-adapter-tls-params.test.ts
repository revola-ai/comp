import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'pg-connection-string';
import { buildPgAdapterOptions, tlsModeOf, type PgAdapterOptions } from './pg-adapter-options';
import type { SslConfig } from './ssl-config';

// pg merges the parsed connection string OVER the explicit options
// (pg/lib/connection-parameters.js: Object.assign({}, config, parse(connectionString))),
// so a TLS parameter left in the URL replaces the enforced `ssl` config.
const BASE = 'postgresql://postgres.ref:s3cret@pooler.example.com:5432/postgres';

let caDir = '';
let production: Record<string, string> = {};

beforeAll(() => {
  caDir = mkdtempSync(join(tmpdir(), 'pg-adapter-tls-params-'));
  const caPath = join(caDir, 'ca.crt');
  writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  production = { NODE_ENV: 'production', DATABASE_SSL_CA: caPath };
});

afterAll(() => {
  rmSync(caDir, { recursive: true, force: true });
});

function build({ databaseUrl, env }: { databaseUrl: string; env: Record<string, string> }) {
  const lines: string[] = [];
  const options = buildPgAdapterOptions({ databaseUrl, env, log: (line) => lines.push(line) });
  return { options, lines };
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

/** The ssl value pg actually uses for these adapter options. */
function effectiveSsl(options: PgAdapterOptions): unknown {
  const merged: Record<string, unknown> = { ssl: options.ssl, ...parse(options.connectionString) };
  return merged.ssl;
}

const CONFLICTS = [
  'ssl=0',
  'ssl=false',
  'ssl=1',
  'ssl=true',
  'ssl=no-verify',
  'sslmode=disable',
  'sslmode=allow',
  'sslmode=prefer',
  'sslmode=no-verify',
  'sslmode=bogus',
  'sslrootcert=/tmp/other-ca.crt',
  'sslcert=/tmp/client.crt',
  'sslkey=/tmp/client.key',
  'uselibpqcompat=true',
  'sslnegotiation=direct',
];

describe('buildPgAdapterOptions: URL TLS parameters in production', () => {
  for (const param of CONFLICTS) {
    it(`refuses ${param} with ssl_param_conflict, naming the parameter but not the URL`, () => {
      const failure = failureOf(() => build({ databaseUrl: `${BASE}?${param}`, env: production }));
      expect(failure.code).toBe('ssl_param_conflict');
      expect(failure.message).toContain(param.split('=')[0]);
      expect(failure.message).not.toContain('s3cret');
      expect(failure.message).not.toContain('pooler.example.com');
    });
  }

  it('refuses a conflicting parameter under the PRISMA_ALLOW_INSECURE_TLS=1 opt-out too', () => {
    const env = { NODE_ENV: 'production', PRISMA_ALLOW_INSECURE_TLS: '1' };
    expect(failureOf(() => build({ databaseUrl: `${BASE}?ssl=0`, env })).code).toBe(
      'ssl_param_conflict',
    );
  });

  for (const mode of ['require', 'verify-ca', 'verify-full']) {
    it(`strips sslmode=${mode}, which the enforced verified TLS already satisfies`, () => {
      const { options } = build({ databaseUrl: `${BASE}?sslmode=${mode}`, env: production });
      expect(options.connectionString).not.toContain('sslmode');
      expect(effectiveSsl(options)).toBe(options.ssl);
      expect(tlsModeOf(options.ssl)).toBe('verified');
    });
  }

  it('keeps unrelated parameters', () => {
    const { options } = build({
      databaseUrl: `${BASE}?sslmode=require&application_name=comp-api`,
      env: production,
    });
    expect(new URL(options.connectionString).searchParams.get('application_name')).toBe('comp-api');
  });

  it('logs the TLS mode pg will actually use', () => {
    for (const databaseUrl of [BASE, `${BASE}?sslmode=require`, `${BASE}?sslmode=verify-full`]) {
      const { options, lines } = build({ databaseUrl, env: production });
      const effective = effectiveSsl(options) as SslConfig;
      expect(lines.join('\n')).toContain(`TLS ${tlsModeOf(effective)}`);
      expect(effective).toBe(options.ssl);
    }
  });

  it('treats a host query parameter as the host pg connects to', () => {
    const databaseUrl = 'postgresql://u:s3cret@localhost:5432/postgres?host=db.example.com';
    expect(failureOf(() => build({ databaseUrl, env: { NODE_ENV: 'production' } })).code).toBe(
      'ca_file_missing',
    );
    const { options } = build({ databaseUrl, env: production });
    expect(tlsModeOf(options.ssl)).toBe('verified');
  });
});

describe('buildPgAdapterOptions: URL TLS parameters elsewhere keep the current behaviour', () => {
  it('leaves a local URL untouched in production', () => {
    const databaseUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/comp?ssl=0';
    const { options } = build({ databaseUrl, env: production });
    expect(options.connectionString).toBe(databaseUrl);
    expect(options.ssl).toBeUndefined();
  });

  it('does not refuse outside production', () => {
    const { options } = build({ databaseUrl: `${BASE}?ssl=0`, env: {} });
    expect(tlsModeOf(options.ssl)).toBe('chain-only');
  });
});

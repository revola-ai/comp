import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATABASE_CONNECT_TIMEOUT_MS, buildPgAdapterOptions } from './pg-adapter-options';

const REMOTE_URL =
  'postgresql://postgres.ref:s3cret@pooler.example.com:5432/postgres?sslmode=require';
const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/comp';

let caDir = '';
let caPath = '';

beforeAll(() => {
  caDir = mkdtempSync(join(tmpdir(), 'pg-adapter-options-'));
  caPath = join(caDir, 'ca.crt');
  writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
});

afterAll(() => {
  rmSync(caDir, { recursive: true, force: true });
});

function silent(): (line: string) => void {
  return () => undefined;
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('buildPgAdapterOptions: pool size', () => {
  it('leaves max unset when DATABASE_POOL_MAX is unset (driver default unchanged)', () => {
    const options = buildPgAdapterOptions({ databaseUrl: LOCAL_URL, env: {}, log: silent() });
    expect('max' in options).toBe(false);
  });

  it('treats an empty DATABASE_POOL_MAX as unset', () => {
    const options = buildPgAdapterOptions({
      databaseUrl: LOCAL_URL,
      env: { DATABASE_POOL_MAX: '' },
      log: silent(),
    });
    expect('max' in options).toBe(false);
  });

  it('sets max from DATABASE_POOL_MAX', () => {
    const options = buildPgAdapterOptions({
      databaseUrl: LOCAL_URL,
      env: { DATABASE_POOL_MAX: '7' },
      log: silent(),
    });
    expect(options.max).toBe(7);
  });

  it('accepts the bounds 1 and 50', () => {
    expect(
      buildPgAdapterOptions({
        databaseUrl: LOCAL_URL,
        env: { DATABASE_POOL_MAX: '1' },
        log: silent(),
      }).max,
    ).toBe(1);
    expect(
      buildPgAdapterOptions({
        databaseUrl: LOCAL_URL,
        env: { DATABASE_POOL_MAX: '50' },
        log: silent(),
      }).max,
    ).toBe(50);
  });

  for (const invalid of ['0', '51', 'ten', '2.5', '-3', '10abc']) {
    it(`rejects DATABASE_POOL_MAX=${invalid} with pool_max_invalid naming the variable`, () => {
      const run = () =>
        buildPgAdapterOptions({
          databaseUrl: LOCAL_URL,
          env: { DATABASE_POOL_MAX: invalid },
          log: silent(),
        });
      expect(run).toThrow(/DATABASE_POOL_MAX/);
      expect(codeOf(run)).toBe('pool_max_invalid');
    });
  }
});

describe('buildPgAdapterOptions: TLS', () => {
  it('disables TLS and keeps the URL for a local host', () => {
    const options = buildPgAdapterOptions({ databaseUrl: LOCAL_URL, env: {}, log: silent() });
    expect(options.ssl).toBeUndefined();
    expect(options.connectionString).toBe(LOCAL_URL);
  });

  it('uses the CA from DATABASE_SSL_CA and strips sslmode for a remote host', () => {
    const options = buildPgAdapterOptions({
      databaseUrl: REMOTE_URL,
      env: { DATABASE_SSL_CA: caPath },
      log: silent(),
    });
    expect(options.ssl && 'ca' in options.ssl).toBe(true);
    expect(options.connectionString).not.toContain('sslmode');
  });

  it('throws database_url_invalid for a malformed URL without echoing it', () => {
    const run = () =>
      buildPgAdapterOptions({ databaseUrl: 'postgres://u:s3cret@ bad', env: {}, log: silent() });
    expect(codeOf(run)).toBe('database_url_invalid');
    expect(run).not.toThrow(/s3cret/);
  });

  it('throws database_url_missing when the URL is absent', () => {
    expect(
      codeOf(() => buildPgAdapterOptions({ databaseUrl: undefined, env: {}, log: silent() })),
    ).toBe('database_url_missing');
    expect(codeOf(() => buildPgAdapterOptions({ databaseUrl: '', env: {}, log: silent() }))).toBe(
      'database_url_missing',
    );
  });
});

describe('buildPgAdapterOptions: production rule', () => {
  it('throws ca_file_missing in production for a remote host without DATABASE_SSL_CA', () => {
    const run = () =>
      buildPgAdapterOptions({
        databaseUrl: REMOTE_URL,
        env: { NODE_ENV: 'production' },
        log: silent(),
      });
    expect(run).toThrow(/ca_file_missing/);
    expect(run).toThrow(/DATABASE_SSL_CA/);
    expect(codeOf(run)).toBe('ca_file_missing');
  });

  it('treats an explicitly emptied DATABASE_SSL_CA as missing', () => {
    const run = () =>
      buildPgAdapterOptions({
        databaseUrl: REMOTE_URL,
        env: { NODE_ENV: 'production', DATABASE_SSL_CA: '', PRISMA_ALLOW_INSECURE_TLS: '' },
        log: silent(),
      });
    expect(codeOf(run)).toBe('ca_file_missing');
  });

  it('never puts the URL or its password in the error', () => {
    try {
      buildPgAdapterOptions({
        databaseUrl: REMOTE_URL,
        env: { NODE_ENV: 'production' },
        log: silent(),
      });
      throw new Error('expected a throw');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('s3cret');
      expect(String((error as Error).message)).not.toContain('pooler.example.com');
    }
  });

  it('throws ca_file_missing in production when DATABASE_SSL_CA names a missing file', () => {
    const run = () =>
      buildPgAdapterOptions({
        databaseUrl: REMOTE_URL,
        env: { NODE_ENV: 'production', DATABASE_SSL_CA: join(caDir, 'absent.crt') },
        log: silent(),
      });
    expect(codeOf(run)).toBe('ca_file_missing');
  });

  it('accepts production with DATABASE_SSL_CA set', () => {
    const options = buildPgAdapterOptions({
      databaseUrl: REMOTE_URL,
      env: { NODE_ENV: 'production', DATABASE_SSL_CA: caPath },
      log: silent(),
    });
    expect(options.ssl && 'ca' in options.ssl).toBe(true);
  });

  it('accepts production with the explicit PRISMA_ALLOW_INSECURE_TLS=1 opt-out', () => {
    const options = buildPgAdapterOptions({
      databaseUrl: REMOTE_URL,
      env: { NODE_ENV: 'production', PRISMA_ALLOW_INSECURE_TLS: '1' },
      log: silent(),
    });
    expect(options.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('does not require a CA for a local host in production', () => {
    const options = buildPgAdapterOptions({
      databaseUrl: LOCAL_URL,
      env: { NODE_ENV: 'production' },
      log: silent(),
    });
    expect(options.ssl).toBeUndefined();
  });

  it('does not require a CA outside production', () => {
    const options = buildPgAdapterOptions({
      databaseUrl: REMOTE_URL,
      env: { NODE_ENV: 'development' },
      log: silent(),
    });
    expect(options.ssl).toBeDefined();
  });
});

describe('buildPgAdapterOptions: startup log', () => {
  it('logs the resolved TLS mode once per sink, without the URL', () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    buildPgAdapterOptions({ databaseUrl: REMOTE_URL, env: { DATABASE_SSL_CA: caPath }, log });
    buildPgAdapterOptions({ databaseUrl: REMOTE_URL, env: { DATABASE_SSL_CA: caPath }, log });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('verified');
    expect(lines[0]).not.toContain('pooler.example.com');
    expect(lines[0]).not.toContain('s3cret');
  });

  it('names each mode', () => {
    const modeFor = (databaseUrl: string, env: Record<string, string>) => {
      const lines: string[] = [];
      buildPgAdapterOptions({ databaseUrl, env, log: (line) => lines.push(line) });
      return lines[0] ?? '';
    };
    expect(modeFor(LOCAL_URL, {})).toContain('disabled');
    expect(modeFor(REMOTE_URL, { PRISMA_ALLOW_INSECURE_TLS: '1' })).toContain('insecure');
    expect(modeFor(REMOTE_URL, {})).toContain('chain-only');
  });
});

describe('buildPgAdapterOptions: connection timeout', () => {
  it('bounds connecting and waiting for a pooled connection (pg waits forever by default)', () => {
    for (const databaseUrl of [LOCAL_URL, REMOTE_URL]) {
      const options = buildPgAdapterOptions({ databaseUrl, env: {}, log: silent() });
      expect(options.connectionTimeoutMillis).toBe(DATABASE_CONNECT_TIMEOUT_MS);
    }
    expect(DATABASE_CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

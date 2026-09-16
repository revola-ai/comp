import { describe, it, expect } from 'bun:test';
import { resolveSslConfig } from './ssl-config';

describe('resolveSslConfig', () => {
  it('returns undefined for localhost', () => {
    expect(resolveSslConfig('postgresql://u:p@localhost:5432/x', {})).toBeUndefined();
  });

  it('returns undefined for 127.0.0.1', () => {
    expect(resolveSslConfig('postgresql://u:p@127.0.0.1:5432/x', {})).toBeUndefined();
  });

  it('returns undefined for ::1', () => {
    expect(resolveSslConfig('postgresql://u:p@[::1]:5432/x', {})).toBeUndefined();
  });

  it('returns rejectUnauthorized:false when PRISMA_ALLOW_INSECURE_TLS=1', () => {
    expect(
      resolveSslConfig('postgresql://u:p@db.prod.example.com:5432/x', {
        PRISMA_ALLOW_INSECURE_TLS: '1',
      }),
    ).toEqual({ rejectUnauthorized: false });
  });

  it('returns checkServerIdentity-noop for remote URLs (verified TLS via Node defaults)', () => {
    const result = resolveSslConfig('postgresql://u:p@db.prod.example.com:5432/x', {});
    expect(result).toBeDefined();
    expect(typeof (result as { checkServerIdentity: unknown }).checkServerIdentity).toBe('function');
    expect((result as { checkServerIdentity: () => undefined }).checkServerIdentity()).toBeUndefined();
  });

  it('treats malformed URLs as remote (defensive)', () => {
    const result = resolveSslConfig('not-a-valid-url', {});
    expect(result).toBeDefined();
    expect(typeof (result as { checkServerIdentity: unknown }).checkServerIdentity).toBe('function');
  });
});

describe('resolveSslConfig with DATABASE_SSL_CA', () => {
  const caPath = `${import.meta.dir}/../certs/test-ca.crt`;
  const fs = require('node:fs') as typeof import('node:fs');

  it('verifies against Node defaults plus the given CA file, with hostname checking', () => {
    fs.mkdirSync(`${import.meta.dir}/../certs`, { recursive: true });
    fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    try {
      const result = resolveSslConfig('postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/x', {
        DATABASE_SSL_CA: caPath,
      });
      expect(result).toBeDefined();
      const ca = (result as { ca: string[] }).ca;
      expect(Array.isArray(ca)).toBe(true);
      expect(ca.at(-1)).toContain('BEGIN CERTIFICATE');
      expect(ca.length).toBeGreaterThan(1);
      expect('checkServerIdentity' in (result as object)).toBe(false);
      expect('rejectUnauthorized' in (result as object)).toBe(false);
    } finally {
      fs.rmSync(caPath, { force: true });
    }
  });

  it('takes precedence over PRISMA_ALLOW_INSECURE_TLS', () => {
    fs.writeFileSync(caPath, 'CERT');
    try {
      const result = resolveSslConfig('postgresql://u:p@db.example.com:5432/x', {
        DATABASE_SSL_CA: caPath,
        PRISMA_ALLOW_INSECURE_TLS: '1',
      });
      expect('ca' in (result as object)).toBe(true);
    } finally {
      fs.rmSync(caPath, { force: true });
    }
  });

  it('is ignored for localhost', () => {
    expect(resolveSslConfig('postgresql://u:p@localhost:5432/x', { DATABASE_SSL_CA: caPath })).toBeUndefined();
  });

  it('throws a clear error when the CA file does not exist', () => {
    expect(() =>
      resolveSslConfig('postgresql://u:p@db.example.com:5432/x', { DATABASE_SSL_CA: '/nonexistent/ca.crt' }),
    ).toThrow(/DATABASE_SSL_CA/);
  });
});

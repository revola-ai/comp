import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FORWARDED_AUTH_HEADER,
  getPublicApiUrl,
  getServerApiBaseUrl,
  getServerApiHeaders,
} from './server-api-base-url';

// Whole-tree source scans read thousands of files; under a parallel run they
// can exceed vitest's 5 s default without anything being wrong.
const SCAN_TIMEOUT_MS = 30_000;

const SRC = resolve(__dirname, '..');

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSources(full);
    return /\.(ts|tsx|mts|mjs|js)$/.test(entry.name) ? [full] : [];
  });
}
const ENV_KEYS = [
  'BACKEND_API_URL',
  'NEXT_PUBLIC_API_URL',
  'INTERNAL_API_TOKEN',
  'COMP_FORWARDED_IP_TOKEN',
] as const;

describe('getServerApiBaseUrl', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('prefers BACKEND_API_URL (the Service Connect address)', () => {
    vi.stubEnv('BACKEND_API_URL', 'http://comp-api.comp.internal:3333');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.comp.revola.ai');
    expect(getServerApiBaseUrl()).toBe('http://comp-api.comp.internal:3333');
  });

  it('falls back to NEXT_PUBLIC_API_URL when BACKEND_API_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.comp.revola.ai');
    expect(getServerApiBaseUrl()).toBe('https://api.comp.revola.ai');
  });

  it('treats an empty BACKEND_API_URL as unset', () => {
    vi.stubEnv('BACKEND_API_URL', '');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.comp.revola.ai');
    expect(getServerApiBaseUrl()).toBe('https://api.comp.revola.ai');
  });

  it('falls back to localhost when both are unset or empty', () => {
    vi.stubEnv('BACKEND_API_URL', '');
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    expect(getServerApiBaseUrl()).toBe('http://localhost:3333');
  });

  it('strips trailing slashes so callers can append /v1 paths', () => {
    vi.stubEnv('BACKEND_API_URL', 'http://comp-api.comp.internal:3333/');
    expect(getServerApiBaseUrl()).toBe('http://comp-api.comp.internal:3333');
  });
});

describe('getPublicApiUrl', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('ignores BACKEND_API_URL: the public URL is what browsers and CSRF checks see', () => {
    vi.stubEnv('BACKEND_API_URL', 'http://comp-api.comp.internal:3333');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.comp.revola.ai');
    expect(getPublicApiUrl()).toBe('https://api.comp.revola.ai');
  });

  it('falls back to localhost', () => {
    expect(getPublicApiUrl()).toBe('http://localhost:3333');
  });
});

describe('getServerApiHeaders', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
    vi.stubEnv('INTERNAL_API_TOKEN', 'internal-test-token');
    vi.stubEnv('COMP_FORWARDED_IP_TOKEN', 'forwarded-test-token');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('matches the header name the API throttle reads for forwarded-IP attestation', () => {
    const verified = readFileSync(
      resolve(SRC, '../../api/src/throttle/verified-headers.ts'),
      'utf8',
    );
    expect(verified).toContain(`FORWARDED_AUTH_HEADER = '${FORWARDED_AUTH_HEADER.toLowerCase()}'`);
  });

  it('adds the forwarded-IP token and the client IP on a server-side call', () => {
    const incoming = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    expect(getServerApiHeaders({ incoming })).toEqual({
      [FORWARDED_AUTH_HEADER]: 'forwarded-test-token',
      'X-Forwarded-For': '203.0.113.7',
    });
  });

  it('never sends the privileged internal token, even when INTERNAL_API_TOKEN is set', () => {
    const incoming = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    const names = Object.keys(getServerApiHeaders({ incoming })).map((name) => name.toLowerCase());
    expect(names).not.toContain('x-internal-token');
    expect(JSON.stringify(getServerApiHeaders({ incoming }))).not.toContain('internal-test-token');
  });

  it('keeps only the first entry of a spoofed or private chain', () => {
    const incoming = new Headers({
      'x-forwarded-for': '10.0.0.5, 203.0.113.7, 198.51.100.2',
    });
    expect(getServerApiHeaders({ incoming })['X-Forwarded-For']).toBe('10.0.0.5');
  });

  it('drops the header when the first entry is not an IP address', () => {
    for (const value of ['not-an-ip, 203.0.113.7', '<script>', '999.1.1.1', ' , 1.2.3.4', '']) {
      const incoming = new Headers({ 'x-forwarded-for': value });
      expect(getServerApiHeaders({ incoming })).not.toHaveProperty('X-Forwarded-For');
    }
  });

  it('accepts an IPv6 client address', () => {
    const incoming = new Headers({ 'x-forwarded-for': '2001:db8::1, 10.0.0.1' });
    expect(getServerApiHeaders({ incoming })['X-Forwarded-For']).toBe('2001:db8::1');
  });

  it('prefers a valid CF-Connecting-IP, which Cloudflare sets and clients cannot spoof', () => {
    const incoming = new Headers({
      'cf-connecting-ip': '198.51.100.9',
      'x-forwarded-for': '1.2.3.4, 198.51.100.9',
    });
    expect(getServerApiHeaders({ incoming })['X-Forwarded-For']).toBe('198.51.100.9');
  });

  it('ignores an invalid CF-Connecting-IP and falls back to the forwarded chain', () => {
    const incoming = new Headers({
      'cf-connecting-ip': 'garbage',
      'x-forwarded-for': '203.0.113.7',
    });
    expect(getServerApiHeaders({ incoming })['X-Forwarded-For']).toBe('203.0.113.7');
  });

  it('omits the token when COMP_FORWARDED_IP_TOKEN is unset or empty', () => {
    vi.stubEnv('COMP_FORWARDED_IP_TOKEN', '');
    const incoming = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    expect(getServerApiHeaders({ incoming })).toEqual({ 'X-Forwarded-For': '203.0.113.7' });
  });

  it('never forwards the origin header or arbitrary x-* headers', () => {
    const incoming = new Headers({
      'x-comp-origin-auth': 'edge-secret',
      'x-custom': 'anything',
      'x-forwarded-for': '203.0.113.7',
    });
    const result = getServerApiHeaders({ incoming });
    const names = Object.keys(result).map((name) => name.toLowerCase());
    expect(names.sort()).toEqual([FORWARDED_AUTH_HEADER.toLowerCase(), 'x-forwarded-for'].sort());
  });
});

describe('no app module reads the privileged internal token', () => {
  it(
    'no non-test source under src references INTERNAL_API_TOKEN or sends X-Internal-Token',
    () => {
      const offenders = listSources(SRC)
        .filter((file) => !/\.(test|spec)\.tsx?$/.test(file))
        .filter((file) =>
          /INTERNAL_API_TOKEN|['"]x-internal-token['"]/i.test(readFileSync(file, 'utf8')),
        )
        .map((file) => relative(SRC, file));
      expect(offenders).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );
});

describe('browser modules never carry a server secret', () => {
  const BROWSER_MODULES = ['utils/auth-client.ts', 'lib/api-client.ts', 'lib/evidence-download.ts'];

  it.each(BROWSER_MODULES)('%s does not reference the token or the server helper', (file) => {
    const source = readFileSync(resolve(SRC, file), 'utf8');
    expect(source).not.toMatch(
      /INTERNAL_API_TOKEN|COMP_FORWARDED_IP_TOKEN|x-internal-token|x-comp-forwarded-auth|server-api-base-url/i,
    );
  });

  it('the helper is marked server-only so a client import fails the build', () => {
    const source = readFileSync(resolve(__dirname, 'server-api-base-url.ts'), 'utf8');
    expect(source).toMatch(/^import 'server-only';$/m);
  });
});

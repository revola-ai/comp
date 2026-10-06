import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPublicApiUrl,
  getServerApiBaseUrl,
  getServerApiHeaders,
  INTERNAL_TOKEN_HEADER,
} from './server-api-base-url';

const SRC = resolve(__dirname, '..');
const ENV_KEYS = ['BACKEND_API_URL', 'NEXT_PUBLIC_API_URL', 'INTERNAL_API_TOKEN'] as const;

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
  });
  afterEach(() => vi.unstubAllEnvs());

  it('matches the header name the API InternalTokenGuard reads', () => {
    const guard = readFileSync(resolve(SRC, '../../api/src/auth/internal-token.guard.ts'), 'utf8');
    expect(guard).toContain(`req.headers['${INTERNAL_TOKEN_HEADER.toLowerCase()}']`);
  });

  it('adds the internal token and the client IP on a server-side call', () => {
    const incoming = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    expect(getServerApiHeaders({ incoming })).toEqual({
      [INTERNAL_TOKEN_HEADER]: 'internal-test-token',
      'X-Forwarded-For': '203.0.113.7',
    });
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

  it('omits the token when INTERNAL_API_TOKEN is unset or empty', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', '');
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
    expect(names.sort()).toEqual([INTERNAL_TOKEN_HEADER.toLowerCase(), 'x-forwarded-for'].sort());
  });
});

describe('browser modules never carry the internal token', () => {
  const BROWSER_MODULES = ['utils/auth-client.ts', 'lib/api-client.ts', 'lib/evidence-download.ts'];

  it.each(BROWSER_MODULES)('%s does not reference the token or the server helper', (file) => {
    const source = readFileSync(resolve(SRC, file), 'utf8');
    expect(source).not.toMatch(/INTERNAL_API_TOKEN|x-internal-token|server-api-base-url/i);
  });

  it('the helper is marked server-only so a client import fails the build', () => {
    const source = readFileSync(resolve(__dirname, 'server-api-base-url.ts'), 'utf8');
    expect(source).toMatch(/^import 'server-only';$/m);
  });
});

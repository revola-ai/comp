import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getServerApiBaseUrl,
  getServerApiHeaders,
  INTERNAL_TOKEN_HEADER,
} from './server-api-base-url';

const SRC = resolve(__dirname, '../..');
const ENV_KEYS = ['BACKEND_API_URL', 'NEXT_PUBLIC_API_URL', 'INTERNAL_API_TOKEN'] as const;

describe('getServerApiBaseUrl (portal)', () => {
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
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    expect(getServerApiBaseUrl()).toBe('http://localhost:3333');
  });
});

describe('getServerApiHeaders (portal)', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
    vi.stubEnv('INTERNAL_API_TOKEN', 'internal-test-token');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('matches the header name the API InternalTokenGuard reads', () => {
    const guard = readFileSync(resolve(SRC, '../../api/src/auth/internal-token.guard.ts'), 'utf8');
    expect(guard).toContain(`req.headers['${INTERNAL_TOKEN_HEADER.toLowerCase()}']`);
  });

  it('adds the internal token and the client IP', () => {
    const incoming = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    expect(getServerApiHeaders({ incoming })).toEqual({
      [INTERNAL_TOKEN_HEADER]: 'internal-test-token',
      'X-Forwarded-For': '203.0.113.7',
    });
  });

  it('keeps only the first entry of a spoofed or private chain', () => {
    const incoming = new Headers({ 'x-forwarded-for': '10.0.0.5, 203.0.113.7' });
    expect(getServerApiHeaders({ incoming })['X-Forwarded-For']).toBe('10.0.0.5');
  });

  it('drops an invalid first entry', () => {
    const incoming = new Headers({ 'x-forwarded-for': 'evil, 203.0.113.7' });
    expect(getServerApiHeaders({ incoming })).not.toHaveProperty('X-Forwarded-For');
  });

  it('prefers a valid CF-Connecting-IP', () => {
    const incoming = new Headers({
      'cf-connecting-ip': '2001:db8::7',
      'x-forwarded-for': '1.2.3.4',
    });
    expect(getServerApiHeaders({ incoming })['X-Forwarded-For']).toBe('2001:db8::7');
  });

  it('omits the token when INTERNAL_API_TOKEN is empty', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', '');
    expect(getServerApiHeaders({ incoming: new Headers() })).toEqual({});
  });
});

describe('portal browser modules never carry the internal token', () => {
  it.each([
    'app/lib/auth-client.ts',
    'hooks/use-training-completions.ts',
    'app/(public)/auth/device-callback/page.tsx',
  ])('%s does not reference the token or the server helper', (file) => {
    const source = readFileSync(resolve(SRC, file), 'utf8');
    expect(source).not.toMatch(/INTERNAL_API_TOKEN|x-internal-token|server-api-base-url/i);
  });
});

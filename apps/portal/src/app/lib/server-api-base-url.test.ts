import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FORWARDED_AUTH_HEADER,
  getServerApiBaseUrl,
  getServerApiHeaders,
} from './server-api-base-url';

// Whole-tree source scans read thousands of files; under a parallel run they
// can exceed vitest's 5 s default without anything being wrong.
const SCAN_TIMEOUT_MS = 30_000;

const SRC = resolve(__dirname, '../..');

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

  it('adds the forwarded-IP token and the client IP', () => {
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

  it('omits the token when COMP_FORWARDED_IP_TOKEN is empty', () => {
    vi.stubEnv('COMP_FORWARDED_IP_TOKEN', '');
    expect(getServerApiHeaders({ incoming: new Headers() })).toEqual({});
  });
});

describe('no portal module reads the privileged internal token', () => {
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

  it('the helper is marked server-only so a client import fails the build', () => {
    const source = readFileSync(resolve(__dirname, 'server-api-base-url.ts'), 'utf8');
    expect(source).toMatch(/^import 'server-only';$/m);
  });
});

describe('portal browser modules never carry a server secret', () => {
  it.each([
    'app/lib/auth-client.ts',
    'hooks/use-training-completions.ts',
    'app/(public)/auth/device-callback/page.tsx',
  ])('%s does not reference the token or the server helper', (file) => {
    const source = readFileSync(resolve(SRC, file), 'utf8');
    expect(source).not.toMatch(
      /INTERNAL_API_TOKEN|COMP_FORWARDED_IP_TOKEN|x-internal-token|x-comp-forwarded-auth|server-api-base-url/i,
    );
  });
});

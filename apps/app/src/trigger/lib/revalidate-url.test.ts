import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRevalidateUrl, RevalidateUrlNotConfiguredError } from './revalidate-url';

const TRIGGER_DIR = resolve(__dirname, '..');

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('getRevalidateUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('builds the app revalidation endpoint from NEXT_PUBLIC_APP_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai');
    vi.stubEnv('BETTER_AUTH_URL', 'https://api.comp.revola.ai');
    expect(getRevalidateUrl()).toBe('https://app.comp.revola.ai/api/revalidate/path');
  });

  it('normalizes a trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.comp.revola.ai/');
    expect(getRevalidateUrl()).toBe('https://app.comp.revola.ai/api/revalidate/path');
  });

  it('throws a named error when NEXT_PUBLIC_APP_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    expect(() => getRevalidateUrl()).toThrow(RevalidateUrlNotConfiguredError);
  });

  it('treats an empty NEXT_PUBLIC_APP_URL as unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(() => getRevalidateUrl()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });
});

describe('trigger revalidation call sites', () => {
  const sources = listSourceFiles(TRIGGER_DIR).map((file) => ({
    rel: relative(TRIGGER_DIR, file),
    source: readFileSync(file, 'utf8'),
  }));

  it('no trigger file joins BETTER_AUTH_URL with /api/revalidate', () => {
    const offenders = sources
      .filter(({ source }) => /BETTER_AUTH_URL[^\n]*\/api\/revalidate/.test(source))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('no trigger file passes an absolute URL as the revalidation path', () => {
    const offenders = sources
      .filter(({ source }) => /path:\s*`\$\{process\.env\.[A-Z_]*URL\}/.test(source))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('every trigger file that posts to the revalidation route uses getRevalidateUrl()', () => {
    const offenders = sources
      .filter(({ rel }) => rel !== 'lib/revalidate-url.ts')
      .filter(({ source }) => source.includes('/api/revalidate/path'))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});

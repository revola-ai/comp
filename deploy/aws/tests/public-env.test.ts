import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  checkPublicEnv,
  DEFAULT_URLS,
  findPublicEnvNames,
  INTENTIONALLY_UNSET,
  publicBuildArgs,
  scanReadNames,
} from '../public-env.ts';

const REPO_ROOT = join(import.meta.dir, '../../..');

describe('publicBuildArgs', () => {
  test('defaults point at the three comp.revola.ai hosts', () => {
    expect(DEFAULT_URLS).toEqual({
      api: 'https://api.comp.revola.ai',
      app: 'https://app.comp.revola.ai',
      portal: 'https://portal.comp.revola.ai',
    });
  });

  test('the app gets its own host as the better-auth URL and the self-hosted flags', () => {
    expect(publicBuildArgs({ target: 'app', urls: DEFAULT_URLS })).toEqual({
      NEXT_PUBLIC_API_URL: 'https://api.comp.revola.ai',
      NEXT_PUBLIC_APP_URL: 'https://app.comp.revola.ai',
      NEXT_PUBLIC_PORTAL_URL: 'https://portal.comp.revola.ai',
      NEXT_PUBLIC_BETTER_AUTH_URL: 'https://app.comp.revola.ai',
      NEXT_PUBLIC_SELF_HOSTED: 'true',
      NEXT_PUBLIC_APP_ENV: 'production',
    });
  });

  test('the portal gets the portal host as the better-auth URL', () => {
    expect(publicBuildArgs({ target: 'portal', urls: DEFAULT_URLS })).toEqual({
      NEXT_PUBLIC_API_URL: 'https://api.comp.revola.ai',
      NEXT_PUBLIC_APP_URL: 'https://app.comp.revola.ai',
      NEXT_PUBLIC_PORTAL_URL: 'https://portal.comp.revola.ai',
      NEXT_PUBLIC_BETTER_AUTH_URL: 'https://portal.comp.revola.ai',
    });
  });

  test('no key is both a build arg and intentionally unset', () => {
    for (const target of ['app', 'portal'] as const) {
      const args = Object.keys(publicBuildArgs({ target, urls: DEFAULT_URLS }));
      expect(args.filter((name) => name in INTENTIONALLY_UNSET)).toEqual([]);
    }
  });
});

describe('findPublicEnvNames', () => {
  test('returns each NEXT_PUBLIC_ name once, sorted', () => {
    const source = [
      'const a = process.env.NEXT_PUBLIC_B_URL;',
      "const b = env.NEXT_PUBLIC_A || 'x';",
      'process.env.NEXT_PUBLIC_B_URL;',
      'process.env.OTHER;',
    ].join('\n');
    expect(findPublicEnvNames({ source })).toEqual(['NEXT_PUBLIC_A', 'NEXT_PUBLIC_B_URL']);
  });
});

describe('checkPublicEnv', () => {
  const expected = publicBuildArgs({ target: 'portal', urls: DEFAULT_URLS });

  test('passes when every read name is a matching bake arg or intentionally unset', () => {
    const readNames = ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_POSTHOG_KEY'];
    expect(
      checkPublicEnv({ target: 'portal', readNames, bakeArgs: expected, urls: DEFAULT_URLS }),
    ).toEqual([]);
  });

  test('names a read key that is neither a bake arg nor intentionally unset', () => {
    const problems = checkPublicEnv({
      target: 'portal',
      readNames: ['NEXT_PUBLIC_NEW_THING'],
      bakeArgs: expected,
      urls: DEFAULT_URLS,
    });
    expect(problems.join('\n')).toContain('NEXT_PUBLIC_NEW_THING');
  });

  test('names a bake arg whose value differs from public-env.ts', () => {
    const problems = checkPublicEnv({
      target: 'portal',
      readNames: [],
      bakeArgs: { ...expected, NEXT_PUBLIC_API_URL: 'http://localhost:3333' },
      urls: DEFAULT_URLS,
    });
    expect(problems.join('\n')).toContain('NEXT_PUBLIC_API_URL');
  });

  test('names an expected arg the bake file does not pass', () => {
    const rest = Object.fromEntries(
      Object.entries(expected).filter(([name]) => name !== 'NEXT_PUBLIC_PORTAL_URL'),
    );
    const problems = checkPublicEnv({
      target: 'portal',
      readNames: [],
      bakeArgs: rest,
      urls: DEFAULT_URLS,
    });
    expect(problems.join('\n')).toContain('NEXT_PUBLIC_PORTAL_URL');
  });

  test('ignores bake args that are not NEXT_PUBLIC_ keys', () => {
    expect(
      checkPublicEnv({
        target: 'portal',
        readNames: [],
        bakeArgs: { ...expected, BUN_VERSION: '1.3.4' },
        urls: DEFAULT_URLS,
      }),
    ).toEqual([]);
  });
});

describe('repository code', () => {
  for (const target of ['app', 'portal'] as const) {
    test(`every NEXT_PUBLIC_ key the ${target} build reads is covered`, () => {
      const readNames = scanReadNames({ repoRoot: REPO_ROOT, target });
      expect(readNames).toContain('NEXT_PUBLIC_API_URL');
      const bakeArgs = publicBuildArgs({ target, urls: DEFAULT_URLS });
      expect(checkPublicEnv({ target, readNames, bakeArgs, urls: DEFAULT_URLS })).toEqual([]);
    });
  }
});

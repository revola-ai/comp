import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_URLS, publicBuildArgs, type ImageTarget } from '../public-env.ts';

// The app and portal read NEXT_PUBLIC_* both as compiled constants (build stages) and from
// process.env on the server (runtime stages). Each of those stages must declare exactly
// the keys public-env.ts gives its target, as ARG and as ENV, so a key added to
// public-env.ts but not to the Dockerfile fails here instead of in production.

const DOCKERFILE = join(import.meta.dir, '../Dockerfile');

type StageKeys = { args: string[]; env: string[] };

/** NEXT_PUBLIC_ keys each stage declares with ARG and sets with ENV. */
export function publicKeysByStage({ dockerfile }: { dockerfile: string }): Map<string, StageKeys> {
  const instructions = dockerfile
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const stages = new Map<string, StageKeys>();
  let current: StageKeys | undefined;
  for (const line of instructions) {
    const from = line.match(/^FROM\s+\S+\s+AS\s+(\S+)$/i);
    if (from) {
      current = { args: [], env: [] };
      stages.set(from[1] as string, current);
      continue;
    }
    if (!current) continue;
    const arg = line.match(/^ARG\s+(NEXT_PUBLIC_[A-Z0-9_]+)/);
    if (arg) current.args.push(arg[1] as string);
    if (/^ENV\s/.test(line)) {
      for (const match of line.matchAll(/(NEXT_PUBLIC_[A-Z0-9_]+)=/g)) {
        current.env.push(match[1] as string);
      }
    }
  }
  for (const keys of stages.values()) {
    keys.args.sort();
    keys.env.sort();
  }
  return stages;
}

describe('publicKeysByStage', () => {
  test('reads ARG and continued ENV lines per stage', () => {
    const dockerfile = [
      'FROM node AS one',
      'ARG NEXT_PUBLIC_B',
      'ARG NEXT_PUBLIC_A',
      'ARG OTHER',
      'ENV NEXT_PUBLIC_A=${NEXT_PUBLIC_A} \\',
      '    NEXT_PUBLIC_B=${NEXT_PUBLIC_B} \\',
      '    OTHER=1',
      '# ARG NEXT_PUBLIC_COMMENTED',
      'FROM one AS two',
      'ENV PORT=3000',
    ].join('\n');
    const stages = publicKeysByStage({ dockerfile });
    expect(stages.get('one')).toEqual({
      args: ['NEXT_PUBLIC_A', 'NEXT_PUBLIC_B'],
      env: ['NEXT_PUBLIC_A', 'NEXT_PUBLIC_B'],
    });
    expect(stages.get('two')).toEqual({ args: [], env: [] });
  });
});

describe('deploy/aws/Dockerfile', () => {
  const stages = publicKeysByStage({ dockerfile: readFileSync(DOCKERFILE, 'utf8') });
  const expectedStages: ReadonlyArray<[string, ImageTarget]> = [
    ['app-build', 'app'],
    ['app', 'app'],
    ['portal-build', 'portal'],
    ['portal', 'portal'],
  ];

  for (const [stage, target] of expectedStages) {
    test(`stage ${stage} declares and sets exactly the ${target} public keys`, () => {
      const keys = Object.keys(publicBuildArgs({ target, urls: DEFAULT_URLS })).sort();
      expect(stages.get(stage)).toEqual({ args: keys, env: keys });
    });
  }

  test('no other stage declares a NEXT_PUBLIC_ key', () => {
    const others = [...stages.entries()].filter(
      ([name, keys]) =>
        !expectedStages.some(([stage]) => stage === name) &&
        (keys.args.length > 0 || keys.env.length > 0),
    );
    expect(others.map(([name]) => name)).toEqual([]);
  });
});

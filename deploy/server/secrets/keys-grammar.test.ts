import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { KEYS_DIR, parseKeysFile } from './keys.ts';
import { TARGET } from './testing/fixtures.ts';
import { valueProblems } from './values.ts';

// push-secrets (parseKeysFile) and render-env.sh (its embedded Python) read the same
// env/*.keys files, so they must accept exactly the same lines: one push-secrets accepts but
// render-env refuses would only fail at release time. Each case runs both parsers: render-env
// as a process over a copy of the script, with `aws` on PATH a stub printing a fake secret.

const RENDER_ENV = resolve(import.meta.dir, '..', 'render-env.sh');
const WORK = mkdtempSync(join(tmpdir(), 'keys-grammar-'));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const STUB = join(WORK, 'bin');
mkdirSync(STUB);
writeFileSync(join(STUB, 'aws'), '#!/bin/sh\ncat "$KEYS_GRAMMAR_SECRET"\n');
chmodSync(join(STUB, 'aws'), 0o755);

let runs = 0;

/** Whether render-env.sh accepts `files` (name to text) as its env directory. */
function renderEnvAccepts({ files }: { files: Readonly<Record<string, string>> }): boolean {
  runs += 1;
  const tree = join(WORK, `tree-${runs}`);
  mkdirSync(join(tree, 'env'), { recursive: true });
  copyFileSync(RENDER_ENV, join(tree, 'render-env.sh'));
  const secret: Record<string, string> = {};
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(tree, 'env', name), text);
    for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
      secret[word] = 'fakesecret-value';
  }
  writeFileSync(join(tree, 'secret.json'), JSON.stringify(secret));
  const result = Bun.spawnSync({
    cmd: ['bash', join(tree, 'render-env.sh'), '--out-dir', join(tree, 'out')],
    env: {
      ...process.env,
      PATH: `${STUB}:${process.env.PATH}`,
      KEYS_GRAMMAR_SECRET: join(tree, 'secret.json'),
    },
  });
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0 && !/\.keys line \d+ is not NAME/.test(stderr)) {
    throw new Error(`render-env failed for another reason: ${stderr}`);
  }
  return result.exitCode === 0;
}

/** Whether push-secrets' parser accepts `text`. */
function parseKeysAccepts({ text }: { text: string }): boolean {
  try {
    parseKeysFile({ text, file: 'x.keys' });
    return true;
  } catch {
    return false;
  }
}

const GOOD = [
  'DATABASE_URL',
  'AUTH_SECRET from SECRET_KEY',
  'A1_B2',
  '# a comment, with anything: = from x',
  '#',
  '',
  'FIRST\n\n# between\nSECOND from THIRD',
];

const BAD = [
  ' DATABASE_URL',
  'DATABASE_URL ',
  '\tDATABASE_URL',
  '  # indented comment',
  '   ',
  'AUTH_SECRET  from SECRET_KEY',
  'AUTH_SECRET from  SECRET_KEY',
  'AUTH_SECRET\tfrom\tSECRET_KEY',
  'AUTH_SECRET from',
  'AUTH_SECRET from SECRET_KEY from OTHER',
  '_LEADING_UNDERSCORE',
  'AUTH_SECRET from _SECRET_KEY',
  '1DIGIT_FIRST',
  'lowercase_name',
  'AUTH_SECRET from secret_key',
  'AUTH_SECRET=fakesecret-pasted',
  'CARRIAGE_RETURN\r',
];

describe('one .keys grammar', () => {
  test.each(GOOD)('both accept %j', (line) => {
    const text = `${line}\n`;
    expect({
      pushSecrets: parseKeysAccepts({ text }),
      renderEnv: renderEnvAccepts({ files: { 'x.keys': text } }),
    }).toEqual({
      pushSecrets: true,
      renderEnv: true,
    });
  });

  test.each(BAD)('both refuse %j', (line) => {
    const text = `KEPT\n${line}\n`;
    expect({
      pushSecrets: parseKeysAccepts({ text }),
      renderEnv: renderEnvAccepts({ files: { 'x.keys': text } }),
    }).toEqual({
      pushSecrets: false,
      renderEnv: false,
    });
  });

  test('both accept every committed env/*.keys file', () => {
    const files: Record<string, string> = {};
    for (const name of readdirSync(KEYS_DIR).filter((file) => file.endsWith('.keys'))) {
      files[name] = readFileSync(join(KEYS_DIR, name), 'utf8');
      expect({ name, accepted: parseKeysAccepts({ text: files[name] }) }).toEqual({
        name,
        accepted: true,
      });
    }
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(renderEnvAccepts({ files })).toBe(true);
  });
});

// Both also check every value for the same edge whitespace: one explicit set, EDGE_WHITESPACE,
// written identically in values.ts and render-env.sh. JS trim() and Python strip() disagree
// (strip() takes \x1c-\x1f and U+0085, trim() takes U+FEFF), so neither is used.
// prettier-ignore
const EDGE = [
  ' ', '\t', '\n', '\v', '\f', '\r', '\u0085', '\u00a0', '\u1680', '\u2000', '\u2001', '\u2002',
  '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028',
  '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
];
// prettier-ignore
const NOT_EDGE = ['\x1c', '\x1d', '\x1e', '\x1f', '\u200b', '\u180e', '\u2060', '-'];

type Verdict = 'line break' | 'whitespace' | 'accepted';

/** What render-env.sh says of each value: one run, with a key per value. */
function renderEnvVerdicts({ values }: { values: readonly string[] }): Verdict[] {
  runs += 1;
  const tree = join(WORK, `values-${runs}`);
  mkdirSync(join(tree, 'env'), { recursive: true });
  copyFileSync(RENDER_ENV, join(tree, 'render-env.sh'));
  const keys = values.map((_, index) => `EDGE_${index}`);
  writeFileSync(join(tree, 'env', 'x.keys'), `${keys.join('\n')}\n`);
  const secret = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
  writeFileSync(join(tree, 'secret.json'), JSON.stringify(secret));
  const result = Bun.spawnSync({
    cmd: ['bash', join(tree, 'render-env.sh'), '--out-dir', join(tree, 'out')],
    env: {
      ...process.env,
      PATH: `${STUB}:${process.env.PATH}`,
      KEYS_GRAMMAR_SECRET: join(tree, 'secret.json'),
    },
  });
  const stderr = result.stderr.toString();
  return keys.map((key) => {
    if (stderr.includes(`x: ${key} contains a line break or NUL`)) return 'line break';
    if (stderr.includes(`x: ${key} has leading or trailing whitespace`)) return 'whitespace';
    return 'accepted';
  });
}

/** What push-secrets says of a value. */
function pushSecretsVerdict({ value }: { value: string }): Verdict {
  const found = valueProblems({ key: 'EDGE_VALUE', value, target: TARGET }).join('\n');
  if (found.includes('contains a line break')) return 'line break';
  if (found.includes('has leading or trailing whitespace')) return 'whitespace';
  return 'accepted';
}

/** The quoted EDGE_WHITESPACE literal of a source file, as written. */
const literalIn = ({ path }: { path: string }) =>
  readFileSync(path, 'utf8').match(/EDGE_WHITESPACE = ('[^']*')/)?.[1];

describe('one edge-whitespace set', () => {
  test('values.ts and render-env.sh write it identically', () => {
    const fromValues = literalIn({ path: resolve(import.meta.dir, 'values.ts') });
    expect(fromValues).toBeDefined();
    expect(literalIn({ path: RENDER_ENV })).toBe(fromValues);
  });

  test('both refuse the same values, for a leading or a trailing character', () => {
    const values = [...EDGE, ...NOT_EDGE].flatMap((char) => [`${char}fakesecret`, `fakesecret${char}`]);
    const expected = values.map((value): Verdict => {
      if (/[\r\n]/.test(value)) return 'line break';
      const edge = EDGE.some((char) => value.startsWith(char) || value.endsWith(char));
      return edge ? 'whitespace' : 'accepted';
    });
    expect(values.map((value) => pushSecretsVerdict({ value }))).toEqual(expected);
    expect(renderEnvVerdicts({ values })).toEqual(expected);
  });
});

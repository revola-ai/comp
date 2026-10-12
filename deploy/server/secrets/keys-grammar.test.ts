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

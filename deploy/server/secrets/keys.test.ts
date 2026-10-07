import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KEYS_DIR,
  keyTableProblems,
  PRODUCTION_ONLY_FILE,
  parseKeysFile,
  readKeyUnion,
  SECRET_KEYS,
  SOURCE_FILES,
} from './keys.ts';

const REPO_ROOT = join(import.meta.dir, '../../..');

describe('parseKeysFile', () => {
  test('reads NAME and NAME from KEY lines, skipping comments and blank lines', () => {
    const text = '# comment\nDATABASE_URL\n\nAUTH_SECRET from SECRET_KEY\n  # indented comment\n';
    expect(parseKeysFile({ text, file: 'x.keys' })).toEqual(['DATABASE_URL', 'SECRET_KEY']);
  });

  test('refuses a malformed line by file and line number', () => {
    expect(() => parseKeysFile({ text: 'A\nB from\n', file: 'x.keys' })).toThrow(
      'x.keys line 2 is neither NAME nor NAME from KEY',
    );
  });
});

describe('the key table', () => {
  test('names exactly the union of the source keys in env/*.keys', () => {
    const union = readKeyUnion({ keysDir: KEYS_DIR });
    expect(Object.keys(SECRET_KEYS).sort()).toEqual([...union].sort());
    expect(keyTableProblems({ union, secretKeys: SECRET_KEYS })).toEqual([]);
  });

  test('includes the tunnel token, the migration URL and the Trigger.dev keys', () => {
    const union = readKeyUnion({ keysDir: KEYS_DIR });
    for (const key of [
      'TUNNEL_TOKEN',
      'DATABASE_MIGRATION_URL',
      'TRIGGER_ACCESS_TOKEN',
      'TRIGGER_PROJECT_REF_API',
      'TRIGGER_PROJECT_REF_APP',
      'TRIGGER_SECRET_KEY_API',
      'TRIGGER_SECRET_KEY_APP',
    ]) {
      expect(union.has(key)).toBe(true);
    }
  });

  test('a key in env/*.keys without a source, or a source without a key, is a problem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-secrets-keys-'));
    try {
      writeFileSync(join(dir, 'api.keys'), 'DATABASE_URL\nNEW_KEY\nX from ENCRYPTION_KEY\n');
      const union = readKeyUnion({ keysDir: dir });
      const problems = keyTableProblems({
        union,
        secretKeys: {
          DATABASE_URL: { file: 'apps/api/.env' },
          ENCRYPTION_KEY: { file: 'apps/api/.env' },
          OLD_KEY: { file: 'apps/api/.env' },
        },
      });
      expect(problems).toEqual([
        'NEW_KEY is in env/*.keys but has no source in secrets/keys.ts',
        'OLD_KEY has a source in secrets/keys.ts but is in no env/*.keys file',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('only the production-only keys come from the production-only file', () => {
    const fromProd = Object.entries(SECRET_KEYS)
      .filter(([, spec]) => spec.file === PRODUCTION_ONLY_FILE)
      .map(([key]) => key)
      .sort();
    expect(fromProd).toEqual([
      'COMP_FORWARDED_IP_TOKEN',
      'INTERNAL_API_TOKEN',
      'SERVICE_TOKEN_PORTAL',
      'SERVICE_TOKEN_TRIGGER',
      'TRIGGER_ACCESS_TOKEN',
      'TRIGGER_SECRET_KEY_API',
      'TRIGGER_SECRET_KEY_APP',
      'TUNNEL_TOKEN',
    ]);
  });

  test('every source file, the production-only one included, is ignored by git', () => {
    for (const file of SOURCE_FILES) {
      const result = Bun.spawnSync(['git', 'check-ignore', '--quiet', '--no-index', file], {
        cwd: REPO_ROOT,
      });
      expect({ file, ignored: result.exitCode === 0 }).toEqual({ file, ignored: true });
    }
  });
});

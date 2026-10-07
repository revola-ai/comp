import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { withPrivateFile } from './private-file.ts';

describe('withPrivateFile', () => {
  test('hands over a 0600 file in a 0700 directory and removes both afterwards', async () => {
    let seen = '';
    const result = await withPrivateFile({
      prefix: 'push-secrets-test-',
      contents: '{"A":"fakesecret"}',
      work: async (file) => {
        seen = file;
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
        expect(readFileSync(file, 'utf8')).toBe('{"A":"fakesecret"}');
        return 'done';
      },
    });
    expect(result).toBe('done');
    expect(existsSync(seen)).toBe(false);
    expect(existsSync(dirname(seen))).toBe(false);
  });

  test('removes them when the work throws', async () => {
    let seen = '';
    const failing = withPrivateFile({
      prefix: 'push-secrets-test-',
      contents: 'fakesecret',
      work: async (file) => {
        seen = file;
        throw new Error('boom');
      },
    });
    await expect(failing).rejects.toThrow('boom');
    expect(existsSync(dirname(seen))).toBe(false);
  });
});

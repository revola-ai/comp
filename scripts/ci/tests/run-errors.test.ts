import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRunErrors } from '../lib/run-errors';

const fixtures = join(import.meta.dir, 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
}

describe('checkRunErrors', () => {
  test('passes a run with no unhandled errors, whatever its tests did', () => {
    const { ok, text } = checkRunErrors(loadFixture('run-errors-clean.json'));
    expect(ok).toBe(true);
    expect(text).toContain('No unhandled errors');
  });

  test('fails on an unhandled error and prints its message', () => {
    const { ok, text } = checkRunErrors(loadFixture('run-errors-unhandled.json'));
    expect(ok).toBe(false);
    expect(text).toContain('1 unhandled error');
    expect(text).toContain("TypeError: Cannot read properties of undefined (reading 'id')");
  });

  test('fails an interrupted run', () => {
    const { ok, text } = checkRunErrors(loadFixture('run-errors-interrupted.json'));
    expect(ok).toBe(false);
    expect(text).toContain('interrupted');
  });

  test('rejects a file that is not a run-errors summary', () => {
    expect(() => checkRunErrors({ unhandledErrors: 'none' })).toThrow('run-errors');
  });
});

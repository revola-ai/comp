import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RunErrorsReporter, { RUN_ERRORS_FILE_VARIABLE } from '../vitest-run-errors-reporter';

let workDir = '';

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'run-errors-reporter-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function readSummary(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function withRunErrorsFile<T>({ value, run }: { value: string | undefined; run: () => T }): T {
  const saved = process.env[RUN_ERRORS_FILE_VARIABLE];
  if (value === undefined) delete process.env[RUN_ERRORS_FILE_VARIABLE];
  else process.env[RUN_ERRORS_FILE_VARIABLE] = value;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env[RUN_ERRORS_FILE_VARIABLE];
    else process.env[RUN_ERRORS_FILE_VARIABLE] = saved;
  }
}

describe('vitest run-errors reporter', () => {
  test('writes the unhandled errors and the end reason to the given file', async () => {
    const outputFile = join(workDir, 'unhandled.json');
    const reporter = new RunErrorsReporter({ outputFile });
    await reporter.onTestRunEnd(
      [],
      [{ name: 'TypeError', message: 'boom', stack: 'TypeError: boom\n  at x' }, { message: '' }],
      'failed',
    );
    expect(readSummary(outputFile)).toEqual({
      unhandledErrors: 2,
      reason: 'failed',
      messages: ['TypeError: boom', 'Error'],
    });
  });

  test('writes a clean run too, so a missing file means the reporter never ran', async () => {
    const outputFile = join(workDir, 'clean.json');
    await new RunErrorsReporter({ outputFile }).onTestRunEnd([], [], 'passed');
    expect(readSummary(outputFile)).toEqual({
      unhandledErrors: 0,
      reason: 'passed',
      messages: [],
    });
  });

  test(`reads the file from ${RUN_ERRORS_FILE_VARIABLE} when no option is given`, async () => {
    const outputFile = join(workDir, 'from-env.json');
    const reporter = withRunErrorsFile({
      value: outputFile,
      run: () => new RunErrorsReporter(),
    });
    await reporter.onTestRunEnd([], [], 'interrupted');
    expect(readSummary(outputFile)).toMatchObject({ reason: 'interrupted' });
  });

  test('refuses to start without an output file', () => {
    expect(() =>
      withRunErrorsFile({ value: undefined, run: () => new RunErrorsReporter() }),
    ).toThrow(RUN_ERRORS_FILE_VARIABLE);
  });
});

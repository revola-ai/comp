/**
 * A vitest reporter that records what vitest 3's JSON reporter drops: errors
 * thrown outside any test (an unhandled rejection after a test finished, a
 * failing setup file) and whether the run was interrupted. CI ignores the
 * runner's exit code for suites with known failures, so without this file such
 * an error would not fail the job.
 *
 *   VITEST_RUN_ERRORS_FILE=<file> npx vitest run \
 *     --reporter=default --reporter=../../scripts/ci/vitest-run-errors-reporter.ts
 *
 * At the end of the run it writes { unhandledErrors, reason, messages } to the
 * file, which known-failures.ts --run-errors <file> checks. It always writes
 * (a clean run too), so a missing file means the reporter never ran.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Reporter } from 'vitest/node';
import type { RunErrors } from './lib/run-errors';

export const RUN_ERRORS_FILE_VARIABLE = 'VITEST_RUN_ERRORS_FILE';

type OnTestRunEnd = NonNullable<Reporter['onTestRunEnd']>;
type UnhandledErrors = Parameters<OnTestRunEnd>[1];
type EndReason = Parameters<OnTestRunEnd>[2];

/** `<name>: <message>`, the first line of the error as Node prints it. */
function describeError(error: UnhandledErrors[number]): string {
  const name = error.name || 'Error';
  return error.message ? `${name}: ${error.message}` : name;
}

export default class RunErrorsReporter implements Reporter {
  private readonly outputFile: string;

  constructor(options: { outputFile?: string } = {}) {
    const outputFile = options.outputFile ?? process.env[RUN_ERRORS_FILE_VARIABLE];
    if (!outputFile) {
      throw new Error(
        `vitest-run-errors-reporter: set ${RUN_ERRORS_FILE_VARIABLE} to the file to write`,
      );
    }
    this.outputFile = resolve(outputFile);
  }

  onTestRunEnd(
    _testModules: Parameters<OnTestRunEnd>[0],
    unhandledErrors: UnhandledErrors,
    reason: EndReason,
  ): void {
    const summary: RunErrors = {
      unhandledErrors: unhandledErrors.length,
      reason,
      messages: unhandledErrors.map(describeError),
    };
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify(summary, null, 2)}\n`);
  }
}

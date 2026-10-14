#!/usr/bin/env bun
/**
 * Compares a jest or vitest JSON report with a committed list of known failing tests.
 *
 *   bun scripts/ci/known-failures.ts --report <report.json> --list <list.txt> [--root <dir>]
 *     [--run-errors <run-errors.json>]
 *
 * --root is the directory test file paths are made relative to (default: the current
 * directory), which is the package the suite ran in.
 * --run-errors is the summary vitest-run-errors-reporter.ts writes (vitest suites only):
 * vitest's JSON report omits errors thrown outside any test, so they are checked there.
 *
 * Exit 0: exactly the listed tests failed (and, with --run-errors, no unhandled errors).
 * Exit 1: a new failure, a listed test that now passes, a listed test that did not run,
 * or (with --run-errors) an unhandled error or an interrupted run.
 * Exit 2: bad arguments, or a missing or unreadable report, list or run-errors file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compareWithKnownFailures, formatComparison } from './lib/compare';
import { parseFlakyEntries, parseKnownFailuresList } from './lib/known-failures-list';
import { checkRunErrors } from './lib/run-errors';
import { parseTestReport } from './lib/test-report';

function readText({ path, what }: { path: string; what: string }): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read the ${what} at ${path}: ${reason}`);
  }
}

function readJson({ path, what }: { path: string; what: string }): unknown {
  const text = readText({ path, what });
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`the ${what} at ${path} is not valid JSON: ${reason}`);
  }
}

function main(): number {
  const { values } = parseArgs({
    options: {
      report: { type: 'string' },
      list: { type: 'string' },
      root: { type: 'string' },
      'run-errors': { type: 'string' },
    },
    strict: true,
  });
  if (!values.report || !values.list) {
    throw new Error(
      'usage: known-failures.ts --report <report.json> --list <list.txt> [--root <dir>] [--run-errors <file>]',
    );
  }

  const outcomes = parseTestReport({
    json: readJson({ path: values.report, what: 'test report' }),
    root: resolve(values.root ?? process.cwd()),
  });
  const listText = readText({ path: values.list, what: 'known-failures list' });
  const knownFailures = parseKnownFailuresList(listText);
  const flaky = parseFlakyEntries(listText);

  const runErrorsPath = values['run-errors'];
  const runErrors = runErrorsPath
    ? checkRunErrors(readJson({ path: runErrorsPath, what: 'run-errors file' }))
    : { ok: true, text: '' };

  const { ok, text } = formatComparison(
    compareWithKnownFailures({ outcomes, knownFailures, flaky }),
  );
  console.log(`Known-failures check against ${values.list}`);
  console.log(text);
  if (runErrorsPath) {
    console.log(`\nRun errors (${runErrorsPath}):`);
    console.log(runErrors.text);
  }
  return ok && runErrors.ok ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`known-failures: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}

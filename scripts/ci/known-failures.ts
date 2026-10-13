#!/usr/bin/env bun
/**
 * Compares a jest or vitest JSON report with a committed list of known failing tests.
 *
 *   bun scripts/ci/known-failures.ts --report <report.json> --list <list.txt> [--root <dir>]
 *
 * --root is the directory test file paths are made relative to (default: the current
 * directory), which is the package the suite ran in.
 *
 * Exit 0: exactly the listed tests failed.
 * Exit 1: a new failure, a listed test that now passes, or a listed test that did not run.
 * Exit 2: bad arguments, or a missing or unreadable report or list.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compareWithKnownFailures, formatComparison } from './lib/compare';
import { parseKnownFailuresList } from './lib/known-failures-list';
import { parseTestReport } from './lib/test-report';

function readText({ path, what }: { path: string; what: string }): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read the ${what} at ${path}: ${reason}`);
  }
}

function readJson(path: string): unknown {
  const text = readText({ path, what: 'test report' });
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`the test report at ${path} is not valid JSON: ${reason}`);
  }
}

function main(): number {
  const { values } = parseArgs({
    options: {
      report: { type: 'string' },
      list: { type: 'string' },
      root: { type: 'string' },
    },
    strict: true,
  });
  if (!values.report || !values.list) {
    throw new Error(
      'usage: known-failures.ts --report <report.json> --list <list.txt> [--root <dir>]',
    );
  }

  const outcomes = parseTestReport({
    json: readJson(values.report),
    root: resolve(values.root ?? process.cwd()),
  });
  const knownFailures = parseKnownFailuresList(
    readText({ path: values.list, what: 'known-failures list' }),
  );

  const { ok, text } = formatComparison(compareWithKnownFailures({ outcomes, knownFailures }));
  console.log(`Known-failures check against ${values.list}`);
  console.log(text);
  return ok ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`known-failures: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}

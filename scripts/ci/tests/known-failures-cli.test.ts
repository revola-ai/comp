import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, '..', 'known-failures.ts');
const fixture = (name: string) => join(import.meta.dir, 'fixtures', name);
const jestReport = fixture('jest-report.json');

let workDir = '';

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'known-failures-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runCli({
  list,
  report = jestReport,
  runErrors,
}: {
  list: string;
  report?: string;
  runErrors?: string;
}) {
  const listPath = join(workDir, 'list.txt');
  writeFileSync(listPath, list);
  const runErrorsArgs = runErrors === undefined ? [] : ['--run-errors', runErrors];
  const result = Bun.spawnSync({
    cmd: [
      'bun',
      script,
      '--report',
      report,
      '--list',
      listPath,
      '--root',
      '/repo/apps/api',
      ...runErrorsArgs,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

const knownApiFailures = [
  '# header comment',
  'src/users/users.service.spec.ts > UsersService > rejects a duplicate email',
  'src/billing/billing.controller.spec.ts',
  '',
].join('\n');

describe('known-failures CLI', () => {
  test('exits 0 when only the listed tests fail', () => {
    const { exitCode, output } = runCli({ list: knownApiFailures });
    expect(output).toContain('2 known failures');
    expect(exitCode).toBe(0);
  });

  test('exits 1 and names a new failure', () => {
    const { exitCode, output } = runCli({ list: 'src/billing/billing.controller.spec.ts\n' });
    expect(exitCode).toBe(1);
    expect(output).toContain(
      'src/users/users.service.spec.ts > UsersService > rejects a duplicate email',
    );
  });

  test('exits 1 when a listed test now passes', () => {
    const { exitCode, output } = runCli({
      list: `${knownApiFailures}src/health/health.spec.ts > Health > GET /health > returns ok\n`,
    });
    expect(exitCode).toBe(1);
    expect(output).toContain('src/health/health.spec.ts > Health > GET /health > returns ok');
  });

  test('exits 1 when a listed test is missing from the run', () => {
    const { exitCode, output } = runCli({ list: `${knownApiFailures}src/renamed.spec.ts > x\n` });
    expect(exitCode).toBe(1);
    expect(output).toContain('src/renamed.spec.ts > x');
  });

  test('exits 2 when the report file does not exist', () => {
    const { exitCode, output } = runCli({
      list: knownApiFailures,
      report: join(workDir, 'no-report.json'),
    });
    expect(exitCode).toBe(2);
    expect(output).toContain('no-report.json');
  });

  test('exits 2 when the report is not valid JSON', () => {
    const badReport = join(workDir, 'bad.json');
    writeFileSync(badReport, '{ not json');
    const { exitCode } = runCli({ list: knownApiFailures, report: badReport });
    expect(exitCode).toBe(2);
  });

  // --run-errors: the vitest run-errors reporter's summary
  // (vitest-run-errors-reporter.ts). Vitest's JSON report drops errors thrown
  // outside any test, so this file is the only place they show.
  test('exits 0 with --run-errors when the run had no unhandled errors', () => {
    const { exitCode, output } = runCli({
      list: knownApiFailures,
      runErrors: fixture('run-errors-clean.json'),
    });
    expect(output).toContain('No unhandled errors');
    expect(exitCode).toBe(0);
  });

  test('exits 1 with --run-errors on an unhandled error, even if the tests match', () => {
    const { exitCode, output } = runCli({
      list: knownApiFailures,
      runErrors: fixture('run-errors-unhandled.json'),
    });
    expect(exitCode).toBe(1);
    expect(output).toContain("TypeError: Cannot read properties of undefined (reading 'id')");
  });

  test('exits 1 with --run-errors when the run was interrupted', () => {
    const { exitCode, output } = runCli({
      list: knownApiFailures,
      runErrors: fixture('run-errors-interrupted.json'),
    });
    expect(exitCode).toBe(1);
    expect(output).toContain('interrupted');
  });

  test('exits 2 when the --run-errors file does not exist', () => {
    const { exitCode, output } = runCli({
      list: knownApiFailures,
      runErrors: join(workDir, 'no-run-errors.json'),
    });
    expect(exitCode).toBe(2);
    expect(output).toContain('no-run-errors.json');
  });
});

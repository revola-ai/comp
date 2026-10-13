import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, '..', 'known-failures.ts');
const jestReport = join(import.meta.dir, 'fixtures', 'jest-report.json');

let workDir = '';

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'known-failures-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runCli({ list, report = jestReport }: { list: string; report?: string }) {
  const listPath = join(workDir, 'list.txt');
  writeFileSync(listPath, list);
  const result = Bun.spawnSync({
    cmd: ['bun', script, '--report', report, '--list', listPath, '--root', '/repo/apps/api'],
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
});

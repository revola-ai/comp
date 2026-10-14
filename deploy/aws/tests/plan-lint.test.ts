import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Identifiers the review history (ENG-1) superseded. They are spelled out here, in the test
// source, because this test only ever scans the plan file, never itself.
const SUPERSEDED: readonly string[] = [
  'PRODUCTION_OVERRIDES', // the old overrides constant (now overridesForService)
  'ecsTaskExecutionRole', // the shared execution role (now comp-task-execution-role)
  'docs/releases', // the in-repo release path (now the release-records S3 bucket)
  '--short HEAD', // the 7-character short tag (now --short=12)
  'TLS error class', // the old readiness wording (now tls_<CODE> reasons)
];

export function findSuperseded({ text }: { text: string }): string[] {
  return SUPERSEDED.filter((identifier) => text.includes(identifier));
}

const PLAN_PATH = join(import.meta.dir, '../../../docs/plans/2026-10-05-aws-hosting.md');

describe('findSuperseded', () => {
  test('flags every superseded identifier in a positive fixture', () => {
    const fixture = [
      'export const PRODUCTION_OVERRIDES = {};',
      'role: ecsTaskExecutionRole',
      'write to docs/releases/2026.md',
      'git rev-parse --short HEAD',
      'wait for the TLS error class to clear',
    ].join('\n');
    expect(findSuperseded({ text: fixture }).sort()).toEqual(
      [
        'PRODUCTION_OVERRIDES',
        'ecsTaskExecutionRole',
        'docs/releases',
        '--short HEAD',
        'TLS error class',
      ].sort(),
    );
  });

  test('does not flag the current wording', () => {
    const fixture = 'git rev-parse --short=12 HEAD; comp-task-execution-role; tls_<CODE> reason';
    expect(findSuperseded({ text: fixture })).toEqual([]);
  });
});

describe('the AWS hosting plan', () => {
  test('contains no superseded identifier', () => {
    expect(findSuperseded({ text: readFileSync(PLAN_PATH, 'utf8') })).toEqual([]);
  });
});

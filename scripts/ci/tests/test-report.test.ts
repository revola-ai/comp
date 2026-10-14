import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeTestId, parseTestReport } from '../lib/test-report';

const fixtures = join(import.meta.dir, 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
}

describe('parseTestReport with a jest report', () => {
  const outcomes = parseTestReport({
    json: loadFixture('jest-report.json'),
    root: '/repo/apps/api',
  });

  test('names each test by package-relative file, describe blocks and title', () => {
    expect(outcomes.get('src/users/users.service.spec.ts > UsersService > creates a user')).toBe(
      'passed',
    );
    expect(
      outcomes.get('src/users/users.service.spec.ts > UsersService > rejects a duplicate email'),
    ).toBe('failed');
    expect(outcomes.get('src/health/health.spec.ts > Health > GET /health > returns ok')).toBe(
      'passed',
    );
  });

  test('leaves out pending and skipped tests', () => {
    expect(outcomes.has('src/users/users.service.spec.ts > UsersService > deletes a user')).toBe(
      false,
    );
  });

  test('records a suite that failed to run as a failure of the whole file', () => {
    expect(outcomes.get('src/billing/billing.controller.spec.ts')).toBe('failed');
  });

  test('records a file that ran cleanly as a passed file id', () => {
    expect(outcomes.get('src/health/health.spec.ts')).toBe('passed');
    expect(outcomes.get('src/users/users.service.spec.ts')).toBe('passed');
  });

  test('collapses whitespace in titles so every id fits on one line', () => {
    expect(outcomes.get('src/health/health.spec.ts > top level test with odd spacing')).toBe(
      'passed',
    );
  });
});

describe('parseTestReport with a vitest report', () => {
  const outcomes = parseTestReport({
    json: loadFixture('vitest-report.json'),
    root: '/repo/apps/app',
  });

  test('reads passed and failed tests', () => {
    expect(
      outcomes.get(
        'src/components/policy-editor.test.tsx > PolicyEditor > when read only > hides the save button',
      ),
    ).toBe('passed');
    expect(
      outcomes.get('src/components/policy-editor.test.tsx > PolicyEditor > saves a draft'),
    ).toBe('failed');
  });

  test('leaves out skipped tests', () => {
    expect(outcomes.has('src/components/policy-editor.test.tsx > PolicyEditor > publishes')).toBe(
      false,
    );
  });

  test('records a file that failed to load as a failure of the whole file', () => {
    expect(outcomes.get('src/lib/broken.test.ts')).toBe('failed');
  });

  test('merges tests that share an id', () => {
    expect(outcomes.get('src/lib/format.test.ts > formats a date')).toBe('passed');
  });
});

describe('parseTestReport edge cases', () => {
  const file = (assertions: { title: string; status: string }[]) => ({
    name: '/pkg/src/a.test.ts',
    status: assertions.some((a) => a.status === 'failed') ? 'failed' : 'passed',
    message: '',
    assertionResults: assertions.map((a) => ({ ancestorTitles: [], ...a })),
  });

  test('a shared id fails when any of its runs fails', () => {
    const outcomes = parseTestReport({
      json: {
        testResults: [
          file([
            { title: 'same', status: 'passed' },
            { title: 'same', status: 'failed' },
          ]),
        ],
      },
      root: '/pkg',
    });
    expect(outcomes.get('src/a.test.ts > same')).toBe('failed');
  });

  test('rejects a report that does not match the runner format', () => {
    expect(() => parseTestReport({ json: { results: [] }, root: '/pkg' })).toThrow();
  });

  test('rejects an unknown test status', () => {
    expect(() =>
      parseTestReport({
        json: { testResults: [file([{ title: 'x', status: 'exploded' }])] },
        root: '/pkg',
      }),
    ).toThrow();
  });

  test('rejects a report with no test files', () => {
    expect(() => parseTestReport({ json: { testResults: [] }, root: '/pkg' })).toThrow(
      /no test files/,
    );
  });

  test('rejects an interrupted run', () => {
    expect(() =>
      parseTestReport({
        json: { wasInterrupted: true, testResults: [file([{ title: 'x', status: 'passed' }])] },
        root: '/pkg',
      }),
    ).toThrow(/interrupted/);
  });
});

describe('normalizeTestId', () => {
  test('trims and collapses runs of whitespace', () => {
    expect(normalizeTestId('  src/a.ts >  x\n\ty  ')).toBe('src/a.ts > x y');
  });
});

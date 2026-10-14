import { describe, expect, test } from 'bun:test';
import { compareWithKnownFailures, formatComparison } from '../lib/compare';
import { parseKnownFailuresList } from '../lib/known-failures-list';
import type { TestOutcomes } from '../lib/test-report';

const outcomes: TestOutcomes = new Map([
  ['src/a.spec.ts', 'passed'],
  ['src/a.spec.ts > A > passes', 'passed'],
  ['src/a.spec.ts > A > known broken', 'failed'],
  ['src/b.spec.ts', 'failed'],
]);

describe('compareWithKnownFailures', () => {
  test('all good: only listed tests fail', () => {
    const result = compareWithKnownFailures({
      outcomes,
      knownFailures: ['src/a.spec.ts > A > known broken', 'src/b.spec.ts'],
    });
    expect(result.unexpectedFailures).toEqual([]);
    expect(result.nowPassing).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.stillFailing).toEqual(['src/a.spec.ts > A > known broken', 'src/b.spec.ts']);
    expect(formatComparison(result).ok).toBe(true);
  });

  test('new failure: a failing test that is not listed', () => {
    const result = compareWithKnownFailures({ outcomes, knownFailures: ['src/b.spec.ts'] });
    expect(result.unexpectedFailures).toEqual(['src/a.spec.ts > A > known broken']);
    expect(formatComparison(result).ok).toBe(false);
  });

  test('suite load failure: an unlisted file that failed to run is a new failure', () => {
    const result = compareWithKnownFailures({
      outcomes,
      knownFailures: ['src/a.spec.ts > A > known broken'],
    });
    expect(result.unexpectedFailures).toEqual(['src/b.spec.ts']);
    expect(formatComparison(result).ok).toBe(false);
  });

  test('listed test passed: it must be removed from the list', () => {
    const result = compareWithKnownFailures({
      outcomes,
      knownFailures: [
        'src/a.spec.ts > A > known broken',
        'src/b.spec.ts',
        'src/a.spec.ts > A > passes',
      ],
    });
    expect(result.nowPassing).toEqual(['src/a.spec.ts > A > passes']);
    expect(result.unexpectedFailures).toEqual([]);
    const formatted = formatComparison(result);
    expect(formatted.ok).toBe(false);
    expect(formatted.text).toContain('remove');
    expect(formatted.text).toContain('src/a.spec.ts > A > passes');
  });

  test('listed test missing: renamed, deleted or skipped tests fail the check', () => {
    const result = compareWithKnownFailures({
      outcomes,
      knownFailures: ['src/a.spec.ts > A > known broken', 'src/b.spec.ts', 'src/gone.spec.ts > x'],
    });
    expect(result.missing).toEqual(['src/gone.spec.ts > x']);
    const formatted = formatComparison(result);
    expect(formatted.ok).toBe(false);
    expect(formatted.text).toContain('src/gone.spec.ts > x');
  });

  test('the report lists every problem group with its ids', () => {
    const result = compareWithKnownFailures({
      outcomes,
      knownFailures: ['src/a.spec.ts > A > passes', 'src/gone.spec.ts > x'],
    });
    const { ok, text } = formatComparison(result);
    expect(ok).toBe(false);
    expect(text).toContain('src/a.spec.ts > A > known broken');
    expect(text).toContain('src/b.spec.ts');
    expect(text).toContain('src/a.spec.ts > A > passes');
    expect(text).toContain('src/gone.spec.ts > x');
  });
});

describe('parseKnownFailuresList', () => {
  test('skips comments and blank lines and normalizes whitespace', () => {
    const text = '# header\n#\n\nsrc/a.spec.ts > A >  known broken  \n  src/b.spec.ts\n';
    expect(parseKnownFailuresList(text)).toEqual([
      'src/a.spec.ts > A > known broken',
      'src/b.spec.ts',
    ]);
  });

  test('rejects a duplicate entry', () => {
    expect(() => parseKnownFailuresList('src/b.spec.ts\nsrc/b.spec.ts\n')).toThrow(/duplicate/i);
  });

  test('an empty list is valid', () => {
    expect(parseKnownFailuresList('# nothing is known to fail\n')).toEqual([]);
  });
});

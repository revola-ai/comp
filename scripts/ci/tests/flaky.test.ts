import { describe, expect, test } from 'bun:test';
import { compareWithKnownFailures, formatComparison } from '../lib/compare';
import { parseFlakyEntries, parseKnownFailuresList } from '../lib/known-failures-list';
import type { TestOutcomes } from '../lib/test-report';

const FLAKY = 'src/a.spec.ts > A > sometimes fails';

function outcomesWith(status: 'passed' | 'failed'): TestOutcomes {
  return new Map([
    ['src/a.spec.ts > A > passes', 'passed'],
    [FLAKY, status],
  ]);
}

describe('flaky entries', () => {
  test('a flaky entry is accepted when it fails', () => {
    const result = compareWithKnownFailures({
      outcomes: outcomesWith('failed'),
      knownFailures: [],
      flaky: [FLAKY],
    });
    expect(result.unexpectedFailures).toEqual([]);
    expect(formatComparison(result).ok).toBe(true);
  });

  test('a flaky entry is accepted when it passes', () => {
    const result = compareWithKnownFailures({
      outcomes: outcomesWith('passed'),
      knownFailures: [],
      flaky: [FLAKY],
    });
    expect(result.nowPassing).toEqual([]);
    expect(formatComparison(result).ok).toBe(true);
  });

  test('a flaky entry that no longer runs still fails the check', () => {
    const result = compareWithKnownFailures({
      outcomes: new Map([['src/a.spec.ts > A > passes', 'passed']]),
      knownFailures: [],
      flaky: [FLAKY],
    });
    expect(result.missing).toEqual([FLAKY]);
    expect(formatComparison(result).ok).toBe(false);
  });

  test('the parser separates flaky entries from known failures', () => {
    const text = `# header\nsrc/b.spec.ts > B > broken\nflaky: ${FLAKY}\n`;
    expect(parseKnownFailuresList(text)).toEqual(['src/b.spec.ts > B > broken']);
    expect(parseFlakyEntries(text)).toEqual([FLAKY]);
  });

  test('an id listed both as failing and as flaky is a duplicate', () => {
    const text = `${FLAKY}\nflaky: ${FLAKY}\n`;
    expect(() => parseKnownFailuresList(text)).toThrow(/duplicate/i);
  });
});

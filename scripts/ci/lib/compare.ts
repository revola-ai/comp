import type { TestOutcomes } from './test-report';

export interface Comparison {
  /** Failed in this run but not listed: a new failure. */
  unexpectedFailures: string[];
  /** Listed but passed in this run: delete the entry. */
  nowPassing: string[];
  /** Listed but not in this run (renamed, deleted or skipped): delete or fix the entry. */
  missing: string[];
  /** Listed and still failing. */
  stillFailing: string[];
  /** Tests (not file ids) that passed in this run. */
  passedCount: number;
}

export function compareWithKnownFailures({
  outcomes,
  knownFailures,
  flaky = [],
}: {
  outcomes: TestOutcomes;
  knownFailures: readonly string[];
  /** Tests that may pass or fail in a full run; each must still run. */
  flaky?: readonly string[];
}): Comparison {
  const known = new Set(knownFailures);
  const mayFail = new Set(flaky);
  const unexpectedFailures: string[] = [];
  let passedCount = 0;

  for (const [id, status] of outcomes) {
    if (status === 'failed' && !known.has(id) && !mayFail.has(id)) unexpectedFailures.push(id);
    if (status === 'passed' && id.includes(' > ')) passedCount += 1;
  }

  const nowPassing: string[] = [];
  const missing: string[] = [];
  const stillFailing: string[] = [];
  for (const id of knownFailures) {
    const status = outcomes.get(id);
    if (status === 'failed') stillFailing.push(id);
    else if (status === 'passed') nowPassing.push(id);
    else missing.push(id);
  }
  for (const id of flaky) {
    if (!outcomes.has(id)) missing.push(id);
  }

  return {
    unexpectedFailures: unexpectedFailures.sort(),
    nowPassing,
    missing,
    stillFailing,
    passedCount,
  };
}

function section({ title, ids }: { title: string; ids: readonly string[] }): string[] {
  if (ids.length === 0) return [];
  return ['', `${title} (${ids.length}):`, ...ids.map((id) => `  ${id}`)];
}

export function formatComparison(comparison: Comparison): { ok: boolean; text: string } {
  const { unexpectedFailures, nowPassing, missing, stillFailing, passedCount } = comparison;
  const ok = unexpectedFailures.length === 0 && nowPassing.length === 0 && missing.length === 0;

  const lines = [
    `${passedCount} tests passed, ${stillFailing.length} known failures still fail.`,
    ...section({
      title: 'NEW FAILURES, fix them (do not add them to the list)',
      ids: unexpectedFailures,
    }),
    ...section({
      title: 'Listed tests that now PASS, remove them from the known-failures list',
      ids: nowPassing,
    }),
    ...section({
      title: 'Listed tests that did not run (renamed, deleted or skipped), remove or update them',
      ids: missing,
    }),
    '',
    ok
      ? 'OK: only known failures failed.'
      : 'FAILED: the run does not match the known-failures list.',
  ];
  return { ok, text: lines.join('\n') };
}

import { normalizeTestId } from './test-report';

/** Prefix of an entry that may pass or fail: a test that fails only in some full runs. */
const FLAKY_PREFIX = 'flaky:';

type Entry = { id: string; flaky: boolean };

/**
 * Reads every entry of a known-failures list: one test id per line, `#` starts a comment
 * line, blank lines are ignored, `flaky: <id>` marks a test that may pass or fail. An id
 * listed twice (also once as failing and once as flaky) is an error so the list stays exact.
 */
function parseEntries(text: string): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();

  for (const line of text.split('\n')) {
    const normalized = normalizeTestId(line);
    if (normalized === '' || normalized.startsWith('#')) continue;
    const flaky = normalized.startsWith(FLAKY_PREFIX);
    const id = flaky ? normalizeTestId(normalized.slice(FLAKY_PREFIX.length)) : normalized;
    if (seen.has(id)) {
      throw new Error(`duplicate entry in the known-failures list: ${id}`);
    }
    seen.add(id);
    entries.push({ id, flaky });
  }
  return entries;
}

/** The ids that are known to fail (every entry not marked flaky). */
export function parseKnownFailuresList(text: string): string[] {
  return parseEntries(text)
    .filter((entry) => !entry.flaky)
    .map((entry) => entry.id);
}

/** The ids marked `flaky:`, which may pass or fail but must still run. */
export function parseFlakyEntries(text: string): string[] {
  return parseEntries(text)
    .filter((entry) => entry.flaky)
    .map((entry) => entry.id);
}

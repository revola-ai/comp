import { normalizeTestId } from './test-report';

/**
 * Parses a known-failures list: one test id per line, `#` starts a comment line,
 * blank lines are ignored. A duplicate entry is an error so the list stays exact.
 */
export function parseKnownFailuresList(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const line of text.split('\n')) {
    const id = normalizeTestId(line);
    if (id === '' || id.startsWith('#')) continue;
    if (seen.has(id)) {
      throw new Error(`duplicate entry in the known-failures list: ${id}`);
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

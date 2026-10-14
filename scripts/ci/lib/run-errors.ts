import { z } from 'zod';

/**
 * The summary vitest-run-errors-reporter.ts writes at the end of a vitest run.
 * Vitest's JSON report leaves out errors thrown outside any test (an unhandled
 * rejection after a test finished, a failing setup file), so this is the only
 * record of them.
 */
export const runErrorsSchema = z.object({
  unhandledErrors: z.number().int().nonnegative(),
  reason: z.enum(['passed', 'failed', 'interrupted']),
  messages: z.array(z.string()),
});

export type RunErrors = z.infer<typeof runErrorsSchema>;

/** ok when the run finished (passed or failed) with no unhandled errors. */
export function checkRunErrors(json: unknown): { ok: boolean; text: string } {
  const parsed = runErrorsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `the run-errors file does not match the reporter's format:\n${z.prettifyError(parsed.error)}`,
    );
  }
  const { unhandledErrors, reason, messages } = parsed.data;
  const lines: string[] = [];
  if (reason === 'interrupted') {
    lines.push('FAILED: the test run was interrupted, so its report is incomplete.');
  }
  if (unhandledErrors > 0) {
    const noun = unhandledErrors === 1 ? 'error' : 'errors';
    lines.push(
      `FAILED: ${unhandledErrors} unhandled ${noun} outside any test (the JSON report omits them):`,
      ...messages.map((message) => `  ${message}`),
    );
  }
  if (lines.length === 0) {
    return { ok: true, text: 'No unhandled errors, and the run was not interrupted.' };
  }
  return { ok: false, text: lines.join('\n') };
}

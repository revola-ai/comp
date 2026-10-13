import { relative, sep } from 'node:path';
import { z } from 'zod';

/**
 * Reads the JSON report of jest (`--json --outputFile`) or vitest
 * (`--reporter=json --outputFile`). Both runners write the same jest-compatible shape.
 */

export type TestStatus = 'passed' | 'failed';

/** Test id -> outcome. A test id is `<file> > <describe> > ... > <title>`; a bare file is a file id. */
export type TestOutcomes = ReadonlyMap<string, TestStatus>;

// Every status either runner emits. An unknown one fails parsing rather than being misread.
const assertionStatusSchema = z.enum([
  'passed',
  'failed',
  'skipped',
  'pending',
  'todo',
  'disabled',
  'focused',
]);

const assertionSchema = z.object({
  ancestorTitles: z.array(z.string()),
  title: z.string(),
  status: assertionStatusSchema,
});

const testFileSchema = z.object({
  name: z.string().min(1),
  status: z.string(),
  message: z.string().optional(),
  assertionResults: z.array(assertionSchema),
});

const reportSchema = z.object({
  wasInterrupted: z.boolean().optional(),
  testResults: z.array(testFileSchema),
});

type TestFile = z.infer<typeof testFileSchema>;

export function normalizeTestId(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function toFileId({ path, root }: { path: string; root: string }): string {
  return normalizeTestId(relative(root, path).split(sep).join('/'));
}

function record({
  outcomes,
  id,
  status,
}: {
  outcomes: Map<string, TestStatus>;
  id: string;
  status: TestStatus;
}): void {
  // A shared id (duplicate titles, test.each) fails when any of its runs fails.
  if (outcomes.get(id) === 'failed') return;
  outcomes.set(id, status);
}

function recordFile({
  outcomes,
  file,
  root,
}: {
  outcomes: Map<string, TestStatus>;
  file: TestFile;
  root: string;
}): void {
  const fileId = toFileId({ path: file.name, root });
  let anyTestFailed = false;

  for (const assertion of file.assertionResults) {
    if (assertion.status !== 'passed' && assertion.status !== 'failed') continue;
    if (assertion.status === 'failed') anyTestFailed = true;
    const id = normalizeTestId([fileId, ...assertion.ancestorTitles, assertion.title].join(' > '));
    record({ outcomes, id, status: assertion.status });
  }

  // A file that failed with no failing test failed outside a test: it did not load, or a
  // hook (beforeAll/afterAll) threw. Either way the whole file is the failure.
  const fileFailed = file.status === 'failed' && !anyTestFailed;
  record({ outcomes, id: fileId, status: fileFailed ? 'failed' : 'passed' });
}

export function parseTestReport({ json, root }: { json: unknown; root: string }): TestOutcomes {
  const parsed = reportSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `test report does not match the jest/vitest JSON format:\n${z.prettifyError(parsed.error)}`,
    );
  }
  const report = parsed.data;
  if (report.wasInterrupted) {
    throw new Error('the test run was interrupted, so its report is incomplete');
  }
  if (report.testResults.length === 0) {
    throw new Error('the test report has no test files');
  }

  const outcomes = new Map<string, TestStatus>();
  for (const file of report.testResults) {
    recordFile({ outcomes, file, root });
  }
  return outcomes;
}

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The secret payload reaches the AWS CLI as `--secret-string file://<path>`, never as an
// argument or through a pipe (the CLI reads a paramfile twice, so file:///dev/stdin cannot
// work). The file is 0600 inside a private 0700 temporary directory, removed on every path.
// Ported from the parked deploy/aws/private-file.ts (revola/aws-infra).

/** Runs `work` with `contents` in a 0600 file of a private temporary directory. */
export async function withPrivateFile<T>({
  prefix,
  contents,
  work,
}: {
  prefix: string;
  contents: string;
  work: (file: string) => Promise<T>;
}): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    const file = join(dir, 'body');
    writeFileSync(file, contents, { mode: 0o600, flag: 'wx' });
    return await work(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

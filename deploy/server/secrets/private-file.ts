import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The secret payload reaches the AWS CLI as `--secret-string file://<path>`, never as an
// argument or through a pipe (the CLI reads a paramfile twice, so file:///dev/stdin cannot
// work). The file is 0600 inside a private 0700 temporary directory, removed on every path:
// when the work ends or throws, and when the operator interrupts (SIGINT), the session ends
// (SIGHUP) or something stops the process (SIGTERM) while the file exists. Only SIGKILL can
// leave it behind. Ported from the parked deploy/aws/private-file.ts (revola/aws-infra).

/** The signals that remove the directory, with the exit status a shell reports for each. */
const EXIT_ON: Readonly<Record<'SIGINT' | 'SIGTERM' | 'SIGHUP', number>> = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
});

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
  const remove = () => rmSync(dir, { recursive: true, force: true });
  const handlers = Object.entries(EXIT_ON).map(([signal, status]) => {
    const handler = () => {
      remove();
      process.exit(status);
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  try {
    const file = join(dir, 'body');
    writeFileSync(file, contents, { mode: 0o600, flag: 'wx' });
    return await work(file);
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
    remove();
  }
}

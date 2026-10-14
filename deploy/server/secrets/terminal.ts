import { closeSync, openSync, readSync } from 'node:fs';

// Typed confirmations come from the operator's terminal only, the same rule as
// lib/provision-common.sh: the answer is read from /dev/tty, never from stdin, so piped input
// confirms nothing; without a terminal the caller refuses before doing anything. There is no
// test override: tests type into a pseudo-terminal (tests/tty_run.py).

export type Terminal = Readonly<{
  /** Prints `prompt` and returns the line typed (empty at end of input). */
  ask: (prompt: string) => string;
  close: () => void;
}>;

/** The controlling terminal, or undefined when there is none. */
export function openTerminal(): Terminal | undefined {
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r');
  } catch {
    return undefined;
  }
  return {
    ask: (prompt) => {
      process.stdout.write(prompt);
      const bytes: number[] = [];
      const buffer = Buffer.alloc(1);
      while (readSync(fd, buffer, 0, 1, null) === 1) {
        const byte = buffer[0];
        if (byte === undefined || byte === 0x0a) break;
        bytes.push(byte);
      }
      if (!process.stdout.isTTY) process.stdout.write('\n');
      return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
    },
    close: () => closeSync(fd),
  };
}

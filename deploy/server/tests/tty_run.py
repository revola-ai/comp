#!/usr/bin/env python3
"""Runs a command with or without a controlling terminal, for deploy/server/tests/provision*.

  tty_run.py --typed TEXT [--stdin TEXT] --out FILE -- COMMAND...
      A fresh pseudo-terminal is COMMAND's controlling terminal (its /dev/tty). TEXT is typed
      into it, followed by end-of-input (Ctrl-D) for every later read, as a person would.
  tty_run.py --no-tty [--stdin TEXT] --out FILE -- COMMAND...
      COMMAND runs in a new session with no controlling terminal, so /dev/tty cannot be opened.

Either way COMMAND's stdin is a pipe holding --stdin (empty by default), and its stdout and
stderr go to FILE. Exits with COMMAND's status (124 when it runs longer than 120 seconds).
"""
import argparse
import os
import select
import signal
import subprocess
import sys
import time

TIMEOUT_SECONDS = 120
EOF = b'\x04' * 64  # one Ctrl-D per read after the typed text runs out


def parse():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--typed')
    mode.add_argument('--no-tty', action='store_true')
    parser.add_argument('--stdin', default='')
    parser.add_argument('--out', required=True)
    parser.add_argument('command', nargs='+')
    return parser.parse_args()


def run_without_tty(args: argparse.Namespace) -> int:
    with open(args.out, 'wb') as out:
        try:
            done = subprocess.run(args.command, input=args.stdin.encode(), stdout=out,
                                  stderr=subprocess.STDOUT, start_new_session=True,
                                  timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            return 124
    return done.returncode


def run_with_tty(args: argparse.Namespace, typed: str) -> int:
    stdin_read, stdin_write = os.pipe()
    pid, master = os.forkpty()
    if pid == 0:  # child: the pty slave is fds 0-2 and the controlling terminal
        keep = os.dup(0)  # keeps the terminal open (and its typed input) after the dup2s
        os.set_inheritable(keep, True)
        out = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        os.dup2(stdin_read, 0)
        os.dup2(out, 1)
        os.dup2(out, 2)
        os.close(stdin_write)
        os.execvp(args.command[0], args.command)
    os.close(stdin_read)
    os.write(stdin_write, args.stdin.encode())
    os.close(stdin_write)
    os.write(master, typed.encode() + EOF)
    deadline = time.monotonic() + TIMEOUT_SECONDS
    while True:  # drain the terminal (the echo of the typed text) until the command exits
        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished:
            break
        if time.monotonic() > deadline:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            return 124
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                os.read(master, 4096)
            except OSError:
                pass
    os.close(master)
    return os.waitstatus_to_exitcode(status)


def main() -> int:
    args = parse()
    if args.no_tty:
        return run_without_tty(args)
    return run_with_tty(args, args.typed)


if __name__ == '__main__':
    sys.exit(main())

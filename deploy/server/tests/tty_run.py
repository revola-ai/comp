#!/usr/bin/env python3
"""Runs a command with or without a controlling terminal, for deploy/server/tests/provision*.

  tty_run.py --typed TEXT [--stdin TEXT] --out FILE -- COMMAND...
      A fresh pseudo-terminal is COMMAND's controlling terminal (its /dev/tty). TEXT is typed
      into it, followed by end-of-input (Ctrl-D) for every later read, as a person would.
  tty_run.py --no-tty [--stdin TEXT] --out FILE -- COMMAND...
      COMMAND runs in a new session with no controlling terminal, so /dev/tty cannot be opened.

Either way COMMAND runs in --cwd (default: the current directory), its stdin is a pipe holding
--stdin (empty by default), and its stdout and stderr go to FILE. Exits with COMMAND's status.
A run longer than $TTY_RUN_TIMEOUT seconds (default 120) is killed with its whole process group,
"tty_run: timed out after N seconds" is appended to FILE, and the exit status is 124.
"""
import argparse
import os
import select
import signal
import subprocess
import sys
import time

TIMEOUT_SECONDS = int(os.environ.get('TTY_RUN_TIMEOUT', '120'))
TIMED_OUT = 124
EOF = b'\x04' * 64  # one Ctrl-D per read after the typed text runs out


def parse():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--typed')
    mode.add_argument('--no-tty', action='store_true')
    parser.add_argument('--stdin', default='')
    parser.add_argument('--out', required=True)
    parser.add_argument('--cwd', default='.')
    parser.add_argument('command', nargs='+')
    return parser.parse_args()


def timed_out(args: argparse.Namespace, group: int) -> int:
    """Kills the command and everything it started, and says so in its output."""
    try:
        os.killpg(group, signal.SIGKILL)
    except ProcessLookupError:
        pass
    with open(args.out, 'a') as out:
        out.write(f'\ntty_run: timed out after {TIMEOUT_SECONDS} seconds\n')
    return TIMED_OUT


def run_without_tty(args: argparse.Namespace) -> int:
    with open(args.out, 'wb') as out:
        child = subprocess.Popen(args.command, stdin=subprocess.PIPE, stdout=out,
                                 stderr=subprocess.STDOUT, start_new_session=True, cwd=args.cwd)
        try:
            child.communicate(args.stdin.encode(), timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            status = timed_out(args, child.pid)
            child.wait()
            return status
    return child.returncode


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
        os.chdir(args.cwd)
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
        if time.monotonic() > deadline:  # forkpty made the child a session (and group) leader
            code = timed_out(args, pid)
            os.waitpid(pid, 0)
            return code
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

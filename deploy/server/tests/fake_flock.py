#!/usr/bin/env python3
"""A stand-in for util-linux `flock -n FD` and `flock -w SECONDS FD` (macOS has none), for
deploy/server/tests.

Like the real one it locks the open file description behind FD, which the calling shell
keeps, so the lock lasts until that shell closes FD or exits. Exits 1 when another open
file description holds the lock: at once with -n; with -w after waiting, in real time, for at
most SECONDS or $FAKE_FLOCK_MAX_WAIT seconds (default 2), whichever is less, so a test never
waits long. Each call is appended to $FAKE_FLOCK_LOG, when set, as "flock <args>".
"""
import fcntl
import os
import sys
import time

args = sys.argv[1:]
if os.environ.get('FAKE_FLOCK_LOG'):
    with open(os.environ['FAKE_FLOCK_LOG'], 'a') as log:
        log.write(' '.join(['flock', *args]) + '\n')
if not (args[:1] == ['-n'] and len(args) == 2) and not (args[:1] == ['-w'] and len(args) == 3):
    print(f'fake flock: only `flock -n FD` and `flock -w SECONDS FD` are supported, got {args}', file=sys.stderr)
    sys.exit(2)
wait = 0.0 if args[0] == '-n' else min(float(args[1]), float(os.environ.get('FAKE_FLOCK_MAX_WAIT', '2')))
deadline = time.monotonic() + wait
while True:
    try:
        fcntl.flock(int(args[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
        sys.exit(0)
    except BlockingIOError:
        if time.monotonic() >= deadline:
            sys.exit(1)
        time.sleep(0.05)

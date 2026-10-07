#!/usr/bin/env python3
"""A stand-in for util-linux `flock -n FD` (macOS has none), for deploy/server/tests.

Like the real one it locks the open file description behind FD, which the calling shell
keeps, so the lock lasts until that shell closes FD or exits. Exits 1 when another open
file description holds the lock.
"""
import fcntl
import sys

if sys.argv[1:2] != ['-n'] or len(sys.argv) != 3:
    print(f'fake flock: only `flock -n FD` is supported, got {sys.argv[1:]}', file=sys.stderr)
    sys.exit(2)
try:
    fcntl.flock(int(sys.argv[2]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(1)

#!/usr/bin/env python3
"""A stand-in for curl, for the smoke checks of deploy/server/release.sh in deploy/server/tests.

It answers `curl ... -w '%{http_code} %{redirect_url}' URL` from the fake docker state: the
health routes answer 200 while the stack's containers run a tag other than
$FAKE_CURL_BAD_TAG, and 502 (Cloudflare's answer for a dead origin) otherwise. The app's root
and the portal's root answer Cloudflare Access's 302 at the edge whatever the server does,
unless $FAKE_CURL_NO_ACCESS is set (200: Access is off): "app" or "portal" for that host only,
anything else for both. With $FAKE_CURL_BAD_ENV set, the health
routes also answer 502 while the api.env the containers run with (the fake docker state's
"up") holds that text: a bad secret. Every URL is appended to $FAKE_CURL_LOG.
With $FAKE_CURL_INTERRUPT set to INT, TERM or HUP, the first check sends that signal to the
process group (the laptop's release.sh, as a Ctrl-C would) and dies of it. With $FAKE_CURL_SLOW
set to n, the first n tries of each URL time out: they answer 000 and exit 28, as curl does, and
advance the fake clock ($FAKE_CLOCK) by their --max-time. With $FAKE_CURL_JUMP set to
"<n>:<seconds>", the n-th call of the run advances the fake clock by <seconds> first, as a laptop
that slept during a try would see.
"""
import json
import os
import signal
import sys
import time

url = sys.argv[-1]
with open(os.environ['FAKE_CURL_LOG'], 'a') as log:
    log.write(url + '\n')
if os.environ.get('FAKE_CURL_INTERRUPT') and not os.path.exists(os.environ['FAKE_CURL_LOG'] + '.interrupted'):
    open(os.environ['FAKE_CURL_LOG'] + '.interrupted', 'w').close()
    number = getattr(signal, 'SIG' + os.environ['FAKE_CURL_INTERRUPT'])
    signal.signal(number, signal.SIG_DFL)
    os.killpg(os.getpgrp(), number)
    time.sleep(5)
    sys.exit(1)
if sys.argv[-3:-1] != ['-w', '%{http_code} %{redirect_url}'] or '--max-time' not in sys.argv:
    print(f'fake curl: unexpected arguments {sys.argv[1:]}', file=sys.stderr)
    sys.exit(2)
with open(os.environ['FAKE_CURL_LOG']) as log:
    calls = log.read().splitlines()
tries = sum(line == url for line in calls)
jump_at, _, jump = os.environ.get('FAKE_CURL_JUMP', '').partition(':')
if jump_at and len(calls) == int(jump_at):
    clock = os.environ['FAKE_CLOCK']
    seconds = int(open(clock).read()) + int(jump)
    open(clock, 'w').write(f'{seconds}\n')
if tries <= int(os.environ.get('FAKE_CURL_SLOW', '0')):
    clock = os.environ.get('FAKE_CLOCK')
    if clock:
        seconds = int(open(clock).read()) + int(sys.argv[sys.argv.index('--max-time') + 1])
        open(clock, 'w').write(f'{seconds}\n')
    print('000 ', end='')
    sys.exit(28)

ROOTS = {'https://app.comp.revola.ai/': 'app', 'https://portal.comp.revola.ai/': 'portal'}
if url in ROOTS:
    off = os.environ.get('FAKE_CURL_NO_ACCESS', '')
    if off and (off == ROOTS[url] or off not in ROOTS.values()):
        print('200 ', end='')
    else:
        print(f'302 https://revola.cloudflareaccess.com/cdn-cgi/access/login/{url[8:-1]}', end='')
    sys.exit(0)

with open(os.environ['FAKE_DOCKER_STATE']) as handle:
    docker = json.load(handle)
serving = docker.get('containers', {}).get('api', ':').split(':', 1)[1]
healthy = bool(serving) and serving != os.environ.get('FAKE_CURL_BAD_TAG')
if healthy and os.environ.get('FAKE_CURL_BAD_ENV'):
    with open(os.path.join(docker['up']['env'], 'api.env')) as handle:
        healthy = os.environ['FAKE_CURL_BAD_ENV'] not in handle.read()
print('200 ' if healthy else '502 ', end='')

#!/usr/bin/env python3
"""A stand-in for curl, for the smoke checks of deploy/server/release.sh in deploy/server/tests.

It answers `curl ... -w '%{http_code} %{redirect_url}' URL` from the fake docker state: the
health routes answer 200 while the stack's containers run a tag other than
$FAKE_CURL_BAD_TAG, and 502 (Cloudflare's answer for a dead origin) otherwise. The app's root
answers Cloudflare Access's 302 at the edge whatever the server does, unless
$FAKE_CURL_NO_ACCESS is set (200: Access is off). Every URL is appended to $FAKE_CURL_LOG.
"""
import json
import os
import sys

url = sys.argv[-1]
with open(os.environ['FAKE_CURL_LOG'], 'a') as log:
    log.write(url + '\n')
if sys.argv[-3:-1] != ['-w', '%{http_code} %{redirect_url}']:
    print(f'fake curl: unexpected arguments {sys.argv[1:]}', file=sys.stderr)
    sys.exit(2)

if url == 'https://app.comp.revola.ai/':
    if os.environ.get('FAKE_CURL_NO_ACCESS'):
        print('200 ', end='')
    else:
        print('302 https://revola.cloudflareaccess.com/cdn-cgi/access/login/app.comp.revola.ai', end='')
    sys.exit(0)

with open(os.environ['FAKE_DOCKER_STATE']) as handle:
    containers = json.load(handle).get('containers', {})
serving = containers.get('api', ':').split(':', 1)[1]
healthy = bool(serving) and serving != os.environ.get('FAKE_CURL_BAD_TAG')
print('200 ' if healthy else '502 ', end='')

#!/usr/bin/env bash
# Writes the env files the compose stack reads (deploy/server/compose.yaml). Runs on the
# server as root, before every `docker compose up`:
#
#   deploy/server/render-env.sh [--out-dir /opt/comp/env]
#
# For each deploy/server/env/<service>.keys it writes <out-dir>/<service>.env (mode 0600 in a
# 0700 directory) holding exactly the listed keys, valued from the Secrets Manager secret
# comp/production/config (one JSON object), then the committed non-secret lines of
# <service>.public.env. Every service is checked before any file is written: a listed key
# that is missing, empty, not a string or contains a line break stops the run, by name.
# Values are never printed, never passed as arguments and never written outside <out-dir>.
# Files are written verbatim, one NAME=VALUE per line (compose reads them with format: raw).
set -euo pipefail

SECRET_ID="comp/production/config"
REGION="us-east-2"
KEYS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env"
OUT_DIR="/opt/comp/env"

usage() {
  echo "usage: $(basename "$0") [--out-dir DIR]   (default $OUT_DIR)"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      [[ $# -ge 2 && -n "$2" ]] || { usage >&2; exit 2; }
      OUT_DIR="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

for tool in aws python3; do
  command -v "$tool" >/dev/null || { echo "render-env: $tool is not installed" >&2; exit 1; }
done

# The secret stays in this shell's memory and reaches python3 on stdin only.
if ! secret_json="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" \
  --region "$REGION" --query SecretString --output text)"; then
  echo "render-env: could not read $SECRET_ID in $REGION; no env file written" >&2
  exit 1
fi

umask 077
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

read -r -d '' RENDER_PY <<'PY' || true
import json, os, re, sys, tempfile

keys_dir, out_dir, secret_id = sys.argv[1:4]
NAME = re.compile(r'[A-Z][A-Z0-9_]*\Z')
KEYS_LINE = re.compile(r'([A-Z][A-Z0-9_]*)(?: from ([A-Z][A-Z0-9_]*))?\Z')


def stop(message):
    print(f'render-env: {message}', file=sys.stderr)
    sys.exit(1)


def content_lines(path):
    with open(path) as handle:
        for number, line in enumerate(handle.read().splitlines(), start=1):
            if line.strip() and not line.startswith('#'):
                yield number, line


try:
    secret = json.loads(sys.stdin.read())
except ValueError:
    stop(f'{secret_id} is not valid JSON; no env file written')
if not isinstance(secret, dict):
    stop(f'{secret_id} is not a JSON object; no env file written')

services = sorted(name[:-len('.keys')] for name in os.listdir(keys_dir) if name.endswith('.keys'))
if not services:
    stop(f'no .keys files in {keys_dir}')

problems, rendered = [], {}
for service in services:
    lines, seen = [], set()
    keys_path = os.path.join(keys_dir, f'{service}.keys')
    for number, line in content_lines(keys_path):
        match = KEYS_LINE.match(line)
        if not match:
            problems.append(f'{service}.keys line {number} is not NAME or "NAME from KEY"')
            continue
        name, key = match.group(1), match.group(2) or match.group(1)
        if name in seen:
            problems.append(f'{service}: {name} is listed twice')
        seen.add(name)
        value = secret.get(key)
        if key not in secret:
            problems.append(f'{service}: {key} is missing from {secret_id}')
        elif not isinstance(value, str):
            problems.append(f'{service}: {key} is not a string in {secret_id}')
        elif value == '':
            problems.append(f'{service}: {key} is empty in {secret_id}')
        elif any(char in value for char in '\r\n\0'):
            problems.append(f'{service}: {key} contains a line break or NUL in {secret_id}')
        else:
            lines.append(f'{name}={value}')
    secret_count = len(lines)
    public_path = os.path.join(keys_dir, f'{service}.public.env')
    if os.path.exists(public_path):
        for number, line in content_lines(public_path):
            name = line.split('=', 1)[0]
            if '=' not in line or not NAME.match(name):
                problems.append(f'{service}.public.env line {number} is not NAME=VALUE')
            elif name in seen:
                problems.append(f'{service}: {name} is set twice (keys and public values)')
            else:
                seen.add(name)
                lines.append(line)
    rendered[service] = (lines, secret_count)

if problems:
    for problem in problems:
        print(f'render-env: {problem}', file=sys.stderr)
    stop('refusing to write any env file')

for service, (lines, secret_count) in rendered.items():
    target = os.path.join(out_dir, f'{service}.env')
    # mkstemp creates the file 0600, so it is never readable by others, even before the rename.
    descriptor, temporary = tempfile.mkstemp(prefix=f'.{service}.', dir=out_dir)
    try:
        with os.fdopen(descriptor, 'w') as handle:
            handle.write('\n'.join(lines) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except BaseException:
        os.unlink(temporary)
        raise
    print(f'wrote {target} ({secret_count} secret, {len(lines) - secret_count} public values)')
PY

printf '%s' "$secret_json" | python3 -c "$RENDER_PY" "$KEYS_DIR" "$OUT_DIR" "$SECRET_ID"

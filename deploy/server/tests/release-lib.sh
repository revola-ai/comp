# shellcheck shell=bash
# Shared setup of deploy/server/tests/release*.test.sh (sourced after tests/lib.sh, never run).
# One sandbox plays both machines. The laptop runs deploy/server/release.sh; the fake aws
# (tests/fake_aws.py) runs each SSM command at once, locally, with /bin/sh and
# COMP_ROOT=$SERVER (the server's /opt/comp, whose src/ is this repository), as SSM would run
# it as root on the server. docker, git, curl, flock and sleep are fakes on PATH, so nothing
# reaches AWS, GitHub, Docker, Trigger.dev, a database or the internet.

SHA_A=aaaaaaaaaaaa1111111111111111111111111111 # pushed; released before the tests start
SHA_B=bbbbbbbbbbbb2222222222222222222222222222 # pushed; the release under test
SHA_C=cccccccccccc3333333333333333333333333333 # committed but never pushed
SHA_D=dddddddddddd4444444444444444444444444444 # pushed; an older release
# shellcheck disable=SC2034 # used by the tests that source this file
TAG_A="${SHA_A:0:12}" TAG_B="${SHA_B:0:12}" TAG_C="${SHA_C:0:12}" TAG_D="${SHA_D:0:12}"
INSTANCE=i-0fake000000000001
SERVER="$TMP/server"
TUNNEL_REF='cloudflare/cloudflared:<none>' # how `docker image ls` shows a digest-pinned pull
COMPOSE_ARGV="docker compose -f $SERVER/src/deploy/server/compose.yaml"

install_release_fakes() {
  install_fake_aws
  local bin="$TMP/bin" fake
  for fake in docker curl flock; do
    printf '#!/usr/bin/env bash\nexec python3 %q "$@"\n' "$SERVER_DIR/tests/fake_$fake.py" >"$bin/$fake"
  done
  cp -f "$SERVER_DIR/tests/fake_git.sh" "$bin/git"
  chmod 755 "$bin/docker" "$bin/curl" "$bin/flock" "$bin/git"
  export FAKE_DOCKER_LOG="$TMP/docker.log" FAKE_DOCKER_STATE="$TMP/docker-state.json" \
    FAKE_GIT_LOG="$TMP/git.log" FAKE_GIT_HEAD="$TMP/git-head" FAKE_CURL_LOG="$TMP/curl.log" \
    FAKE_SSM_ROOT="$SERVER" FAKE_AWS_SECRET="$TMP/secret.json" \
    FAKE_GIT_COMMITS="$SHA_A $SHA_B $SHA_C $SHA_D" FAKE_GIT_PUSHED="$SHA_A $SHA_B $SHA_D"
  mkdir -p "$TMP/cwd"
}

# reset_server: a provisioned server before any release (a clean checkout, the pinned
# cloudflared image), an account with one running comp-server, the full fake secret, and
# empty call logs; knobs from an earlier case are cleared.
reset_server() {
  rm -rf "$SERVER"
  mkdir -p "$SERVER"
  ln -s "$ROOT" "$SERVER/src"
  write_fixture "$TMP/secret.json"
  printf '{"instances": ["%s"]}\n' "$INSTANCE" >"$FAKE_AWS_STATE"
  printf '{"images": ["%s"], "containers": {}, "migrations": "up-to-date"}\n' "$TUNNEL_REF" \
    >"$FAKE_DOCKER_STATE"
  : >"$FAKE_AWS_LOG"
  : >"$FAKE_DOCKER_LOG"
  : >"$FAKE_GIT_LOG"
  : >"$FAKE_CURL_LOG"
  printf '%s\n' "$SHA_A" >"$FAKE_GIT_HEAD"
  rm -f "$FAKE_GIT_HEAD.pruned"
  unset FAKE_DOCKER_FAIL_UP FAKE_DOCKER_FAIL_BUILD FAKE_DOCKER_FAIL_TRIGGER FAKE_CURL_BAD_TAG \
    FAKE_CURL_NO_ACCESS FAKE_GIT_DIRTY FAKE_SSM_TRUNCATE FAKE_AWS_ACCOUNT FAKE_SSM_END FAKE_GIT_STALE
}

docker_state() { # docker_state <python statements over `s`>: edits the fake docker state
  python3 -c 'import json, sys
path = sys.argv[1]
s = json.load(open(path))
exec(sys.argv[2])
json.dump(s, open(path, "w"), indent=1)' "$FAKE_DOCKER_STATE" "$1"
}

# released <tag>...: each tag was released before (its four images exist and releases.log
# has an ok line for it, oldest first); the last one is serving.
released() {
  local tag
  for tag in "$@"; do
    docker_state "s['images'] += ['comp-api:$tag', 'comp-app:$tag', 'comp-portal:$tag', 'comp-migrate:$tag']"
    printf '2026-10-01T00:00:00Z release %s ok\n' "$tag" >>"$SERVER/releases.log"
  done
  docker_state "s['containers'] = {n: f'comp-{n}:$tag' for n in ('api', 'app', 'portal')}
s['containers']['cloudflared'] = 'docker.io/cloudflare/cloudflared:2026.10.0@sha256:fake'"
}

serving() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["containers"].get("api", "none"))' "$FAKE_DOCKER_STATE"; }

# release_sh <output-file> [args...]: runs release.sh with no terminal and an empty stdin.
release_sh() {
  local output="$1"
  shift
  harness --no-tty --cwd "$TMP/cwd" --out "$output" -- bash "$SERVER_DIR/release.sh" "$@"
}

# release_typed <typed> <output-file> [args...]: runs release.sh with <typed> typed at its terminal.
release_typed() {
  local typed="$1" output="$2"
  shift 2
  harness --typed "$typed" --cwd "$TMP/cwd" --out "$output" -- bash "$SERVER_DIR/release.sh" "$@"
}

container_changes() { grep -E "^TAG=[^ ]+ $COMPOSE_ARGV (up|stop)( |$)" "$FAKE_DOCKER_LOG"; }
ssm_sends() { grep -c '^aws ssm send-command ' "$FAKE_AWS_LOG"; }
last_record() { tail -n 1 "$SERVER/releases.log" | cut -d' ' -f2-; }

# ssm_call <n> <field>: from the n-th send-command (1-based): "timeout" (executionTimeout),
# "args" (the arguments the inline script runs with), "comment" or "delivery".
ssm_call() {
  python3 - "$FAKE_AWS_LOG" "$1" "$2" <<'PY'
import json, shlex, sys
log, n, field = sys.argv[1], int(sys.argv[2]), sys.argv[3]
calls = [shlex.split(line) for line in open(log) if line.startswith('aws ssm send-command ')]
argv = calls[n - 1]
value = lambda flag: argv[argv.index(flag) + 1]
parameters = json.loads(value('--parameters'))
print({'timeout': lambda: parameters['executionTimeout'][0],
       'args': lambda: next(c[len('bash "$script" '):] for c in parameters['commands']
                            if c.startswith('bash "$script" ')),
       'comment': lambda: value('--comment'),
       'delivery': lambda: value('--timeout-seconds')}[field]())
PY
}

# no_secret <label> <files...>: no fake secret value in the files, the aws calls (SSM
# parameters included), the server's logs or their names.
no_secret() {
  local label="$1"
  shift
  check "$label: no secret in the output" bash -c '! grep -q fakesecret "$@"' _ "$@"
  check "$label: no secret in any aws call or SSM parameter" bash -c "! grep -q fakesecret '$FAKE_AWS_LOG'"
  check "$label: no secret in the server logs" bash -c "! grep -rq fakesecret '$SERVER/logs' 2>/dev/null"
  check "$label: no secret in a log name" bash -c "! ls '$SERVER/logs' 2>/dev/null | grep -q fakesecret"
}

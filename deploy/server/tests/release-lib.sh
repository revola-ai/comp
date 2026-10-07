# shellcheck shell=bash
# Shared setup of deploy/server/tests/release*.test.sh (sourced after tests/lib.sh, never run).
# One sandbox plays both machines. The laptop runs deploy/server/release.sh; the fake aws
# (tests/fake_aws.py) runs each SSM command at once, locally, with /bin/sh and
# COMP_ROOT=$SERVER (the server's /opt/comp; src/ holds a copy of deploy/server), as SSM would run
# it as root on the server. docker, git, curl, flock, df, timeout and sleep are fakes on PATH, and
# awk can signal mid-print, so nothing reaches AWS, GitHub, Docker, Trigger.dev, a database or the
# internet.

SHA_A=aaaaaaaaaaaa1111111111111111111111111111 # pushed to the fork; released before the tests start
SHA_B=bbbbbbbbbbbb2222222222222222222222222222 # pushed to the fork; the release under test
SHA_C=cccccccccccc3333333333333333333333333333 # committed but never pushed
SHA_D=dddddddddddd4444444444444444444444444444 # pushed to the fork; an older release
SHA_U=999999999999555555555555555555555555555a # only on upstream (`origin` in Kyle's checkout)
# shellcheck disable=SC2034 # used by the tests that source this file
TAG_A="${SHA_A:0:12}" TAG_B="${SHA_B:0:12}" TAG_C="${SHA_C:0:12}" TAG_D="${SHA_D:0:12}" TAG_U="${SHA_U:0:12}"
INSTANCE=i-0fake000000000001
SERVER="$TMP/server"
TUNNEL_REF='cloudflare/cloudflared:<none>' # how `docker image ls` shows a digest-pinned pull
COMPOSE_ARGV="docker compose -f $SERVER/src/deploy/server/compose.yaml"

install_release_fakes() {
  install_fake_aws
  local bin="$TMP/bin" fake
  [[ -n "${FAKE_REAL_AWK:-}" ]] || export FAKE_REAL_AWK="$(command -v awk)" # before the fake exists
  for fake in docker curl flock; do
    printf '#!/usr/bin/env bash\nexec python3 %q "$@"\n' "$SERVER_DIR/tests/fake_$fake.py" >"$bin/$fake"
  done
  cp -f "$SERVER_DIR/tests/fake_git.sh" "$bin/git"
  # df of / at $FAKE_DF_USE percent (default 40), as `df -P /` and `df -h /` print it
  cat >"$bin/df" <<'SH'
#!/usr/bin/env bash
use="${FAKE_DF_USE:-40}"
if [[ "$1" == -P ]]; then
  printf 'Filesystem     1024-blocks     Used Available Capacity Mounted on\n'
  printf '/dev/nvme0n1p1    52416492 %8d  %8d      %s%% /\n' $((524164 * use)) $((524164 * (100 - use))) "$use"
else
  printf 'Filesystem      Size  Used Avail Use%% Mounted on\n/dev/nvme0n1p1   50G   %dG   %dG  %s%% /\n' \
    $((use / 2)) $(((100 - use) / 2)) "$use"
fi
SH
  # awk, except that with FAKE_AWK_INTERRUPT="<SIG>@<n>" the n-th time release.sh prints a
  # step's output (split_output's program), it sends SIG to the process group mid-print.
  cat >"$bin/awk" <<'SH'
#!/usr/bin/env bash
"$FAKE_REAL_AWK" "$@" || exit
[[ -n "${FAKE_AWK_INTERRUPT:-}" && "$1" == '/^comp-meta-begin$/ { exit } !/^comp-result: / { print }' ]] || exit 0
count=$(($(cat "$FAKE_AWK_COUNT" 2>/dev/null || echo 0) + 1))
echo "$count" >"$FAKE_AWK_COUNT"
[[ "$count" == "${FAKE_AWK_INTERRUPT#*@}" ]] || exit 0
kill -s "${FAKE_AWK_INTERRUPT%@*}" 0
/bin/sleep 5
SH
  # timeout: logs its arguments and runs the command, or with FAKE_TIMEOUT_EXPIRE answers 124
  # (timed out) without running it.
  cat >"$bin/timeout" <<'SH'
#!/usr/bin/env bash
echo "timeout $*" >>"$FAKE_TIMEOUT_LOG"
[[ -z "${FAKE_TIMEOUT_EXPIRE:-}" ]] || exit 124
shift
exec "$@"
SH
  chmod 755 "$bin/docker" "$bin/curl" "$bin/flock" "$bin/git" "$bin/df" "$bin/awk" "$bin/timeout"
  export FAKE_DOCKER_LOG="$TMP/docker.log" FAKE_DOCKER_STATE="$TMP/docker-state.json" \
    FAKE_GIT_LOG="$TMP/git.log" FAKE_GIT_HEAD="$TMP/git-head" FAKE_CURL_LOG="$TMP/curl.log" \
    FAKE_SSM_ROOT="$SERVER" FAKE_AWS_SECRET="$TMP/secret.json" \
    FAKE_AWK_COUNT="$TMP/awk-count" FAKE_TIMEOUT_LOG="$TMP/timeout.log" \
    FAKE_GIT_COMMITS="$SHA_A $SHA_B $SHA_C $SHA_D $SHA_U" FAKE_GIT_PUSHED="$SHA_A $SHA_B $SHA_D" \
    FAKE_GIT_UPSTREAM="$SHA_U"
  mkdir -p "$TMP/cwd"
}

# reset_server: a provisioned server before any release (a clean checkout, the pinned
# cloudflared image), an account with one running comp-server, the full fake secret, and
# empty call logs; knobs from an earlier case are cleared.
reset_server() {
  rm -rf "$SERVER"
  mkdir -p "$SERVER/src/deploy"
  cp -Rp "$SERVER_DIR" "$SERVER/src/deploy/"
  write_fixture "$TMP/secret.json"
  printf '{"instances": ["%s"]}\n' "$INSTANCE" >"$FAKE_AWS_STATE"
  printf '{"images": ["%s"], "containers": {}, "migrations": "up-to-date"}\n' "$TUNNEL_REF" \
    >"$FAKE_DOCKER_STATE"
  : >"$FAKE_AWS_LOG"
  : >"$FAKE_DOCKER_LOG"
  : >"$FAKE_GIT_LOG"
  : >"$FAKE_CURL_LOG"
  printf '%s\n' "$SHA_A" >"$FAKE_GIT_HEAD"
  rm -f "$FAKE_GIT_HEAD.pruned" "$FAKE_CURL_LOG.interrupted" "$FAKE_AWK_COUNT" "$FAKE_TIMEOUT_LOG"
  unset FAKE_DOCKER_FAIL_UP FAKE_DOCKER_FAIL_BUILD FAKE_DOCKER_FAIL_TRIGGER FAKE_CURL_BAD_TAG \
    FAKE_CURL_NO_ACCESS FAKE_GIT_DIRTY FAKE_SSM_TRUNCATE FAKE_AWS_ACCOUNT FAKE_SSM_END FAKE_GIT_STALE \
    FAKE_AWS_INTERRUPT FAKE_SSM_CANCEL FAKE_CURL_INTERRUPT FAKE_DF_USE FAKE_DOCKER_FAIL_PRUNE \
    FAKE_AWK_INTERRUPT FAKE_TIMEOUT_EXPIRE
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

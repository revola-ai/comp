# shellcheck shell=bash
# Server-side helpers of deploy/server/release.sh (sourced, never run on its own). It runs as
# root on the server: deploy/server/release.sh sends this file's text inline, ahead of
# on-server/entry.sh or on-server/status.sh, as one SSM command (so those two work on a server
# whose checkout predates them), and the scripts in on-server/ source it from the checkout. So
# it defines names and nothing else, and never depends on where it is.
#
# COMP_ROOT is /opt/comp on the server (the tests point it at a sandbox).
COMP_ROOT="${COMP_ROOT:-/opt/comp}"
COMP_SRC="$COMP_ROOT/src"            # the checkout user-data.sh cloned
COMP_ENV_DIR="$COMP_ROOT/env"        # render-env.sh output, read by compose
COMP_LOGS="$COMP_ROOT/logs"          # one root-only log per release.sh step
RELEASES_LOG="$COMP_ROOT/releases.log"
RELEASE_LOCK="$COMP_ROOT/release.lock"
RELEASE_LEASE="$COMP_ROOT/release.lease"
LEASE_SECONDS=1200 # how long a release waits between its steps for the laptop's smoke checks
# <utc>-<step>[-<sha12>]: the name of a step's log and of a run.
STEP_NAME_RE='^[0-9]{8}T[0-9]{6}Z-[a-z]+(-[a-z]+)?(-[0-9a-f]{12})?$'
# A run: the name of its first step and 8 random hex characters, unique per operator.
RUN_ID_RE='^[0-9]{8}T[0-9]{6}Z-[a-z]+(-[0-9a-f]{12})?-[0-9a-f]{8}$'
TAG_RE='^[0-9a-f]{12}$'
STACK_IMAGES=(api app portal)

result() { printf 'comp-result: %s\n' "$*"; } # a line release.sh reads back from the output

utc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# record <action> <sha12> <outcome>: one line per attempt in releases.log.
record() { printf '%s %s %s %s\n' "$(utc_now)" "$1" "$2" "$3" >>"$RELEASES_LOG"; }

# serving_stack: the serving history, top (the current tag) first. Read from the ok lines of
# releases.log in order: `release X ok` pushes X (unless X is on top already), `rollback X ok`
# pops until X is on top (pushing X when it is not in the stack). So a default rollback goes
# to the entry below the top, and rolling back twice walks further back, never forward.
serving_stack() {
  [[ -f "$RELEASES_LOG" ]] || return 0
  awk '$4 != "ok" || $3 !~ /^[0-9a-f]+$/ { next }
    $2 == "release" { if (n == 0 || stack[n - 1] != $3) stack[n++] = $3 }
    $2 == "rollback" {
      for (i = n - 1; i >= 0 && stack[i] != $3; i--) ;
      if (i < 0) stack[n++] = $3; else n = i + 1
    }
    END { for (i = n - 1; i >= 0; i--) print stack[i] }' "$RELEASES_LOG"
}
current_tag() { serving_stack | sed -n 1p; }
previous_tag() { serving_stack | sed -n 2p; }

# recent_ok_tags: the tags of ok release and rollback lines, newest first, each once (prune
# keeps the first four: the current tag, which is always the newest, and 3 others).
recent_ok_tags() {
  [[ -f "$RELEASES_LOG" ]] || return 0
  awk '($2 == "release" || $2 == "rollback") && $4 == "ok" && $3 ~ /^[0-9a-f]+$/ { tags[n++] = $3 }
    END { for (i = n - 1; i >= 0; i--) if (!seen[tags[i]]++) print tags[i] }' "$RELEASES_LOG"
}

# lease_read: LEASE_HOLDER (a run id), LEASE_EXPIRES (epoch seconds) and LEASE_WHAT from the
# lease a release holds between its steps; lease_live is true while it has not expired.
lease_read() {
  LEASE_HOLDER="" LEASE_EXPIRES=0 LEASE_WHAT=""
  [[ -s "$RELEASE_LEASE" ]] || return 0
  read -r LEASE_HOLDER LEASE_EXPIRES LEASE_WHAT <"$RELEASE_LEASE" || true
  [[ "$LEASE_EXPIRES" =~ ^[0-9]+$ ]] || LEASE_EXPIRES=0
}
lease_live() {
  lease_read
  [[ -n "$LEASE_HOLDER" ]] && ((LEASE_EXPIRES > $(date +%s)))
}
lease_take() { # lease_take <run-id> <what>
  printf '%s %s %s\n' "$1" "$(($(date +%s) + LEASE_SECONDS))" "$2" >"$RELEASE_LEASE"
}
lease_drop() { rm -f "$RELEASE_LEASE"; }

# meta <exit status> [log]: ends the output release.sh reads; everything before
# comp-meta-begin is for the operator, everything after for release.sh.
meta() {
  echo comp-meta-begin
  [[ -z "${2:-}" ]] || echo "comp-log: $2"
  [[ -z "${2:-}" || ! -f "$2" ]] || grep -a '^comp-result: ' "$2" || true
  echo "comp-end: $1"
}

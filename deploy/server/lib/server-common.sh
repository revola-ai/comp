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
TAG_RE='^[0-9a-f]{12}$'
STACK_IMAGES=(api app portal)

result() { printf 'comp-result: %s\n' "$*"; } # a line release.sh reads back from the output

utc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# record <action> <sha12> <outcome>: one line per attempt in releases.log.
record() { printf '%s %s %s %s\n' "$(utc_now)" "$1" "$2" "$3" >>"$RELEASES_LOG"; }

# ok_tags: the tags of ok release and rollback lines, newest first, each once. The first is
# the current tag; the second the one before it.
ok_tags() {
  [[ -f "$RELEASES_LOG" ]] || return 0
  awk '($2 == "release" || $2 == "rollback") && $4 == "ok" && $3 ~ /^[0-9a-f]+$/ { tags[n++] = $3 }
    END { for (i = n - 1; i >= 0; i--) if (!seen[tags[i]]++) print tags[i] }' "$RELEASES_LOG"
}
current_tag() { ok_tags | sed -n 1p; }
previous_tag() { ok_tags | sed -n 2p; }

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

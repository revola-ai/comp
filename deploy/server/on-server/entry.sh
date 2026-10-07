#!/usr/bin/env bash
# The start of every server-side step of deploy/server/release.sh that may change something.
# release.sh sends lib/server-common.sh and this file as the text of one SSM command, so it runs
# as root on any server, even one whose checkout predates it:
#
#   entry.sh <log-name> <run-id> <new|own> <sha|-> <script> [args...]
#
# 1. Takes the server lock (flock on /opt/comp/release.lock, never waiting), so release,
#    rollback, migrate, trigger and prune run one at a time; a second caller fails at once.
# 2. Checks the lease a release keeps between its steps (while the laptop runs the smoke
#    checks): "new" refuses while another run holds it, "own" needs it to be <run-id>'s.
# 3. Writes everything after this to /opt/comp/logs/<log-name> (0600 in a 0700 directory).
# 4. With a sha: fetches every branch of the fork (by its URL, COMP_REPO_URL) into
#    /opt/comp/src, refuses local changes, and checks the sha out detached, under umask 022
#    (the public source is not secret, and the images' node user must read what BuildKit
#    copies); then makes every file and directory of the checkout (not .git, never through a
#    symlink) world-readable, which also heals a tree an earlier run checked out under umask
#    077. Logs, env files, lock and lease stay 077.
# 5. Runs deploy/server/on-server/<script>.sh [args...] from the checkout, with COMP_RUN_ID.
# 6. Prints the end of the log (200 lines, at most 20000 bytes: SSM keeps 24000 characters),
#    then the lines release.sh reads (see `meta`), and exits with the script's status.
# Exit 75: the lock or the lease belongs to another run; nothing was done. Whenever a step
# stops before changing anything, its meta block says so: comp-result: changed=no.
if [[ "$(type -t meta)" != function ]]; then
  # shellcheck source=deploy/server/lib/server-common.sh
  source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-common.sh"
fi
set -uo pipefail
umask 077

refuse() { # refuse <status> <message>: before the log exists, so before any change
  echo "release.sh on the server: $2"
  echo comp-meta-begin
  result "changed=no"
  echo "comp-end: $1"
  exit "$1"
}

if (($# < 5)); then
  refuse 2 "usage: entry.sh <log-name> <run-id> <new|own> <sha|-> <script> [args...]"
fi
log_name="$1" run_id="$2" lease_mode="$3" sha="$4" script="$5"
shift 5
[[ "$log_name" == *.log && "${log_name%.log}" =~ $STEP_NAME_RE ]] || refuse 2 "bad log name '$log_name'"
[[ "$run_id" =~ $RUN_ID_RE ]] || refuse 2 "bad run id '$run_id'"
[[ "$lease_mode" == new || "$lease_mode" == own ]] || refuse 2 "bad lease mode '$lease_mode'"
[[ "$sha" == - || "$sha" =~ ^[0-9a-f]{40}$ ]] || refuse 2 "bad sha '$sha'"
[[ "$script" =~ ^[a-z]+$ ]] || refuse 2 "bad script name '$script'"
log="$COMP_LOGS/$log_name"

if ! mkdir -p "$COMP_LOGS" || ! chmod 700 "$COMP_LOGS"; then
  refuse 1 "cannot create $COMP_LOGS"
fi
exec 9>>"$RELEASE_LOCK"
if ! flock -n 9; then
  refuse 75 "another release.sh step (release, rollback, migrate, trigger or prune) is running on the server; try again when it ends (deploy/server/release.sh status)"
fi
if lease_live; then
  if [[ "$lease_mode" != own || "$LEASE_HOLDER" != "$run_id" ]]; then
    refuse 75 "$LEASE_WHAT (run $LEASE_HOLDER) is between its steps for up to $((LEASE_EXPIRES - $(date +%s))) more seconds; try again after it (deploy/server/release.sh status)"
  fi
elif [[ "$lease_mode" == own ]]; then
  refuse 75 "run $run_id no longer holds the server (its lease expired); this step did nothing; check deploy/server/release.sh status"
fi
[[ ! -e "$log" ]] || refuse 1 "$log exists already; rerun the command"

checkout() { # checkout <sha>: the full checkout at <sha>, or a refusal (run in a subshell)
  local changes head
  umask 022
  git -C "$COMP_SRC" fetch --quiet "$COMP_REPO_URL" '+refs/heads/*:refs/remotes/origin/*' || {
    echo "git fetch in $COMP_SRC failed"
    return 1
  }
  changes="$(git -C "$COMP_SRC" status --porcelain)" || return 1
  if [[ -n "$changes" ]]; then
    printf 'refusing: %s has local changes (commit or discard them by hand):\n%s\n' "$COMP_SRC" "$changes"
    return 1
  fi
  git -C "$COMP_SRC" checkout --quiet --detach "$1" || return 1
  head="$(git -C "$COMP_SRC" rev-parse HEAD)" || return 1
  [[ "$head" == "$1" ]] || { echo "the checkout is at $head, not $1"; return 1; }
  find "$COMP_SRC" -path "$COMP_SRC/.git" -prune -o ! -type l -exec chmod a+rX {} + || {
    echo "could not make $COMP_SRC world-readable"
    return 1
  }
  echo "== checked out $1 in $COMP_SRC"
}

run_step() {
  echo "== $script $* (run $run_id, $(utc_now))"
  if [[ "$sha" != - ]] && ! (checkout "$sha"); then
    result "changed=no"
    return 1
  fi
  local path="$COMP_SRC/deploy/server/on-server/$script.sh"
  if [[ ! -f "$path" ]]; then
    echo "$COMP_SRC has no deploy/server/on-server/$script.sh; release a commit that has it first"
    result "changed=no"
    return 1
  fi
  cd "$COMP_SRC" && COMP_RUN_ID="$run_id" bash "$path" "$@"
}

status=0
run_step "$@" >"$log" 2>&1 </dev/null || status=$?
tail -n 200 "$log" | tail -c 20000
[[ -z "$(tail -c 1 "$log")" ]] || echo # so comp-meta-begin starts a line
meta "$status" "$log"
exit "$status"

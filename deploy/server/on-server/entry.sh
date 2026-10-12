#!/usr/bin/env bash
# The start of every server-side step of deploy/server/release.sh that may change something.
# release.sh sends lib/server-common.sh and this file as the text of one SSM command, so it runs
# as root on any server, even one whose checkout predates it:
#
#   entry.sh <log-name> <run-id> <new|own> <sha|-> <script> [args...]
#
# 1. Takes the server lock (flock on /opt/comp/release.lock), so release, rollback, migrate,
#    trigger, prune and unlock run one at a time: a "new" step never waits (a second caller fails
#    at once); an "own" step (finish, revert, unlock of a run) waits up to OWN_LOCK_SECONDS,
#    because the laptop sends it once, and between a run's steps the lock may be held briefly by
#    the reboot check or a security update that takes it only to skip under the lease.
#    dnf-automatic and the reboot check (user-data.sh) wait up to an hour for it.
# 2. Checks the lease a release keeps between its steps (while the laptop runs the smoke
#    checks): "new" refuses while another run holds it, "own" needs it to be <run-id>'s.
# 3. Writes everything after this to /opt/comp/logs/<log-name> (0600 in a 0700 directory).
# 4. With a sha, the step runs from its own checkout of it, /opt/comp/work/<sha12> (a git
#    worktree of /opt/comp/src, removed after the step), so /opt/comp/src itself stays at the
#    serving release (a release's finish moves it). A "new" step first fetches every branch of
#    the fork (by its URL, COMP_REPO_URL), refuses a sha its RELEASE_BRANCH lacks (release.sh
#    checked it too; this holds when the step is run some other way) and refuses local changes
#    in /opt/comp/src; an "own" step (finish, revert) reuses what its run fetched. The worktree
#    is written under umask 022 (the public source is not secret, and the images' node user
#    must read what BuildKit copies), then made world-readable (readable_tree). Logs, env
#    files, snapshots, lock and lease stay 077. Without a sha, the step runs from /opt/comp/src:
#    the scripts of the serving release.
# 5. Runs deploy/server/on-server/<script>.sh [args...] from that checkout, with COMP_RUN_ID and
#    COMP_SHA (the full sha, or empty).
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
OWN_LOCK_SECONDS=120 # inside the half of the lease the smoke checks leave (lib/release-flow.sh)

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
lock_wait=(-n) waited=""
[[ "$lease_mode" != own ]] || lock_wait=(-w "$OWN_LOCK_SECONDS") waited=" (waited $OWN_LOCK_SECONDS seconds for the server lock)"
if ! flock "${lock_wait[@]}" 9; then
  refuse 75 "another release.sh step (release, rollback, migrate, trigger, prune or unlock), the daily security update or the reboot check is running on the server$waited; try again when it ends (deploy/server/release.sh status)"
fi
if lease_live; then
  if [[ "$lease_mode" != own || "$LEASE_HOLDER" != "$run_id" ]]; then
    refuse 75 "$LEASE_WHAT (run $LEASE_HOLDER) is between its steps for up to $((LEASE_EXPIRES - $(date +%s))) more seconds; try again after it (deploy/server/release.sh status)"
  fi
elif [[ "$lease_mode" == own ]]; then
  refuse 75 "run $run_id no longer holds the server (its lease expired); this step did nothing; check deploy/server/release.sh status"
fi
[[ ! -e "$log" ]] || refuse 1 "$log exists already; rerun the command"

fetch_checked() { # fetch_checked <sha>: a new step's fetch and checks, or a refusal
  local changes
  git -C "$COMP_SRC" fetch --quiet "$COMP_REPO_URL" '+refs/heads/*:refs/remotes/origin/*' || {
    echo "git fetch in $COMP_SRC failed"
    return 1
  }
  if ! git -C "$COMP_SRC" merge-base --is-ancestor "$1" "refs/remotes/origin/$RELEASE_BRANCH"; then
    echo "refusing: $1 is not on $RELEASE_BRANCH of $COMP_REPO_URL (releases come only from that branch); merge it there first"
    return 1
  fi
  changes="$(git -C "$COMP_SRC" status --porcelain)" || return 1
  if [[ -n "$changes" ]]; then
    printf 'refusing: %s has local changes (commit or discard them by hand):\n%s\n' "$COMP_SRC" "$changes"
    return 1
  fi
}

remove_worktrees() { # the step checkouts in /opt/comp/work (this step's, or those of steps cut short)
  local tree
  for tree in "$COMP_WORK"/*; do
    [[ -e "$tree" ]] || continue
    git -C "$COMP_SRC" worktree remove --force "$tree" >/dev/null 2>&1 || rm -rf "$tree"
  done
  git -C "$COMP_SRC" worktree prune
}

step_checkout() { # step_checkout <sha> <dir>: the step's checkout of <sha>, or a refusal (subshell)
  local head
  umask 022
  [[ "$lease_mode" == own ]] || fetch_checked "$1" || return 1
  remove_worktrees
  if ! mkdir -p "$COMP_WORK" || ! git -C "$COMP_SRC" worktree add --quiet --detach "$2" "$1"; then
    echo "could not check $1 out in $2"
    return 1
  fi
  head="$(git -C "$2" rev-parse HEAD)" || return 1
  [[ "$head" == "$1" ]] || { echo "the checkout in $2 is at $head, not $1"; return 1; }
  readable_tree "$2" || return 1
  echo "== checked out $1 in $2"
}

run_step() {
  echo "== $script $* (run $run_id, $(utc_now))"
  local tree="$COMP_SRC"
  if [[ "$sha" != - ]]; then
    tree="$COMP_WORK/${sha:0:12}"
    if ! (step_checkout "$sha" "$tree"); then
      result "changed=no"
      return 1
    fi
  fi
  local path="$tree/deploy/server/on-server/$script.sh"
  if [[ ! -f "$path" ]]; then
    echo "$tree has no deploy/server/on-server/$script.sh; release a commit that has it first"
    result "changed=no"
    return 1
  fi
  (cd "$tree" && COMP_RUN_ID="$run_id" COMP_SHA="${sha#-}" bash "$path" "$@")
}

status=0
run_step "$@" >"$log" 2>&1 </dev/null || status=$?
[[ "$sha" == - ]] || remove_worktrees >>"$log" 2>&1 </dev/null
tail -n 200 "$log" | tail -c 20000
[[ -z "$(tail -c 1 "$log")" ]] || echo # so comp-meta-begin starts a line
meta "$status" "$log"
exit "$status"

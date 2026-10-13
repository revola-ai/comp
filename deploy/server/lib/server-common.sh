# shellcheck shell=bash
# Server-side helpers of deploy/server/release.sh (sourced, never run on its own). It runs as
# root on the server: deploy/server/release.sh sends this file's text inline, ahead of
# on-server/entry.sh or on-server/status.sh, as one SSM command (so those two work on a server
# whose checkout predates them), and the scripts in on-server/ source it from the checkout. So
# it defines names and nothing else, and never depends on where it is.
#
# COMP_REPO_URL is the fork the server builds from: release.sh (which sources this file for it)
# requires a SHA to be on its RELEASE_BRANCH, entry.sh fetches from it and checks that branch
# again, and user-data.sh clones it (cloud-init runs that file alone, so it repeats the URL;
# tests/user-data.test.sh checks it).
COMP_REPO_URL=https://github.com/revola-ai/comp
RELEASE_BRANCH=revola/self-host # releases, migrations and Trigger.dev deploys come only from it
# COMP_ROOT is /opt/comp on the server (the tests point it at a sandbox).
COMP_ROOT="${COMP_ROOT:-/opt/comp}"
COMP_SRC="$COMP_ROOT/src"            # the checkout of the serving release (user-data.sh cloned it)
COMP_WORK="$COMP_ROOT/work"          # a step with a SHA runs from a worktree of it here, removed after
COMP_RELEASES="$COMP_ROOT/releases"  # a snapshot per released tag: sha, compose.yaml, env/ (0700/0600)
COMP_STAGE="$COMP_ROOT/stage"        # a run's rendered configuration, until it is kept or dropped
COMP_LOGS="$COMP_ROOT/logs"          # one root-only log per release.sh step
RELEASES_LOG="$COMP_ROOT/releases.log"
RELEASE_LOCK="$COMP_ROOT/release.lock"
RELEASE_LEASE="$COMP_ROOT/release.lease"
LEASE_SECONDS=1200 # how long a release waits between its steps for the laptop's smoke checks
DISK_PRUNE_PERCENT=70 # above this use of /, a release prunes after itself and status warns
# <utc>-<step>[-<sha12>]: the name of a step's log and of a run.
STEP_NAME_RE='^[0-9]{8}T[0-9]{6}Z-[a-z]+(-[a-z]+)?(-[0-9a-f]{12})?$'
# A run: the name of its first step and 8 random hex characters, unique per operator.
RUN_ID_RE='^[0-9]{8}T[0-9]{6}Z-[a-z]+(-[0-9a-f]{12})?-[0-9a-f]{8}$'
TAG_RE='^[0-9a-f]{12}$'
# The operator of a step: the caller ARN of the laptop's AWS credentials (an IAM user or role, or
# an assumed-role session), which release.sh reads with sts get-caller-identity and entry.sh gets
# as an argument. It is not a secret (it names a principal and its session, nothing that grants
# access), so it may sit in a command line, a log and releases.log; this pattern keeps it to one
# word of plain characters, so it can never split a releases.log line or reach a shell as code.
OPERATOR_RE='^arn:aws:(iam|sts)::[0-9]{12}:[A-Za-z0-9+=,.@_/:-]+$'
STACK_IMAGES=(api app portal)

result() { printf 'comp-result: %s\n' "$*"; } # a line release.sh reads back from the output

utc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# root_use_percent: the use of / in percent, digits only (df -P prints "73%").
root_use_percent() { df -P / | awk 'NR == 2 { sub(/%$/, "", $5); print $5 }'; }

# record <action> <sha12> <outcome>: one line per attempt in releases.log, "<utc> <action>
# <sha12> <outcome> <operator>", the operator COMP_OPERATOR (entry.sh exports it), or "-" without
# a valid one (lines from before the field have four fields; every reader uses the first four).
# Fails, saying so, when the line could not be written (a full disk, a read-only file). Every
# state write here reports its own failure, so a caller only decides what it means for its step.
record() {
  local operator="${COMP_OPERATOR:--}"
  [[ "$operator" =~ $OPERATOR_RE ]] || operator=-
  printf '%s %s %s %s %s\n' "$(utc_now)" "$1" "$2" "$3" "$operator" 2>/dev/null >>"$RELEASES_LOG" && return 0
  echo "COULD NOT RECORD '$1 $2 $3' in $RELEASES_LOG (a full disk or a read-only file?)"
  return 1
}

# readable_tree <dir>: every file and directory of a checkout (not .git, never through a
# symlink) world-readable, so the images' node user can read what BuildKit copies; it also heals
# a tree an earlier run checked out under umask 077.
readable_tree() {
  find "$1" -path "$1/.git" -prune -o ! -type l -exec chmod a+rX {} + && return 0
  echo "could not make $1 world-readable"
  return 1
}

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

# branch_of <sha>: "on" when RELEASE_BRANCH (as /opt/comp/src last fetched it) contains <sha>,
# "off" when it does not (a release of <sha> would be refused), "unknown" when git cannot tell.
branch_of() {
  local status=0
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || { echo unknown; return 0; }
  git -C "$COMP_SRC" merge-base --is-ancestor "$1" "refs/remotes/origin/$RELEASE_BRANCH" 2>/dev/null || status=$?
  case "$status" in 0) echo on ;; 1) echo off ;; *) echo unknown ;; esac
}

# src_way_out <tag> <on|off|unknown>: how /opt/comp/src gets to the serving <tag> after a finish
# could not move it there: releasing <tag> again or any newer commit of RELEASE_BRANCH moves it;
# once <tag> is off RELEASE_BRANCH ("off", branch_of), only the newer commit, as both release.sh
# and entry.sh refuse <tag> itself.
src_way_out() {
  if [[ "$2" == off ]]; then
    echo "release any newer commit of $RELEASE_BRANCH ($1 is no longer on it, so releasing $1 again is refused)"
  else
    echo "release $1 again, or any newer commit of $RELEASE_BRANCH"
  fi
}

# src_lag_way_out <tag>: src_way_out for the serving <tag>, its commit read from its snapshot.
src_lag_way_out() {
  local sha=""
  read -r sha <"$COMP_RELEASES/$1/sha" 2>/dev/null || true
  src_way_out "$1" "$(branch_of "$sha")"
}

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
  printf '%s %s %s\n' "$1" "$(($(date +%s) + LEASE_SECONDS))" "$2" 2>/dev/null >"$RELEASE_LEASE" && return 0
  echo "COULD NOT WRITE the lease $RELEASE_LEASE (a full disk?)"
  return 1
}
lease_drop() {
  rm -f "$RELEASE_LEASE" 2>/dev/null && return 0
  echo "COULD NOT REMOVE the lease $RELEASE_LEASE"
  return 1
}

# meta <exit status> [log]: ends the output release.sh reads; everything before
# comp-meta-begin is for the operator, everything after for release.sh.
meta() {
  echo comp-meta-begin
  [[ -z "${2:-}" ]] || echo "comp-log: $2"
  [[ -z "${2:-}" || ! -f "$2" ]] || grep -a '^comp-result: ' "$2" || true
  echo "comp-end: $1"
}

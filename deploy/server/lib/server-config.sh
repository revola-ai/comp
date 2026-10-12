# shellcheck shell=bash
# The configuration a tag runs with, for the scripts in deploy/server/on-server/ (sourced after
# lib/server-common.sh and lib/server-stack.sh, never run on its own). Runs as root on the server.
#
# A configuration is a directory (0700) holding sha (the full 40-character SHA of the commit),
# compose.yaml (that commit's) and env/<service>.env (rendered from comp/production/config by that
# commit's render-env.sh), its files 0600. A release renders one into $COMP_STAGE/<run-id>
# (stage_config), checks the migrations and brings the stack up with it, and only its finish
# keeps it as the tag's snapshot, $COMP_RELEASES/<tag> (keep_snapshot). A refused or failed
# release drops it, so the snapshots, the running containers and /opt/comp/src stay as they were.
# Bringing a tag back (a revert, a failed up, a rollback) uses that tag's own snapshot: the env
# files and compose.yaml it was released and verified with, never newer ones; only when that
# snapshot fails its health checks does a revert render it again (fresh_config). compose.yaml finds
# its env files through COMP_ENV_DIR; its build sections (never used here: the stack runs
# --no-build) resolve against the directory two levels above it, which exists.

use_config() { # use_config <dir>: compose runs with <dir>/compose.yaml and <dir>/env from now on
  COMPOSE_FILE="$1/compose.yaml" COMP_ENV_DIR="$1/env"
}

# stage_config <dir> <checkout> <sha>: renders the env files of <checkout> (of commit <sha>) into
# <dir>/env and keeps its compose.yaml and <sha> beside them; changes nothing live. Fails, saying
# why. A step stages its own checkout ($REPO, $COMP_SHA from entry.sh).
stage_config() {
  local dir="$1" checkout="$2" sha="$3"
  if ! rm -rf "$dir" || ! mkdir -p "$dir" || ! chmod 700 "$dir"; then
    echo "could not create $dir"
    return 1
  fi
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "no full SHA for $checkout"; return 1; }
  render_env "$dir/env" "$checkout" || return 1
  if ! (umask 077 && cp "$checkout/deploy/server/compose.yaml" "$dir/compose.yaml" && printf '%s\n' "$sha" >"$dir/sha"); then
    echo "could not write $dir/compose.yaml and $dir/sha"
    return 1
  fi
}

# snapshot_of <tag>: prints the snapshot directory of <tag>; fails when it is missing or
# incomplete (pruned, or removed by hand).
snapshot_of() {
  local dir="$COMP_RELEASES/$1" sha=""
  [[ -f "$dir/sha" && -f "$dir/compose.yaml" && -d "$dir/env" ]] || return 1
  read -r sha <"$dir/sha" || true
  [[ "$sha" =~ ^[0-9a-f]{40}$ && "${sha:0:12}" == "$1" ]] || return 1
  printf '%s\n' "$dir"
}

# keep_snapshot <dir> <tag>: makes the configuration <dir> the snapshot of <tag>, replacing the
# one an earlier release of the same tag kept (set aside until the new one is in place).
keep_snapshot() {
  local target="$COMP_RELEASES/$2" old="$COMP_RELEASES/.replaced-$2"
  if ! mkdir -p "$COMP_RELEASES" || ! chmod 700 "$COMP_RELEASES" || ! rm -rf "$old"; then
    echo "could not prepare $COMP_RELEASES"
    return 1
  fi
  if [[ -e "$target" ]] && ! mv -f "$target" "$old"; then
    echo "could not set $target aside"
    return 1
  fi
  if ! mv -f "$1" "$target"; then
    echo "could not keep $1 as $target"
    [[ ! -e "$old" ]] || mv -f "$old" "$target"
    return 1
  fi
  rm -rf "$old"
  echo "== kept the configuration of $2 as its snapshot ($target)"
}

# fresh_config <tag> <snapshot> <dir>: renders <tag>'s configuration again into <dir>, for a
# revert whose snapshot of <tag> no longer comes up: the commit the snapshot records, checked out
# from its pin (refs/comp/releases/<tag>) in a worktree removed afterwards, with that commit's
# render-env.sh and compose.yaml, and the current comp/production/config. Fails, saying why.
fresh_config() {
  local tag="$1" sha="" tree="$COMP_WORK/fresh-$1" status=0
  read -r sha <"$2/sha" || true
  git -C "$COMP_SRC" worktree remove --force "$tree" >/dev/null 2>&1 || rm -rf "$tree" # a stopped step's
  git -C "$COMP_SRC" worktree prune
  if ! mkdir -p "$COMP_WORK" || ! git -C "$COMP_SRC" worktree add --quiet --detach "$tree" "refs/comp/releases/$tag" ||
    [[ "$(git -C "$tree" rev-parse HEAD 2>/dev/null)" != "$sha" ]]; then
    echo "could not check out $tag's commit ${sha:-?} from refs/comp/releases/$tag in $tree"
    status=1
  else
    stage_config "$3" "$tree" "$sha" || status=1
  fi
  git -C "$COMP_SRC" worktree remove --force "$tree" >/dev/null 2>&1 || rm -rf "$tree"
  return "$status"
}

# pin_release <tag> <sha>: refs/comp/releases/<tag> in /opt/comp/src points at the released
# commit, so git gc never drops it, even once no branch holds it (revola/self-host force-pushed
# past it): a rollback or a revert can always check it out. prune removes it with the snapshot.
pin_release() {
  git -C "$COMP_SRC" update-ref "refs/comp/releases/$1" "$2" && return 0
  echo "could not pin $2 as refs/comp/releases/$1 in $COMP_SRC"
  return 1
}

# serve_checkout <sha>: moves /opt/comp/src to <sha> (under umask 022, world-readable), so the
# steps without a SHA (rollback, prune, unlock) run the scripts of the release that serves. Git
# writes a changed file as a new file, so a script running from /opt/comp/src reads on unharmed.
serve_checkout() {
  if (umask 022 && git -C "$COMP_SRC" checkout --quiet --detach "$1" && readable_tree "$COMP_SRC"); then
    echo "== $COMP_SRC is at $1, the serving release"
    return 0
  fi
  echo "WARNING: could not check $1 out in $COMP_SRC (above): the steps without a SHA (rollback, prune, unlock) run the scripts of the release before it until ${1:0:12} is released again."
  return 1
}

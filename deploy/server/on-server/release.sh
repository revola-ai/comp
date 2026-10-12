#!/usr/bin/env bash
# Server side of `deploy/server/release.sh release` and `rollback`, run as root by
# on-server/entry.sh (which holds the server lock): a release's steps from a worktree of its SHA,
# a rollback's and unlock from /opt/comp/src, the serving release's checkout:
#
#   release.sh up release <sha12>     after the build step (on-server/build.sh): refuses when
#                                     an image of the tag is missing, renders the run's
#                                     configuration into /opt/comp/stage (lib/server-config.sh),
#                                     refuses pending or failed migrations, then compose up --wait
#                                     with it
#   release.sh up rollback <sha12>    compose up --wait with the tag's snapshot, without build or
#                                     migration check; refuses a tag whose three images or whose
#                                     snapshot are gone, or the serving one
#   release.sh finish <action> <sha12>  after the laptop's smoke checks passed: keeps a release's
#                                     configuration as the tag's snapshot, records ok and says so
#                                     (recorded=ok), moves /opt/comp/src to the tag's SHA; after a
#                                     release, then prunes old images when / is over 70% used, for
#                                     at most 600 s (prune=ok|failed|timed-out), which never fails
#                                     the step
#   release.sh revert <action> <sha12>  after they failed: brings the previous tag back with its
#                                     own snapshot
#   release.sh unlock <action> <sha12>  `release.sh unlock` on the laptop: removes the lease of
#                                     a run whose laptop stopped (entry.sh checked it is that
#                                     run's and holds the lock, so no step runs); records it
#
# "up" that succeeds leaves the lease (COMP_RUN_ID) for finish or revert; a failed "up" brings
# the previous ok tag back by itself. Before the containers change nothing live does: an up
# refused before then drops its staged configuration, so the snapshots, the containers and
# /opt/comp/src stay as they were (comp-result: changed=no). Every attempt adds one line to
# /opt/comp/releases.log,
# "<utc> <action> <sha12> ok|failed|rolled-back"; the current tag is that of the last ok
# release or rollback. The serving tag after a step is printed as "comp-result: serving=<tag>"
# (none: the site is down; unknown: see the log).
# Exit: 0 done; 1 failed before any container changed (or finish could not keep the
# configuration); 3 migrations pending or failed; 4 the
# previous tag serves again; 5 nothing serves (no earlier release); 6 restoring failed too.
# shellcheck source=deploy/server/lib/server-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-common.sh"
# shellcheck source=deploy/server/lib/server-stack.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-stack.sh"
# shellcheck source=deploy/server/lib/server-config.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-config.sh"
set -uo pipefail

usage() {
  echo "usage: release.sh up|finish|revert|unlock release|rollback <sha12>" >&2
  exit 2
}
[[ $# -eq 3 && "$2" =~ ^(release|rollback)$ && "$3" =~ $TAG_RE ]] || usage
step="$1" action="$2" tag="$3"
stage="$COMP_STAGE/${COMP_RUN_ID:-none}" # the configuration a release run renders, until kept

# restore <previous>: after $tag failed, brings <previous> back up with its snapshot, or stops
# everything (with the configuration compose runs now, $tag's) when there is none. Returns the
# exit status of the step (4, 5 or 6).
restore() {
  local previous="$1" missing snapshot
  if [[ -z "$previous" ]]; then
    echo "== no earlier release to bring back: stopping the containers of $tag"
    compose "$tag" stop || true
    record "$action" "$tag" failed
    result "serving=none"
    echo "THE SITE IS DOWN: $tag failed and there is no earlier release; its containers are stopped."
    return 5
  fi
  if ! snapshot="$(snapshot_of "$previous")"; then
    record "$action" "$tag" failed
    result "serving=unknown"
    echo "COULD NOT ROLL BACK: there is no snapshot of $previous ($COMP_RELEASES/$previous) to bring it back with; $tag is still up and failing."
    return 6
  fi
  missing="$(missing_images "$previous" "${STACK_IMAGES[@]}")"
  if [[ -n "$missing" ]]; then
    record "$action" "$tag" failed
    result "serving=unknown"
    echo "COULD NOT ROLL BACK: the images of $previous are gone ($(tr '\n' ' ' <<<"$missing")); $tag is still up and failing."
    return 6
  fi
  echo "== bringing $previous back with its snapshot ($snapshot)"
  use_config "$snapshot"
  if up_wait "$previous"; then
    record "$action" "$tag" rolled-back
    result "serving=$previous"
    if [[ "$previous" == "$tag" ]]; then
      echo "$tag was already serving: only the env files changed, re-rendered from comp/production/config: a change in the secret is the likely cause; it serves again with the env files of its snapshot."
    else
      echo "$previous is serving again, with its own env files and compose.yaml; $tag is not."
    fi
    return 4
  fi
  record "$action" "$tag" failed
  result "serving=unknown"
  echo "BRINGING $previous BACK FAILED TOO: the site may be down; check deploy/server/release.sh status."
  return 6
}

# bring_up: replaces the stack with $tag (the chosen configuration); on success holds the lease
# for the laptop's smoke checks, otherwise brings the previous tag back.
bring_up() {
  local previous status=0
  previous="$(current_tag)"
  echo "== serving before this step: ${previous:-nothing}"
  if up_wait "$tag"; then
    lease_take "${COMP_RUN_ID:?}" "$action $tag"
    result "serving=$tag"
    echo "$tag is up and healthy; the laptop runs the smoke checks next."
    return 0
  fi
  echo "compose up of $tag failed (above)"
  restore "$previous" || status=$?
  rm -rf "$stage"
  return "$status"
}

prune_after_release() { # prune.sh auto, bounded; its outcome as comp-result: prune=...
  local status=0
  timeout 600 bash "$(dirname "${BASH_SOURCE[0]}")/prune.sh" auto || status=$?
  case "$status" in
    0) result "prune=ok" ;;
    124) result "prune=timed-out"; echo "Warning: the post-release prune timed out after 600 s; the release stands." ;;
    *) result "prune=failed"; echo "Warning: the post-release prune failed (above); the release stands." ;;
  esac
}

failed_before_change() { # failed_before_change <status> <message>
  echo "$2"
  rm -rf "$stage"
  result "changed=no"
  echo "No container, snapshot or checkout was changed; still serving ${current:-nothing}."
  record "$action" "$tag" failed
  exit "$1"
}

case "$step" in
  up)
    current="$(current_tag)"
    rm -rf "$COMP_STAGE" # configurations of runs that stopped (no other run holds a lease)
    adopt_legacy
    if [[ "$action" == release ]]; then
      missing="$(missing_images "$tag" "${STACK_IMAGES[@]}" migrate)"
      [[ -z "$missing" ]] ||
        failed_before_change 1 "Refusing: missing images: $(tr '\n' ' ' <<<"$missing")(removed since the build step?); release $tag again, which builds them."
      stage_config "$stage" || failed_before_change 1 "Rendering the configuration of $tag failed (above)."
      use_config "$stage"
      migration_status "$tag"
      case "$MIGRATIONS" in
        up-to-date) ;;
        pending) failed_before_change 3 "REFUSING: the database lacks migrations of $tag (listed above). Apply them first: deploy/server/release.sh migrate $tag" ;;
        ahead) failed_before_change 3 "REFUSING: the database has migrations this commit lacks; release a commit that includes them (listed above)." ;;
        failed) failed_before_change 3 "REFUSING: the database has a failed migration (above). Resolve it by hand (prisma migrate resolve), then deploy/server/release.sh migrate $tag" ;;
        *) failed_before_change 3 "REFUSING: could not read the migration status (above)." ;;
      esac
    else
      [[ "$tag" != "$current" ]] || failed_before_change 1 "Refusing: already serving $tag."
      missing="$(missing_images "$tag" "${STACK_IMAGES[@]}")"
      [[ -z "$missing" ]] || failed_before_change 1 "Refusing: missing images: $(tr '\n' ' ' <<<"$missing")(pruned?); rollback needs all three."
      config="$(snapshot_of "$tag")" ||
        failed_before_change 1 "Refusing: there is no snapshot of $tag ($COMP_RELEASES/$tag): it was released before snapshots were kept, or pruned; roll back to a tag that has one (deploy/server/release.sh status lists them), or release its SHA again."
      use_config "$config"
    fi
    bring_up
    ;;
  finish)
    sha="${COMP_SHA:-}"
    if [[ "$action" == release ]]; then
      keep_snapshot "$stage" "$tag" || { echo "Not recorded: $tag serves, but its configuration could not be kept (above)."; exit 1; }
    else
      read -r sha <"$COMP_RELEASES/$tag/sha" || sha=""
    fi
    record "$action" "$tag" ok
    lease_drop
    result "serving=$tag"
    result "recorded=ok"
    echo "Recorded: $action $tag ok."
    [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]] || serve_checkout "$sha" || result "checkout=failed"
    [[ "$action" != release ]] || prune_after_release
    ;;
  revert)
    lease_drop
    echo "The smoke checks of $tag failed, or the laptop was interrupted."
    if [[ "$action" == release ]]; then use_config "$stage"; else use_config "$COMP_RELEASES/$tag"; fi
    status=0
    restore "$(current_tag)" || status=$?
    rm -rf "$stage"
    exit "$status"
    ;;
  unlock)
    lease_drop
    rm -rf "$stage"
    record "$action" "$tag" unlocked
    echo "Removed the lease of $action $tag (run ${COMP_RUN_ID:-?}); no container was changed."
    echo "Recorded serving tag: $(current_tag); the comp containers run: $(docker ps --all \
      --filter label=com.docker.compose.project=comp --format '{{.Image}}' | paste -sd ' ' -)"
    ;;
  *) usage ;;
esac

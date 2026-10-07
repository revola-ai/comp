#!/usr/bin/env bash
# Server side of `deploy/server/release.sh release` and `rollback`, run as root by
# on-server/entry.sh (which holds the server lock) from /opt/comp/src:
#
#   release.sh up release <sha12>     builds comp-{api,app,portal,migrate}:<sha12> (skipping
#                                     built ones), renders the env files, refuses pending or
#                                     failed migrations, then compose up --wait
#   release.sh up rollback <sha12>    the same without build or migration check; refuses a tag
#                                     whose three images are gone, or the serving one
#   release.sh finish <action> <sha12>  after the laptop's smoke checks passed: records ok
#   release.sh revert <action> <sha12>  after they failed: brings the previous tag back
#   release.sh unlock <action> <sha12>  `release.sh unlock` on the laptop: removes the lease of
#                                     a run whose laptop stopped (entry.sh checked it is that
#                                     run's and holds the lock, so no step runs); records it
#
# "up" that succeeds leaves the lease (COMP_RUN_ID) for finish or revert; a failed "up" brings
# the previous ok tag back by itself. Every attempt adds one line to /opt/comp/releases.log,
# "<utc> <action> <sha12> ok|failed|rolled-back"; the current tag is that of the last ok
# release or rollback. The serving tag after a step is printed as "comp-result: serving=<tag>"
# (none: the site is down; unknown: see the log).
# Exit: 0 done; 1 failed before any container changed; 3 migrations pending or failed; 4 the
# previous tag serves again; 5 nothing serves (no earlier release); 6 restoring failed too.
# shellcheck source=deploy/server/lib/server-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-common.sh"
# shellcheck source=deploy/server/lib/server-stack.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-stack.sh"
set -uo pipefail

usage() {
  echo "usage: release.sh up|finish|revert|unlock release|rollback <sha12>" >&2
  exit 2
}
[[ $# -eq 3 && "$2" =~ ^(release|rollback)$ && "$3" =~ $TAG_RE ]] || usage
step="$1" action="$2" tag="$3"

# restore <previous>: after $tag failed, brings <previous> back up, or stops everything when
# there is none. Returns the exit status of the step (4, 5 or 6).
restore() {
  local previous="$1" missing
  if [[ -z "$previous" ]]; then
    echo "== no earlier release to bring back: stopping the containers of $tag"
    compose "$tag" stop || true
    record "$action" "$tag" failed
    result "serving=none"
    echo "THE SITE IS DOWN: $tag failed and there is no earlier release; its containers are stopped."
    return 5
  fi
  missing="$(missing_images "$previous" "${STACK_IMAGES[@]}")"
  if [[ -n "$missing" ]]; then
    record "$action" "$tag" failed
    result "serving=unknown"
    echo "COULD NOT ROLL BACK: the images of $previous are gone ($(tr '\n' ' ' <<<"$missing")); $tag is still up and failing."
    return 6
  fi
  echo "== bringing $previous back"
  if up_wait "$previous"; then
    record "$action" "$tag" rolled-back
    result "serving=$previous"
    echo "$previous is serving again; $tag is not."
    return 4
  fi
  record "$action" "$tag" failed
  result "serving=unknown"
  echo "BRINGING $previous BACK FAILED TOO: the site may be down; check deploy/server/release.sh status."
  return 6
}

# bring_up: replaces the stack with $tag; on success holds the lease for the laptop's smoke checks.
bring_up() {
  local previous
  previous="$(current_tag)"
  echo "== serving before this step: ${previous:-nothing}"
  if up_wait "$tag"; then
    lease_take "${COMP_RUN_ID:?}" "$action $tag"
    result "serving=$tag"
    echo "$tag is up and healthy; the laptop runs the smoke checks next."
    return 0
  fi
  echo "compose up of $tag failed (above)"
  restore "$previous"
}

failed_before_change() { # failed_before_change <status> <message>
  echo "$2"
  result "changed=no"
  echo "No container was changed; still serving ${current:-nothing}."
  record "$action" "$tag" failed
  exit "$1"
}

case "$step" in
  up)
    current="$(current_tag)"
    if [[ "$action" == release ]]; then
      build_images "$tag" "${STACK_IMAGES[@]}" migrate || failed_before_change 1 "Building the images of $tag failed."
      render_env || failed_before_change 1 "render-env.sh failed."
      migration_status "$tag"
      case "$MIGRATIONS" in
        up-to-date) ;;
        pending) failed_before_change 3 "REFUSING: the database lacks migrations of $tag (listed above). Apply them first: deploy/server/release.sh migrate $tag" ;;
        failed) failed_before_change 3 "REFUSING: the database has a failed migration (above). Resolve it by hand (prisma migrate resolve), then deploy/server/release.sh migrate $tag" ;;
        *) failed_before_change 3 "REFUSING: could not read the migration status (above)." ;;
      esac
    else
      [[ "$tag" != "$current" ]] || failed_before_change 1 "Refusing: already serving $tag."
      missing="$(missing_images "$tag" "${STACK_IMAGES[@]}")"
      [[ -z "$missing" ]] || failed_before_change 1 "Refusing: missing images: $(tr '\n' ' ' <<<"$missing")(pruned?); rollback needs all three."
      render_env || failed_before_change 1 "render-env.sh failed."
    fi
    bring_up
    ;;
  finish)
    record "$action" "$tag" ok
    lease_drop
    result "serving=$tag"
    echo "Recorded: $action $tag ok."
    ;;
  revert)
    lease_drop
    echo "The smoke checks of $tag failed, or the laptop was interrupted."
    restore "$(current_tag)"
    ;;
  unlock)
    lease_drop
    record "$action" "$tag" unlocked
    echo "Removed the lease of $action $tag (run ${COMP_RUN_ID:-?}); no container was changed."
    echo "Recorded serving tag: $(current_tag); the comp containers run: $(docker ps --all \
      --filter label=com.docker.compose.project=comp --format '{{.Image}}' | paste -sd ' ' -)"
    ;;
  *) usage ;;
esac

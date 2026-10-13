#!/usr/bin/env bash
# Server side of `deploy/server/release.sh release` and `rollback`, run as root by
# on-server/entry.sh (which holds the server lock): a release's steps from a worktree of its SHA,
# a rollback's and unlock from /opt/comp/src, the serving release's checkout:
#
#   release.sh up release <sha12>     after the build step (on-server/build.sh): refuses when
#                                     the serving tag has no snapshot (a failure could not bring
#                                     it back) or an image of the tag is missing, renders the run's
#                                     configuration into /opt/comp/stage (lib/server-config.sh),
#                                     refuses pending or failed migrations, then compose up --wait
#                                     with it
#   release.sh up rollback <sha12>    compose up --wait with the tag's snapshot, without build or
#                                     migration check; refuses a tag whose three images or whose
#                                     snapshot are gone, the serving one, or any while
#                                     /opt/comp/src (these scripts) is not at the serving tag
#   release.sh finish <action> <sha12>  after the laptop's smoke checks passed: pins a release's
#                                     commit (refs/comp/releases/<tag>, lib/server-config.sh) and
#                                     keeps its configuration as the tag's snapshot, records ok
#                                     and says so (recorded=ok), moves /opt/comp/src to the tag's
#                                     SHA (checkout=failed and branch=on|off|unknown when it
#                                     cannot: the laptop warns, naming the way out); after
#                                     a release, then prunes old images when / is over 70% used, for
#                                     at most 600 s (prune=ok|failed|timed-out), which never fails
#                                     the step
#   release.sh revert <action> <sha12>  after they failed: brings the previous tag back with its
#                                     own snapshot, or, when that fails its health checks, with
#                                     its configuration rendered again from its pinned commit
#                                     and the current secret (comp-result: restore=snapshot|fresh)
#   release.sh unlock <action> <sha12>  `release.sh unlock` on the laptop: removes the lease of
#                                     a run whose laptop stopped (entry.sh checked it is that
#                                     run's and holds the lock, so no step runs); records it
#
# "up" that succeeds leaves the lease (COMP_RUN_ID) for finish or revert; a failed "up" brings
# the previous ok tag back by itself. Before the containers change nothing live does: an up
# refused before then drops its staged configuration, so the snapshots, the containers and
# /opt/comp/src stay as they were (comp-result: changed=no). Every attempt adds one line to
# /opt/comp/releases.log, "<utc> <action> <sha12> <outcome> <operator>", the outcome ok, failed,
# rolled-back, rolled-back-fresh or unlocked, the operator the caller ARN of the laptop command
# that ran the step (COMP_OPERATOR from entry.sh; not a secret; "-" without one; older lines have
# only the first four fields, which are all any reader uses). migrate.sh and trigger.sh add
# "migrate" and "trigger" lines, ok or failed, and build.sh a failed release; the current tag is
# the top of the serving history (lib/server-common.sh). The serving tag after a step is printed as
# "comp-result: serving=<tag>" (none: the site is down; unknown: see the log).
# Exit: 0 done; 1 failed before any container changed (or finish could not pin the commit or
# keep the configuration); 3 migrations pending or failed; 4 the previous tag serves again; 5
# nothing serves (no earlier release); 6 restoring failed too (or, with no earlier release,
# stopping the failed tag did: comp-result: restore=stop-failed).
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
# everything (with the configuration compose runs now, $tag's) when there is none, never
# claiming so when the stop fails. Returns the exit status of the step (4, 5 or 6).
restore() {
  local previous="$1" missing snapshot
  if [[ -z "$previous" ]]; then
    echo "== no earlier release to bring back: stopping the containers of $tag"
    if ! compose "$tag" stop; then
      record "$action" "$tag" failed
      result "serving=unknown"
      result "restore=stop-failed"
      echo "COULD NOT STOP the containers of $tag (above): there is no earlier release to bring back, so $tag may still be up, failing; check deploy/server/release.sh status."
      return 6
    fi
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
    result "restore=snapshot"
    if [[ "$previous" == "$tag" ]]; then
      echo "$tag was already serving: only the env files changed, re-rendered from comp/production/config: a change in the secret is the likely cause; it serves again with the env files of its snapshot."
    else
      echo "$previous is serving again, with its own env files and compose.yaml; $tag is not."
    fi
    return 4
  fi
  # A snapshot that no longer comes up (a credential in it revoked since): once more with the
  # current secret. Not for the serving tag released again: that configuration just failed.
  local how="with its snapshot"
  if [[ "$previous" != "$tag" ]]; then
    restore_fresh "$previous" "$snapshot" && return 4
    result "restore=fresh-failed"
    how="with its snapshot, and with its configuration rendered again"
  fi
  record "$action" "$tag" failed
  result "serving=unknown"
  echo "BRINGING $previous BACK FAILED TOO ($how): the site may be down; check deploy/server/release.sh status."
  return 6
}

# restore_fresh <previous> <snapshot>: brings <previous> back with its configuration rendered
# again (fresh_config, lib/server-config.sh) after its snapshot failed its health checks.
restore_fresh() {
  local fresh="$COMP_STAGE/${COMP_RUN_ID:-none}-fresh" # cleared by the next step (entry.sh)
  echo "== $1 did not come back with its snapshot (above); once more with its configuration rendered again: its own commit's render-env.sh and compose.yaml, and the CURRENT comp/production/config"
  fresh_config "$1" "$2" "$fresh" || { echo "Rendering the configuration of $1 again failed (above)."; return 1; }
  use_config "$fresh"
  up_wait "$1" || return 1
  record "$action" "$tag" rolled-back-fresh
  result "serving=$1"
  result "restore=fresh"
  echo "$1 is serving again, with its configuration rendered again from its own commit and the CURRENT comp/production/config; its snapshot failed its health checks (above) and stays as it was; $tag is not."
}

# bring_up: replaces the stack with $tag (the chosen configuration); on success holds the lease
# for the laptop's smoke checks, otherwise brings the previous tag back.
bring_up() {
  local previous status=0
  previous="$(current_tag)"
  echo "== serving before this step: ${previous:-nothing}"
  if up_wait "$tag" && lease_take "${COMP_RUN_ID:?}" "$action $tag"; then
    result "serving=$tag"
    echo "$tag is up and healthy; the laptop runs the smoke checks next."
    return 0
  fi
  # Without the lease the laptop could neither record nor revert this run: no tag stays unverified.
  echo "compose up of $tag failed, or its lease could not be taken (above)"
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
    if [[ "$action" == release ]]; then
      # A failure would bring $current back with its snapshot: without one, nothing could.
      [[ -z "$current" ]] || snapshot_of "$current" >/dev/null ||
        failed_before_change 1 "Refusing: the serving tag $current has no snapshot ($COMP_RELEASES/$current), so a failed release could not bring it back; roll back to a tag that has one (deploy/server/release.sh status lists them); releases work again once it serves."
      missing="$(missing_images "$tag" "${STACK_IMAGES[@]}" migrate)"
      [[ -z "$missing" ]] ||
        failed_before_change 1 "Refusing: missing images: $(tr '\n' ' ' <<<"$missing")(removed since the build step?); release $tag again, which builds them."
      stage_config "$stage" "$REPO" "${COMP_SHA:-}" || failed_before_change 1 "Rendering the configuration of $tag failed (above)."
      use_config "$stage"
      migration_status "$tag"
      [[ "$MIGRATIONS" == up-to-date ]] || failed_before_change 3 "$(migrations_refusal "$tag")"
    else
      [[ "$tag" != "$current" ]] || failed_before_change 1 "Refusing: already serving $tag."
      # This step runs the scripts of /opt/comp/src, which a release's finish may have failed to move.
      src="$(git -C "$COMP_SRC" rev-parse HEAD 2>/dev/null)" || src=unknown
      [[ -z "$current" || "${src:0:12}" == "$current" ]] ||
        failed_before_change 1 "Refusing: /opt/comp/src is at ${src:0:12}, not at the serving $current, so this rollback would run the scripts of another release; to move it, $(src_lag_way_out "$current"), then roll back."
      missing="$(missing_images "$tag" "${STACK_IMAGES[@]}")"
      [[ -z "$missing" ]] || failed_before_change 1 "Refusing: missing images: $(tr '\n' ' ' <<<"$missing")(pruned?); rollback needs all three."
      config="$(snapshot_of "$tag")" ||
        failed_before_change 1 "Refusing: there is no snapshot of $tag ($COMP_RELEASES/$tag; pruned?); roll back to a tag that has one (deploy/server/release.sh status lists them), or release its SHA again."
      use_config "$config"
    fi
    bring_up
    ;;
  finish)
    sha="${COMP_SHA:-}"
    if [[ "$action" == release ]]; then
      pin_release "$tag" "$sha" || { echo "Not recorded: $tag serves, but its commit could not be pinned (above)."; exit 1; }
      keep_snapshot "$stage" "$tag" || { echo "Not recorded: $tag serves, but its configuration could not be kept (above)."; exit 1; }
    else
      read -r sha <"$COMP_RELEASES/$tag/sha" || sha=""
    fi
    if ! record "$action" "$tag" ok; then
      echo "Not recorded: $tag serves and passed the smoke checks; the lease of this run stays, so no other step starts until it is unlocked."
      result "recorded=failed"
      exit 1
    fi
    lease_drop || echo "Free the lease with deploy/server/release.sh unlock; the release is recorded."
    result "serving=$tag"
    result "recorded=ok"
    echo "Recorded: $action $tag ok."
    [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]] || serve_checkout "$tag" "$sha"
    [[ "$action" != release ]] || prune_after_release
    ;;
  revert)
    lease_drop || echo "The lease stays (above); $tag is reverted anyway, then free it with deploy/server/release.sh unlock."
    echo "The smoke checks of $tag failed, or the laptop was interrupted."
    if [[ "$action" == release ]]; then use_config "$stage"; else use_config "$COMP_RELEASES/$tag"; fi
    status=0
    restore "$(current_tag)" || status=$?
    rm -rf "$stage"
    exit "$status"
    ;;
  unlock)
    lease_drop || exit 1
    rm -rf "$stage"
    record "$action" "$tag" unlocked || { echo "The lease is gone, but recording the unlock failed (above)."; exit 1; }
    echo "Removed the lease of $action $tag (run ${COMP_RUN_ID:-?}); no container was changed."
    echo "Recorded serving tag: $(current_tag); the comp containers run: $(docker ps --all \
      --filter label=com.docker.compose.project=comp --format '{{.Image}}' | paste -sd ' ' -)"
    ;;
  *) usage ;;
esac

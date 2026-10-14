# shellcheck shell=bash
# `release` and `rollback` of deploy/server/release.sh (sourced, never run on its own; needs
# lib/release-remote.sh). Both bring a tag up on the server (on-server/release.sh up), smoke-check
# it from here, then record it (finish) or bring the previous tag back (revert). The server
# holds a lease for the run between those steps, so nothing else starts in between. A release's
# steps all name its SHA, so the server runs each from its own checkout of it; a rollback's run
# from the serving release's checkout.

SMOKE_TRIES=24     # tries of each check, SMOKE_PAUSE seconds apart
SMOKE_PAUSE=5
SMOKE_MAX_TIME=10  # curl --max-time of one try
# The checks share one deadline, SMOKE_SECONDS after they start: half the lease the server holds
# for the run (LEASE_SECONDS, lib/server-common.sh). One check alone may take SMOKE_TRIES *
# SMOKE_MAX_TIME + (SMOKE_TRIES - 1) * SMOKE_PAUSE = 24 * 10 + 23 * 5 = 355 s, and five of them
# 1,775 s, past the 1,200 s lease: finish or revert would then be refused (lease expired) and a
# failing tag would keep serving. No try starts after the deadline, and each try's --max-time and
# each pause are capped at the time left, so the checks end within SMOKE_SECONDS = 600 s. The
# other 600 s of the lease cover the poll that saw the up step end (POLL_SECONDS), sending finish
# or revert, and that step's bounded wait for the server lock (on-server/entry.sh).
SMOKE_SECONDS=$((LEASE_SECONDS / 2))
SMOKE_DEADLINE=0   # epoch seconds, set by smoke
# After a finish or revert the server refused (the run's lease ran out, or the lock stayed busy).
LEASE_HINT="Check deploy/server/release.sh status (a lease it lists is freed with deploy/server/release.sh unlock)"
# The up step: render, migration status, compose up --wait (600 s), then a restore's: up with the
# previous tag's snapshot (600 s) and, when that fails, rendered again (600 s).
UP_SECONDS=2400
BUILD_SECONDS=7200 # builds of up to four images (the build step, which changes nothing live)

# smoke_one <url> <200|access>: retries until the URL answers 200, or for "access" a 302 to
# Cloudflare Access (proof that Access guards the host); false after SMOKE_TRIES answers or at
# the deadline, saying which.
smoke_one() {
  local url="$1" want="$2" try=0 answer code="000" location="" left over tries
  while ((try < SMOKE_TRIES)); do
    left=$((SMOKE_DEADLINE - $(date +%s)))
    ((left > 0)) || break
    try=$((try + 1))
    answer="$(curl -sS -o /dev/null --max-time "$((left < SMOKE_MAX_TIME ? left : SMOKE_MAX_TIME))" \
      -w '%{http_code} %{redirect_url}' "$url" 2>/dev/null)" || answer="000 "
    code="${answer%% *}" location="${answer#* }"
    if [[ "$want" == 200 && "$code" == 200 ]] ||
      [[ "$want" == access && "$code" == 302 && "$location" =~ ^https://[A-Za-z0-9-]+\.cloudflareaccess\.com(/|$) ]]; then
      echo "  ok    $url ($code)"
      return 0
    fi
    left=$((SMOKE_DEADLINE - $(date +%s)))
    ((try == SMOKE_TRIES || left <= 0)) || sleep "$((left < SMOKE_PAUSE ? left : SMOKE_PAUSE))"
  done
  over="on all $SMOKE_TRIES tries, $SMOKE_PAUSE seconds apart" tries=tries
  ((try != 1)) || tries=try
  ((try == SMOKE_TRIES)) ||
    over="after $try $tries, when the smoke checks' deadline passed ($SMOKE_SECONDS s for all of them: half the $LEASE_SECONDS-second lease)"
  if [[ "$want" == access ]]; then
    echo "  FAIL  $url answered $code ${location:+$location }$over, not a 302 to <team>.cloudflareaccess.com (is Access off?)"
  else
    echo "  FAIL  $url answered $code $over"
  fi
  return 1
}

smoke() { # smoke <tag>: the public checks, stopping at the first that fails
  echo "Smoke checks of $1 from this machine:"
  SMOKE_DEADLINE=$(($(date +%s) + SMOKE_SECONDS))
  smoke_one https://api.comp.revola.ai/v1/health/ready 200 &&
    smoke_one https://app.comp.revola.ai/api/health/live 200 &&
    smoke_one https://portal.comp.revola.ai/api/health 200 &&
    smoke_one https://app.comp.revola.ai/ access &&
    smoke_one https://portal.comp.revola.ai/ access
}

# after_restore [what]: reports a server step that ended with the previous tag back (4),
# nothing serving (5), restoring (or, after a first release, stopping) that failed too (6), a
# revert the server refused (its lease ran out: nothing changed) or an unknown state; smoke-checks the restored tag. <what> says what happened to $TAG (default: it
# failed). Always fails the command.
after_restore() {
  local what="${1:-$TAG failed}" serving
  STAGE=done
  if unchanged; then
    echo "The revert step of $TAG was refused (above), so nothing changed: $TAG still serves, unverified."
    echo "$LEASE_HINT, then release the SHA that should serve."
    exit 1
  fi
  serving="$(result_of serving)"
  case "$REMOTE_CODE:$serving" in
    4:"$TAG")
      echo "$TAG was already serving, so only the env files changed, re-rendered from comp/production/config: a change in the secret is the likely cause."
      echo "It serves again with the env files and compose.yaml of its snapshot, as before this release; fix the secret (deploy/server/push-secrets.ts), then release $TAG again."
      smoke "$serving" || echo "Its smoke checks still fail: the site may be down (deploy/server/release.sh status)."
      ;;
    4:?*)
      if [[ "$(result_of restore)" == fresh ]]; then
        echo "$serving came back with its configuration rendered again from its own commit and the current comp/production/config, not with its snapshot, which failed its health checks (above)."
        echo "Its snapshot stays as it was: once the cause is clear (a credential revoked since it was released?), release $serving again so its snapshot holds a configuration that works."
      fi
      if smoke "$serving"; then
        echo "Now serving $serving (it passes the smoke checks); $TAG is not released."
      else
        echo "Now serving $serving, but its smoke checks fail too: the site may be down (deploy/server/release.sh status)."
      fi
      ;;
    5:*) echo "THE SITE IS DOWN: $what and there was no earlier release to bring back." ;;
    6:*)
      if [[ "$(result_of restore)" == stop-failed ]]; then
        echo "COULD NOT STOP $TAG: $what, there was no earlier release to bring back, and stopping its containers failed too (above); it may still be up, failing."
      elif [[ "$(result_of restore)" == fresh-failed ]]; then
        echo "COULD NOT BRING THE PREVIOUS RELEASE BACK: $what, and restoring the release before it failed too (above), with its snapshot and with its configuration rendered again from the current secret; the site may be down."
      else
        echo "COULD NOT BRING THE PREVIOUS RELEASE BACK: $what, and restoring the release before it failed too (above); the site may be down."
      fi
      echo "Check what serves with: deploy/server/release.sh status"
      ;;
    *) unknown_state "$what" ;;
  esac
  exit 1
}

after_prune() { # after a recorded release: a failed or slow post-release prune, said apart
  case "$(result_of prune)" in
    failed) echo "Released $TAG, but the post-release prune failed (above); free space with deploy/server/release.sh prune." ;;
    timed-out) echo "Released $TAG, but the post-release prune timed out after 600 s; free space with deploy/server/release.sh prune." ;;
  esac
}

# after_checkout <release|rollback>: after a recorded finish whose server could not move
# /opt/comp/src to $TAG (checkout=failed): the release or rollback stands, but the steps without
# a SHA run from there, so it warns, naming the way out that works (src_way_out: never releasing
# $TAG again once the server found it off RELEASE_BRANCH, branch=off), and returns 1: the
# command fails until the cause is fixed. When /opt/comp/src did move but could not be made
# world-readable (checkout=unreadable), nothing lags: it only warns.
after_checkout() {
  local before="the release before it"
  if [[ "$(result_of checkout)" == unreadable ]]; then
    echo "WARNING: /opt/comp/src is at $TAG, but making it world-readable failed (above); the steps without a SHA run its scripts all the same, and the next release or rollback tries again."
    return 0
  fi
  [[ "$(result_of checkout)" == failed ]] || return 0
  [[ "$1" != rollback ]] || before="the release rolled back from"
  echo "WARNING: /opt/comp/src did not move to $TAG (above), so it still holds the scripts of $before."
  echo "rollback, prune and unlock run those scripts, and rollback refuses until /opt/comp/src is at $TAG;"
  echo "fix the cause (above), then $(src_way_out "$TAG" "$(result_of branch)"), which moves it."
  return 1
}

# not_recorded: after a finish step without recorded=ok: its output was cut short (the server
# may well have recorded it), refused (nothing changed), or the server could not record it, in
# which case the run's lease stays.
not_recorded() {
  if [[ -z "$REMOTE_ENDED" ]]; then
    echo "The output of the finish step of $TAG was cut short, so whether it was recorded is unknown;"
    echo "check with deploy/server/release.sh status (its last releases list a recorded release)."
  elif unchanged; then
    echo "The finish step of $TAG was refused (above), so it is not recorded and serves unverified."
    echo "$LEASE_HINT, then release $TAG again."
  else
    echo "$TAG is up and passes the smoke checks, but the server could not record it (above); its lease stays, so no other step starts for up to 20 minutes."
    echo "Fix the cause (a full disk?), then run deploy/server/release.sh unlock and release $TAG again."
  fi
}

unknown_state() { # unknown_state <what happened>: the step's outcome cannot be trusted
  echo "$1, and the serving state is unknown: the server did not report how the step ended."
  echo "Check what serves now with: deploy/server/release.sh status"
}

# bring_up <action> <run>: the up step of $TAG (release or rollback), the smoke checks, then
# finish or revert under the same run.
bring_up() {
  local action="$1" run="$2" sha="-"
  [[ "$action" != release ]] || sha="$FULL_SHA"
  STAGE=up UP_RUN="$run" UP_ACTION="$action" UP_SHA="$sha" # an interrupt from here on reverts (lib/release-interrupt.sh)
  step "$action" "$UP_SECONDS" "$run" new "$sha" release up "$action" "$TAG"
  if [[ "$REMOTE_STATUS" != Success ]] || [[ "$REMOTE_CODE" -ne 0 ]]; then
    STAGE=done
    if unchanged; then
      die "$action of $TAG stopped before any container changed (above); still serving the earlier release"
    fi
    case "$REMOTE_STATUS:$REMOTE_CODE:$REMOTE_ENDED" in
      Failed:[456]:1) after_restore ;;
    esac
    unknown_state "The $action step of $TAG did not end normally"
    exit 1
  fi
  STAGE=verify
  if smoke "$TAG"; then
    step finish "$UP_SECONDS" "$run" own "$sha" release finish "$action" "$TAG"
    STAGE=done
    [[ "$(result_of recorded)" == ok ]] || { not_recorded; exit 1; }
    echo
    echo "Released $TAG: it serves and passes the smoke checks ($action)."
    after_prune
    after_checkout "$action" || exit 1
    return 0
  fi
  echo "The smoke checks of $TAG failed; bringing the previous release back."
  step revert "$UP_SECONDS" "$run" own "$sha" release revert "$action" "$TAG"
  after_restore
}

cmd_release() {
  [[ $# -eq 1 ]] || die "usage: release.sh release <sha>"
  require_local aws git python3 curl
  resolve_pushed "$1"
  connect
  echo "Releasing $TAG ($FULL_SHA) to $INSTANCE_ID: build comp-api, comp-app, comp-portal and"
  echo "comp-migrate:$TAG from a checkout of it (skipping built ones; Ctrl-C cancels the build),"
  echo "then render its configuration, refuse if migrations are pending, compose up and wait for"
  echo "every healthcheck, then the smoke checks from here. On a failure the previous release comes back."
  local run
  run="$(run_id release "$TAG")"
  step build "$BUILD_SECONDS" "$run" new "$FULL_SHA" build "$TAG"
  if [[ "$REMOTE_STATUS" != Success ]] || [[ "$REMOTE_CODE" -ne 0 ]]; then
    unchanged && die "the release of $TAG stopped before any container changed (above); still serving the earlier release"
    die "the build step of $TAG did not end normally (above); it changes no container, so the earlier release still serves; release $TAG again (it skips the images already built)"
  fi
  bring_up release "$run"
}

cmd_rollback() {
  [[ $# -le 1 ]] || die "usage: release.sh rollback [<sha>]"
  [[ $# -eq 0 || "$1" =~ ^[0-9a-f]{12,40}$ ]] || die "'$1' is not a git SHA (12 to 40 hex characters)"
  require_local aws python3 curl
  connect
  TAG=""
  REMOTE_QUIET=1 remote "comp release.sh status" 120 status tags
  [[ "$REMOTE_CODE" -eq 0 ]] || die "could not read the release tags from the server"
  local current
  current="$(result_of current)"
  TAG="${1:-}"
  TAG="${TAG:0:12}"
  [[ -n "$TAG" ]] || TAG="$(result_of previous)"
  [[ -n "$TAG" ]] || die "there is no earlier ok release to roll back to (deploy/server/release.sh status)"
  [[ "$TAG" != "$current" ]] || die "already serving $TAG"
  local run
  run="$(run_id rollback "$TAG")"
  echo "Rolling back from ${current:-nothing} to $TAG on $INSTANCE_ID: its images as built, with"
  echo "the env files and compose.yaml it was released with (its snapshot; refused without one),"
  echo "no migration (the database keeps newer migrations); then the smoke checks from here."
  bring_up rollback "$run"
}

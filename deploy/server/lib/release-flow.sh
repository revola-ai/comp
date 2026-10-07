# shellcheck shell=bash
# `release` and `rollback` of deploy/server/release.sh (sourced, never run on its own; needs
# lib/release-remote.sh). Both bring a tag up on the server (on-server/release.sh up), smoke-check
# it from here, then record it (finish) or bring the previous tag back (revert). The server
# holds a lease for the run between those steps, so nothing else starts in between.

SMOKE_TRIES=24 # each check, 5 seconds apart: about 2 minutes
SMOKE_PAUSE=5
UP_SECONDS=1800      # render, compose up --wait (600 s) and a restore's up --wait (600 s)
RELEASE_SECONDS=7200 # builds of up to four images, then up

# smoke_one <url> <200|access>: retries until the URL answers 200, or for "access" a 302 to
# Cloudflare Access (proof that Access guards the app); false after SMOKE_TRIES answers.
smoke_one() {
  local url="$1" want="$2" try answer code location
  for ((try = 1; try <= SMOKE_TRIES; try++)); do
    answer="$(curl -sS -o /dev/null --max-time 10 -w '%{http_code} %{redirect_url}' "$url" 2>/dev/null)" || answer="000 "
    code="${answer%% *}" location="${answer#* }"
    if [[ "$want" == 200 && "$code" == 200 ]] ||
      [[ "$want" == access && "$code" == 302 && "$location" =~ ^https://[A-Za-z0-9-]+\.cloudflareaccess\.com(/|$) ]]; then
      echo "  ok    $url ($code)"
      return 0
    fi
    ((try == SMOKE_TRIES)) || sleep "$SMOKE_PAUSE"
  done
  if [[ "$want" == access ]]; then
    echo "  FAIL  $url answered $code ${location:-} for 2 minutes, not a 302 to <team>.cloudflareaccess.com (is Access off?)"
  else
    echo "  FAIL  $url answered $code for 2 minutes"
  fi
  return 1
}

smoke() { # smoke <tag>: the public checks, stopping at the first that fails
  echo "Smoke checks of $1 from this machine:"
  smoke_one https://api.comp.revola.ai/v1/health/ready 200 &&
    smoke_one https://app.comp.revola.ai/api/health/live 200 &&
    smoke_one https://portal.comp.revola.ai/api/health 200 &&
    smoke_one https://app.comp.revola.ai/ access
}

# after_restore: reports a server step that ended with the previous tag back (4), nothing
# serving (5) or an unknown state; smoke-checks the restored tag. Always fails the command.
after_restore() {
  local serving
  serving="$(result_of serving)"
  case "$REMOTE_CODE:$serving" in
    4:?*)
      if smoke "$serving"; then
        echo "Now serving $serving (it passes the smoke checks); $TAG is not released."
      else
        echo "Now serving $serving, but its smoke checks fail too: the site may be down (deploy/server/release.sh status)."
      fi
      ;;
    5:*) echo "THE SITE IS DOWN: $TAG failed and there was no earlier release to bring back." ;;
    *) unknown_state "$TAG failed" ;;
  esac
  exit 1
}

unknown_state() { # unknown_state <what happened>: the step's outcome cannot be trusted
  echo "$1, and the serving state is unknown: the server did not report how the step ended."
  echo "Check what serves now with: deploy/server/release.sh status"
}

# bring_up <action>: the up step of $TAG (release or rollback), the smoke checks, then finish
# or revert under the same run.
bring_up() {
  local action="$1" run sha="-" timeout="$UP_SECONDS"
  run="$(run_id "$action" "$TAG")"
  if [[ "$action" == release ]]; then
    sha="$FULL_SHA" timeout="$RELEASE_SECONDS"
  fi
  step "$action" "$timeout" "$run" new "$sha" release up "$action" "$TAG"
  if [[ "$REMOTE_STATUS" != Success ]] || [[ "$REMOTE_CODE" -ne 0 ]]; then
    if unchanged; then
      die "$action of $TAG stopped before any container changed (above); still serving the earlier release"
    fi
    case "$REMOTE_STATUS:$REMOTE_CODE:$REMOTE_ENDED" in
      Failed:[456]:1) after_restore ;;
    esac
    unknown_state "The $action step of $TAG did not end normally"
    exit 1
  fi
  if smoke "$TAG"; then
    step finish "$UP_SECONDS" "$run" own - release finish "$action" "$TAG"
    [[ "$REMOTE_CODE" -eq 0 ]] ||
      die "$TAG is up and passes the smoke checks, but recording it failed (above); rerun: deploy/server/release.sh $action $TAG"
    echo
    echo "Released $TAG: it serves and passes the smoke checks ($action)."
    return 0
  fi
  echo "The smoke checks of $TAG failed; bringing the previous release back."
  step revert "$UP_SECONDS" "$run" own - release revert "$action" "$TAG"
  after_restore
}

cmd_release() {
  [[ $# -eq 1 ]] || die "usage: release.sh release <sha>"
  require_local aws git python3 curl
  resolve_pushed "$1"
  connect
  echo "Releasing $TAG ($FULL_SHA) to $INSTANCE_ID: check it out in /opt/comp/src, build"
  echo "comp-api, comp-app, comp-portal and comp-migrate:$TAG (skipping built ones), render the env"
  echo "files, refuse if migrations are pending, compose up and wait for every healthcheck,"
  echo "then the smoke checks from here. On a failure the previous release comes back."
  bring_up release
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
  echo "Rolling back from ${current:-nothing} to $TAG on $INSTANCE_ID: its images as built, the env"
  echo "files and compose.yaml of the server's current checkout (compose changes since are kept),"
  echo "no migration (the database keeps newer migrations); then the smoke checks from here."
  bring_up rollback
}

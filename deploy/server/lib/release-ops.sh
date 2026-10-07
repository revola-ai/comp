# shellcheck shell=bash
# `migrate`, `trigger`, `prune`, `status` and `logs` of deploy/server/release.sh (sourced, never
# run on its own; needs lib/release-remote.sh). The three that change production ask for a
# typed word at the terminal (/dev/tty, never stdin) and refuse before any AWS call without one.

TOOLS_SECONDS=3600 # a tools image build plus prisma or trigger.dev
PRUNE_SECONDS=1800

need_terminal() { # need_terminal <command>: opens the terminal for the typed confirmation
  open_terminal "release.sh $1 needs a terminal for its typed confirmation; run it from an interactive shell (piped answers are never accepted)"
}

confirmed() { # confirmed <word> <prompt>: true when exactly <word> is typed at the terminal
  ask "$2"
  [[ "$OUT" == "$1" ]]
}

cmd_migrate() {
  [[ $# -eq 1 ]] || die "usage: release.sh migrate <sha>"
  require_local aws git python3
  need_terminal migrate
  resolve_pushed "$1"
  connect
  local run
  run="$(run_id migrate "$TAG")"
  echo "Checking the migrations of $TAG against the production database (nothing is applied yet)."
  step migrate-status "$TOOLS_SECONDS" "$run" new "$FULL_SHA" migrate status "$TAG"
  [[ "$REMOTE_CODE" -eq 0 ]] || die "reading the migration status failed (above)"
  case "$(result_of migrations)" in
    up-to-date) echo "Nothing to apply."; return 0 ;;
    pending) ;;
    *) die "not applying: the status above is not just pending migrations" ;;
  esac
  echo
  if ! confirmed migrate "Type migrate to apply the pending migrations above to the PRODUCTION database: "; then
    die "Not applied."
  fi
  step migrate "$TOOLS_SECONDS" "$run" new "$FULL_SHA" migrate deploy "$TAG"
  [[ "$REMOTE_CODE" -eq 0 ]] || die "applying the migrations of $TAG failed (above)"
  echo "Applied the migrations of $TAG; release it with: deploy/server/release.sh release $TAG"
}

cmd_trigger() {
  [[ $# -ge 1 ]] || die "usage: release.sh trigger <sha> [--project api|app]"
  local sha="$1" projects=(api app) run
  shift
  if [[ $# -gt 0 ]]; then
    [[ $# -eq 2 && "$1" == --project && "$2" =~ ^(api|app)$ ]] || die "usage: release.sh trigger <sha> [--project api|app]"
    projects=("$2")
  fi
  require_local aws git python3
  need_terminal trigger
  resolve_pushed "$sha"
  connect
  echo "Deploying Trigger.dev prod for ${projects[*]} (in that order) from $TAG on $INSTANCE_ID:"
  echo "npx trigger.dev@4.4.3 deploy --env prod in a one-off comp-migrate:$TAG container, with"
  echo "TRIGGER_ACCESS_TOKEN and TRIGGER_PROJECT_REF_<API|APP> from comp/production/config."
  echo "The tasks' env vars come from the Trigger.dev dashboard (README, Releasing)."
  if ! confirmed trigger "Type trigger to deploy: "; then
    die "Not deployed."
  fi
  run="$(run_id trigger "$TAG")"
  step trigger "$TOOLS_SECONDS" "$run" new "$FULL_SHA" trigger "$TAG" "${projects[@]}"
  [[ "$REMOTE_CODE" -eq 0 ]] || die "the Trigger.dev deploy failed (above)"
}

cmd_prune() {
  [[ $# -eq 0 ]] || die "usage: release.sh prune"
  require_local aws python3
  need_terminal prune
  connect
  TAG=""
  local run remove
  run="$(run_id prune)"
  step prune-plan "$PRUNE_SECONDS" "$run" new - prune plan
  [[ "$REMOTE_CODE" -eq 0 ]] || die "could not list the images (above)"
  remove="$(result_of remove)"
  echo
  if ! confirmed prune "Type prune to remove ${remove:+the images listed above and }trim the build cache: "; then
    die "Nothing removed."
  fi
  # shellcheck disable=SC2086 # one image ref per word
  step prune "$PRUNE_SECONDS" "$run" new - prune apply $remove
  [[ "$REMOTE_CODE" -eq 0 ]] || die "pruning did not finish cleanly (above)"
}

cmd_status() {
  [[ $# -eq 0 ]] || die "usage: release.sh status"
  require_local aws python3
  connect
  remote "comp release.sh status" 120 status show
  [[ "$REMOTE_CODE" -eq 0 ]] || die "reading the status failed (above)"
  echo
  echo "Container logs: deploy/server/release.sh logs <service>; a step's log: logs --release <name>"
}

cmd_logs() {
  [[ $# -ge 1 ]] || die "usage: release.sh logs <service> | logs --release <log>"
  if [[ "$1" != --release ]]; then
    [[ $# -eq 1 && " ${SERVICES[*]} " == *" $1 "* ]] || die "logs: the services are ${SERVICES[*]}"
    echo "aws logs tail /comp/$1 --follow --region $REGION"
    return 0
  fi
  [[ $# -eq 2 ]] || die "usage: release.sh logs --release <log>"
  local name="${2#/opt/comp/logs/}" offset=0 total page
  [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z-[a-z-]+(-[0-9a-f]{12})?\.log$ ]] ||
    die "'$2' is not a release log (/opt/comp/logs/<utc>-<step>[-<sha12>].log)"
  require_local aws python3
  connect
  TAG=""
  : >"$WORK/log"
  while :; do
    REMOTE_QUIET=1 remote "comp release.sh logs" 120 status log "$name" "$offset"
    [[ "$REMOTE_CODE" -eq 0 ]] || die "could not read /opt/comp/logs/$name"
    total="$(result_of total)" page="$(result_of page)"
    [[ -n "$page" ]] || break
    python3 -c 'import base64, sys; sys.stdout.buffer.write(base64.b64decode(sys.argv[1]))' "$page" >>"$WORK/log"
    offset="$(wc -c <"$WORK/log" | tr -d ' ')"
    ((offset < total)) || break
  done
  cat "$WORK/log"
}

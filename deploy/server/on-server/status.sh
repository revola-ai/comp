#!/usr/bin/env bash
# Read-only server side of `deploy/server/release.sh status`, `rollback` (to learn the tags) and
# `logs --release`. release.sh sends lib/server-common.sh and this file as the text of one SSM
# command; it runs as root, takes no lock and writes nothing:
#
#   status.sh show                 current and previous tag, the lease, the comp containers with
#                                  their health, the last 10 lines of releases.log, disk use of /
#   status.sh tags                 only comp-result: current=... and previous=...
#   status.sh log <name> <offset>  bytes <offset>.. (at most 15000, base64) of the last 500 lines
#                                  of /opt/comp/logs/<name>, with the total size; release.sh
#                                  pages through them because SSM keeps 24000 characters
if [[ "$(type -t meta)" != function ]]; then
  # shellcheck source=deploy/server/lib/server-common.sh
  source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-common.sh"
fi
set -uo pipefail

show() {
  echo "current: $(current_tag)"
  echo "previous: $(previous_tag)"
  if lease_live; then
    echo "between steps: $LEASE_WHAT (run $LEASE_HOLDER), for up to $((LEASE_EXPIRES - $(date +%s))) more seconds"
  fi
  echo
  echo "Containers of the comp project:"
  docker ps --all --filter label=com.docker.compose.project=comp \
    --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' || echo "(docker ps failed)"
  echo
  echo "Last releases ($RELEASES_LOG):"
  if [[ -f "$RELEASES_LOG" ]]; then tail -n 10 "$RELEASES_LOG"; else echo "(none yet)"; fi
  echo
  df -h /
}

page() { # page <name> <offset>
  local path="$COMP_LOGS/$1"
  if [[ "$1" != *.log || ! "${1%.log}" =~ $STEP_NAME_RE || -L "$path" || ! -f "$path" || ! "$2" =~ ^[0-9]+$ ]]; then
    echo "no release log $1 in $COMP_LOGS"
    return 1
  fi
  PAGE_TOTAL="$(tail -n 500 "$path" | wc -c | tr -d ' ')"
  # head stops reading early, so the tails before it may die of SIGPIPE: not a failure here.
  PAGE_DATA="$(set +o pipefail; tail -n 500 "$path" | tail -c +"$(($2 + 1))" | head -c 15000 | base64 | tr -d '\n')"
}

status=0 PAGE_TOTAL="" PAGE_DATA=""
case "${1:-}" in
  show) show || status=$? ;;
  tags) ;;
  log) page "${2:-}" "${3:-}" || status=$? ;;
  *) echo "usage: status.sh show | tags | log <name> <offset>"; status=2 ;;
esac
echo comp-meta-begin
result "current=$(current_tag)"
result "previous=$(previous_tag)"
[[ -z "$PAGE_TOTAL" ]] || result "total=$PAGE_TOTAL"
[[ -z "$PAGE_TOTAL" ]] || result "page=$PAGE_DATA"
echo "comp-end: $status"
exit "$status"

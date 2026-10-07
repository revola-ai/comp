#!/usr/bin/env bash
# Releases Comp to the tunnel server (deploy/server/README.md, Releasing), from a laptop with
# AWS credentials for account 455986776194:
#
#   deploy/server/release.sh release <sha>                    build, check migrations, up, smoke
#   deploy/server/release.sh rollback [<sha>]                 back to an earlier release's images
#   deploy/server/release.sh migrate <sha>                    apply its migrations (typed: migrate)
#   deploy/server/release.sh trigger <sha> [--project api|app]  deploy Trigger.dev prod (typed: trigger)
#   deploy/server/release.sh status                           tags, containers, last releases, disk
#   deploy/server/release.sh logs <service> | --release <log> the logs tail command, or a step's log
#   deploy/server/release.sh prune                            remove old images (typed: prune)
#   deploy/server/release.sh unlock                           free a lease a stopped run left (typed: unlock)
#
# It drives the server (the one running instance named comp-server) through SSM Run Command,
# never SSH: each step's script runs there as root (deploy/server/on-server/), its full log
# goes to /opt/comp/logs, and this prints the log's end. A <sha> must be on a branch of the fork
# revola-ai/comp (the server fetches from it); its 12-character prefix is the image tag. A
# server lock runs one step at a time. The smoke checks run from here, against the public
# hosts. It never reads, prints or sends a secret: the server reads them from Secrets Manager.
# Needs bash 4 or newer, aws, git, python3 and curl.
if ((BASH_VERSINFO[0] < 4)); then
  echo "release: release.sh needs bash 4 or newer (this is $BASH_VERSION; brew install bash)" >&2
  exit 1
fi
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVER_DIR/../.." && pwd)"
TOOL_NAME=release
ACCOUNT=455986776194
REGION=us-east-2
NAME=comp-server
SERVICES=(api app portal cloudflared)
export AWS_PAGER=""

# shellcheck source=deploy/server/lib/provision-common.sh
source "$SERVER_DIR/lib/provision-common.sh"
# shellcheck source=deploy/server/lib/server-common.sh
source "$SERVER_DIR/lib/server-common.sh" # COMP_REPO_URL
# shellcheck source=deploy/server/lib/release-remote.sh
source "$SERVER_DIR/lib/release-remote.sh"
# shellcheck source=deploy/server/lib/release-flow.sh
source "$SERVER_DIR/lib/release-flow.sh"
# shellcheck source=deploy/server/lib/release-ops.sh
source "$SERVER_DIR/lib/release-ops.sh"
# shellcheck source=deploy/server/lib/release-interrupt.sh
source "$SERVER_DIR/lib/release-interrupt.sh" # traps INT, TERM and HUP

usage() {
  sed -n 's/^#   deploy/  deploy/p' "${BASH_SOURCE[0]}"
}

[[ $# -ge 1 ]] || { usage >&2; exit 2; }
command="$1"
shift
case "$command" in
  release) cmd_release "$@" ;;
  rollback) cmd_rollback "$@" ;;
  migrate) cmd_migrate "$@" ;;
  trigger) cmd_trigger "$@" ;;
  status) cmd_status "$@" ;;
  logs) cmd_logs "$@" ;;
  prune) cmd_prune "$@" ;;
  unlock) cmd_unlock "$@" ;;
  -h | --help) usage ;;
  *) usage >&2; exit 2 ;;
esac

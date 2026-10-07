#!/usr/bin/env bash
# Server side of `deploy/server/release.sh prune`, run as root by on-server/entry.sh (which
# holds the server lock) from /opt/comp/src:
#
#   prune.sh plan            prints what is kept and what would go (comp-result: remove=...)
#   prune.sh apply <ref>...  removes those of <ref> that would still go, then trims the build
#                            cache to 20 GB (docker builder prune --keep-storage 20GB -f)
#
# Only comp-api, comp-app, comp-portal and comp-migrate images are ever removed. Kept: the tags
# of the current release and the last 3 other ok releases (releases.log), and the image of
# every container of the comp project, running or stopped. The pinned cloudflared image is
# never a candidate (it is not comp-*), so it stays even when its container is gone; Docker
# shows it untagged, which is why this never runs `docker image prune`. The laptop asks for
# the typed confirmation between the two steps.
# shellcheck source=deploy/server/lib/server-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-common.sh"
# shellcheck source=deploy/server/lib/server-stack.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-stack.sh"
set -uo pipefail

CANDIDATE_RE='^comp-(api|app|portal|migrate):[0-9a-f]{12}$'
KEEP_TAGS=4 # the current tag and the last 3 others

# removable: prints, one per line, every comp-* image outside the kept tags and unused by a
# container of the project. Fails when docker cannot be read.
removable() {
  local keep in_use images ref
  keep="$(ok_tags | sed -n "1,${KEEP_TAGS}p")"
  in_use="$(docker ps --all --filter label=com.docker.compose.project=comp --format '{{.Image}}')" || return 1
  images="$(docker image ls --format '{{.Repository}}:{{.Tag}}')" || return 1
  while read -r ref; do
    [[ "$ref" =~ $CANDIDATE_RE ]] || continue
    grep -qxF -- "${ref#*:}" <<<"$keep" && continue
    grep -qxF -- "$ref" <<<"$in_use" && continue
    echo "$ref"
  done <<<"$images"
}

plan() {
  local remove tunnel ref
  remove="$(removable)" || { echo "could not list the images or containers"; return 1; }
  tunnel="$(grep -oE 'docker\.io/cloudflare/cloudflared:[^@[:space:]]+@sha256:[0-9a-f]{64}' "$COMPOSE_FILE" | head -n 1)"
  echo "Keeping the tags of the current release and the last 3 others: $(ok_tags | sed -n "1,${KEEP_TAGS}p" | tr '\n' ' ')"
  echo "Keeping the images of the comp containers: $(docker ps --all --filter label=com.docker.compose.project=comp --format '{{.Image}}' | tr '\n' ' ')"
  echo "Keeping the pinned cloudflared image: ${tunnel:-(not found in compose.yaml)}"
  if [[ -n "$remove" ]]; then
    echo "Removing:"
    while read -r ref; do echo "  $ref"; done <<<"$remove"
  else
    echo "Removing no image."
  fi
  echo "Then trimming the build cache to 20 GB: docker builder prune --keep-storage 20GB -f"
  result "remove=$(tr '\n' ' ' <<<"$remove" | sed 's/ *$//')"
}

apply() {
  local remove ref status=0
  remove="$(removable)" || { echo "could not list the images or containers"; return 1; }
  for ref in "$@"; do
    [[ "$ref" =~ $CANDIDATE_RE ]] || { echo "skipping $ref: not a comp image"; continue; }
    grep -qxF -- "$ref" <<<"$remove" || { echo "skipping $ref: kept now"; continue; }
    docker image rm "$ref" || { echo "could not remove $ref"; status=1; }
  done
  echo "== docker builder prune --keep-storage 20GB -f"
  docker builder prune --keep-storage 20GB -f || status=1
  df -h / || true
  return "$status"
}

case "${1:-}" in
  plan) plan ;;
  apply) shift && apply "$@" ;;
  *) echo "usage: prune.sh plan | apply <ref>..." >&2; exit 2 ;;
esac

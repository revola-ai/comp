#!/usr/bin/env bash
# Server side of `deploy/server/release.sh prune`, run as root by on-server/entry.sh (which
# holds the server lock) from /opt/comp/src:
#
#   prune.sh plan            prints what is kept and what would go (comp-result: remove=...)
#   prune.sh apply <ref>...  removes those of <ref> that would still go, then trims the build
#                            cache to 20 GB (docker builder prune --keep-storage 20GB -f)
#   prune.sh auto            after a release (on-server/release.sh finish), with no confirmation:
#                            when / is more than 70% used, removes everything `plan` would list,
#                            then trims the build cache; otherwise does nothing
#
# Only comp-api, comp-app, comp-portal and comp-migrate images are ever removed. Kept: the tags
# of the current release and the last 3 other ok releases (releases.log), the default rollback
# target (the entry below the top of the serving history), and the image of
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

kept_tags() { # the 4 newest distinct ok tags and the default rollback target, each once
  { recent_ok_tags | sed -n "1,${KEEP_TAGS}p"; previous_tag; } | awk 'NF && !seen[$0]++'
}

# removable: prints, one per line, every comp-* image outside the kept tags and unused by a
# container of the project. Fails when docker cannot be read.
removable() {
  local keep in_use images ref
  keep="$(kept_tags)"
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
  echo "Keeping the tags of the current release, the last 3 others and the rollback target: $(kept_tags | tr '\n' ' ')"
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
    if docker image rm "$ref" >/dev/null; then echo "removed $ref"; else echo "could not remove $ref"; status=1; fi
  done
  echo "== docker builder prune --keep-storage 20GB -f"
  docker builder prune --keep-storage 20GB -f || status=1
  df -h / || true
  return "$status"
}

auto() {
  local use remove
  use="$(root_use_percent)"
  [[ "$use" =~ ^[0-9]+$ ]] || { echo "could not read the disk use of / (df -P /)"; return 1; }
  if ((use <= DISK_PRUNE_PERCENT)); then
    echo "Disk: / is $use% used: nothing pruned."
    return 0
  fi
  echo "Disk: / is $use% used, over $DISK_PRUNE_PERCENT%: removing old images by the rules of release.sh prune."
  remove="$(removable)" || { echo "could not list the images or containers"; return 1; }
  [[ -n "$remove" ]] || echo "No image to remove."
  # shellcheck disable=SC2086 # one image ref per word
  apply $remove
}

case "${1:-}" in
  plan) plan ;;
  apply) shift && apply "$@" ;;
  auto) auto ;;
  *) echo "usage: prune.sh plan | apply <ref>... | auto" >&2; exit 2 ;;
esac

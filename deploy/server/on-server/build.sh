#!/usr/bin/env bash
# Server side of the first step of `deploy/server/release.sh release`, run as root by
# on-server/entry.sh (which holds the server lock) from its worktree of the release's SHA:
#
#   build.sh <sha12>   builds comp-{api,app,portal,migrate}:<sha12> from that checkout, one at a
#                      time, skipping the images already built
#
# A build changes nothing that serves (comp-result: changed=no, whatever happens), so release.sh
# cancels it on an interrupt (the next release of the SHA skips what was built), and it holds no
# lease: another step may run between it and the up step (on-server/release.sh up), which is
# harmless, because the up step checks everything again under the lock before any container
# changes: that the images exist, the configuration, the migrations. A failed build is recorded
# as a failed release.
# shellcheck source=deploy/server/lib/server-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-common.sh"
# shellcheck source=deploy/server/lib/server-stack.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-stack.sh"
set -uo pipefail

if [[ $# -ne 1 || ! "$1" =~ $TAG_RE ]]; then
  echo "usage: build.sh <sha12>" >&2
  exit 2
fi
tag="$1"

result "changed=no"
if ! build_images "$tag" "${STACK_IMAGES[@]}" migrate; then
  echo "Building the images of $tag failed; no container was changed."
  record release "$tag" failed
  exit 1
fi
echo "The images of $tag are built; the up step brings it up next."

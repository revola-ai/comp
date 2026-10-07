#!/usr/bin/env bash
# Server side of `deploy/server/release.sh trigger`, run as root by on-server/entry.sh (which
# holds the server lock) from /opt/comp/src checked out at the commit:
#
#   trigger.sh <sha12> <api|app>...
#
# Deploys each project's Trigger.dev tasks to its prod environment, in that order, with the
# pinned CLI in a one-off container of comp-migrate:<sha12> (built when missing), from
# /repo/apps/<project>. The CLI builds remotely by default. Its env comes from trigger.env:
# TRIGGER_ACCESS_TOKEN, and TRIGGER_PROJECT_REF set from TRIGGER_PROJECT_REF_<API|APP> inside
# the container, which overrides the upstream ref in trigger.config.ts; no value is ever on a
# command line. Refuses before deploying anything when a ref is still an upstream Comp AI
# project. The tasks' own env vars live in the Trigger.dev dashboard (README, Releasing).
# shellcheck source=deploy/server/lib/server-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-common.sh"
# shellcheck source=deploy/server/lib/server-stack.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-stack.sh"
set -uo pipefail

TRIGGER_CLI=trigger.dev@4.4.3 # equals "trigger.dev" in apps/api and apps/app package.json
UPSTREAM_REFS=(proj_zhioyrusqertqgafqgpj proj_lhxjliiqgcdyqbgtucda)

usage() {
  echo "usage: trigger.sh <sha12> <api|app>..." >&2
  exit 2
}
[[ $# -ge 2 && "$1" =~ $TAG_RE ]] || usage
tag="$1"
shift
for project in "$@"; do
  [[ "$project" == api || "$project" == app ]] || usage
done

build_images "$tag" migrate || exit 1
render_env || exit 1

for project in "$@"; do # every ref is checked before anything is deployed
  name="TRIGGER_PROJECT_REF_${project^^}"
  line="$(grep -m 1 "^$name=" "$COMP_ENV_DIR/trigger.env")" || line=""
  value="${line#*=}"
  if [[ -z "$value" ]]; then
    echo "REFUSING: $name is missing from trigger.env (render-env.sh)."
    record trigger "$tag" failed
    exit 1
  fi
  for upstream in "${UPSTREAM_REFS[@]}"; do
    if [[ "$value" == "$upstream" ]]; then
      echo "REFUSING: $name is still the upstream Comp AI project ($upstream); set your own project's ref in comp/production/config."
      record trigger "$tag" failed
      exit 1
    fi
  done
done

for project in "$@"; do
  name="TRIGGER_PROJECT_REF_${project^^}"
  echo "== $TRIGGER_CLI deploy --env prod, apps/$project ($name)"
  # shellcheck disable=SC2016 # expanded by the container's shell
  if ! tools "$tag" -w "/repo/apps/$project" trigger \
    sh -c 'export TRIGGER_PROJECT_REF="$'"$name"'"; exec npx --yes '"$TRIGGER_CLI"' deploy --env prod'; then
    echo "The Trigger.dev deploy of $project failed (above); nothing after it was deployed."
    record trigger "$tag" failed
    exit 1
  fi
done
record trigger "$tag" ok
echo "Deployed Trigger.dev prod: $* from $tag."

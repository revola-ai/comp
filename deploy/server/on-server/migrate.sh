#!/usr/bin/env bash
# Server side of `deploy/server/release.sh migrate`, run as root by on-server/entry.sh (which
# holds the server lock) from /opt/comp/src checked out at the commit:
#
#   migrate.sh status <sha12>   builds comp-migrate:<sha12> when missing, renders the env files
#                               and prints the migration status (comp-result: migrations=...)
#   migrate.sh deploy <sha12>   the same, then, when migrations are pending, `prisma migrate
#                               deploy` in a one-off comp-migrate container with
#                               COMP_I_AM_TOUCHING_PROD=1, and the status again
#
# Prisma reads DATABASE_URL from migrate.env (the secret's DATABASE_MIGRATION_URL) and verifies
# TLS against the Supabase CA in the image (VERIFIED_URL in lib/server-stack.sh); the guard in
# packages/db/prisma.config.ts still checks the target. The laptop asks for the typed
# confirmation between the two steps. Attempts of deploy are recorded in releases.log.
# shellcheck source=deploy/server/lib/server-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-common.sh"
# shellcheck source=deploy/server/lib/server-stack.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/server-stack.sh"
set -uo pipefail

if [[ $# -ne 2 || ! "$1" =~ ^(status|deploy)$ || ! "$2" =~ $TAG_RE ]]; then
  echo "usage: migrate.sh status|deploy <sha12>" >&2
  exit 2
fi
step="$1" tag="$2"

build_images "$tag" migrate || exit 1
render_env || exit 1
migration_status "$tag"
case "$MIGRATIONS" in
  up-to-date) echo "Nothing to apply: the database has every migration of $tag."; exit 0 ;;
  pending) [[ "$step" == deploy ]] || exit 0 ;;
  failed) echo "A migration failed (above); resolve it by hand (prisma migrate resolve) first."; exit 1 ;;
  *) echo "Could not read the migration status (above)."; exit 1 ;;
esac

echo "== prisma migrate deploy (comp-migrate:$tag, COMP_I_AM_TOUCHING_PROD=1)"
if ! tools "$tag" -e COMP_I_AM_TOUCHING_PROD=1 migrate sh -c "${VERIFIED_URL}exec bunx prisma migrate deploy"; then
  record migrate "$tag" failed
  echo "prisma migrate deploy failed (above); the status follows."
  migration_status "$tag"
  exit 1
fi
migration_status "$tag"
if [[ "$MIGRATIONS" != up-to-date ]]; then
  record migrate "$tag" failed
  echo "The migrations ran, but the status is $MIGRATIONS (above)."
  exit 1
fi
record migrate "$tag" ok
echo "Applied: the database has every migration of $tag."

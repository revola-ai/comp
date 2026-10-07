# shellcheck shell=bash
# The compose stack and the images, for the scripts in deploy/server/on-server/ (sourced after
# lib/server-common.sh, never run on its own). Runs as root on the server, from the checkout
# in /opt/comp/src; REPO is that checkout.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE_FILE="$REPO/deploy/server/compose.yaml"
BAKE_FILE=deploy/aws/docker-bake.hcl # relative to REPO, where bake runs

# The URL Prisma's schema engine reads, with TLS verified against the image's Supabase CA:
# sslmode=require (TLS or no connection), sslcert=<the CA> (the root it verifies against) and
# sslaccept=strict (check the chain and the host). Without them it accepts any certificate.
# Runs inside the tools container, where DATABASE_URL is the migration URL (migrate.env);
# neither value ever appears in a command line.
# shellcheck disable=SC2016 # expanded by the container's shell
VERIFIED_URL='url="$(node -e '"'"'const u = new URL(process.env.DATABASE_URL); u.searchParams.delete("sslrootcert"); u.searchParams.set("sslmode","require"); u.searchParams.set("sslcert",process.env.DATABASE_SSL_CA); u.searchParams.set("sslaccept","strict"); process.stdout.write(u.toString())'"'"')" && export DATABASE_URL="$url" && '

# compose <tag> <compose args...>: compose of this checkout with TAG=<tag>, as root.
compose() {
  local tag="$1"
  shift
  env TAG="$tag" COMP_ENV_DIR="$COMP_ENV_DIR" docker compose -f "$COMPOSE_FILE" "$@"
}

# tools <tag> <run args...>: a one-off container of the tools image (profile tools); the
# unhealthy-container timer leaves one-off containers alone.
tools() {
  local tag="$1"
  shift
  compose "$tag" --profile tools run --rm -T --no-deps "$@"
}

up_wait() { # up_wait <tag>: replaces the stack's containers and waits until all are healthy
  echo "== compose up $1 (waits up to 600 s for every healthcheck)"
  compose "$1" up -d --no-build --wait --wait-timeout 600
}

render_env() {
  echo "== render-env.sh"
  "$REPO/deploy/server/render-env.sh" --out-dir "$COMP_ENV_DIR"
}

missing_images() { # missing_images <tag> <name>...: prints each comp-<name>:<tag> that is not here
  local tag="$1" name
  shift
  for name in "$@"; do
    docker image inspect "comp-$name:$tag" >/dev/null 2>&1 || echo "comp-$name:$tag"
  done
}

# build_images <tag> <name>...: builds each missing comp-<name>:<tag> from this checkout, one
# at a time (the host has the memory for one Next.js build), with no registry.
build_images() {
  local tag="$1" name
  shift
  for name in "$@"; do
    if docker image inspect "comp-$name:$tag" >/dev/null 2>&1; then
      echo "== comp-$name:$tag is already built"
      continue
    fi
    echo "== building comp-$name:$tag"
    if ! (cd "$REPO" && env TAG="$tag" REGISTRY= docker buildx bake -f "$BAKE_FILE" --load "$name"); then
      echo "building comp-$name:$tag failed (above)"
      return 1
    fi
  done
}

# migration_status <tag>: runs `prisma migrate status` in comp-migrate:<tag> against the
# migration URL, prints its output and sets MIGRATIONS to up-to-date, pending, failed or
# unknown (it could not tell: the database was unreachable or Prisma failed otherwise).
migration_status() {
  local output status=0
  echo "== prisma migrate status (comp-migrate:$1)"
  output="$(tools "$1" migrate sh -c "${VERIFIED_URL}exec bunx prisma migrate status" 2>&1)" || status=$?
  printf '%s\n' "$output"
  if [[ "$status" -eq 0 && "$output" == *"Database schema is up to date"* ]]; then
    MIGRATIONS=up-to-date
  elif [[ "$output" == *"have failed"* ]]; then
    MIGRATIONS=failed
  elif [[ "$output" == *"have not yet been applied"* ]]; then
    MIGRATIONS=pending
  else
    MIGRATIONS=unknown
  fi
  result "migrations=$MIGRATIONS"
}

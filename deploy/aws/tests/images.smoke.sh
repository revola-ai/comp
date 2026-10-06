#!/usr/bin/env bash
# Builds the api, app and portal images (linux/arm64) from deploy/aws/docker-bake.hcl one
# after another, loads them, and checks each the way ECS runs it. Takes 20+ minutes cold.
#
#   API_ENV_FILE=/path/to/apps/api/.env bash deploy/aws/tests/images.smoke.sh
#
# API_ENV_FILE (default <repo>/apps/api/.env) is sourced only inside a subshell and its
# variables reach the api container by name (-e NAME); no value is ever printed. The
# readiness check runs SELECT 1 against the database that file points at.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BAKE_FILE="$ROOT/deploy/aws/docker-bake.hcl"
BUILDER="${COMP_BUILDER:-comp-builder}"
TAG="${TAG:-smoke}"
API_ENV_FILE="${API_ENV_FILE:-$ROOT/apps/api/.env}"
CA_PATH=/app/certs/supabase-ca.crt
API_HOST=api.comp.revola.ai
# Variables the image itself sets; the env file must not override them.
IMAGE_OWNED_ENV=" DATABASE_SSL_CA PRISMA_ALLOW_INSECURE_TLS NODE_ENV PORT HOSTNAME "
# Throwaway values for the app and portal runtime env checks (a local, unreachable database).
FAKE_DATABASE_URL=postgresql://smoke:smoke@127.0.0.1:5432/smoke

# Size ceilings in MB of unpacked filesystem (du inside the image, the same on every image
# store): the first green run's sizes plus about 15%. api 2276 MB and portal 342 MB were
# measured 2026-10-06; the app has not been built yet (its next build needs more memory
# than an 8 GB Docker VM), so its ceiling is unrecorded and the check fails until it is.
max_mb() {
  case "$1" in
    api) echo 2620 ;;
    app) echo 0 ;;
    portal) echo 395 ;;
  esac
}

FAILURES=0
CONTAINERS=()
SCRATCH="$(mktemp -d)"
cleanup() {
  for container in ${CONTAINERS[@]+"${CONTAINERS[@]}"}; do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

pass() { printf 'PASS  %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}
check() {
  local label="$1"
  shift
  if "$@"; then pass "$label"; else fail "$label"; fi
}

image_of() { printf 'comp-%s:%s' "$1" "$TAG"; }

ensure_builder() {
  docker buildx inspect "$BUILDER" >/dev/null 2>&1 && return 0
  docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
}

# Bake resolves the build context against the working directory, so it runs from the root.
bake() {
  (cd "$ROOT" && TAG="$TAG" REGISTRY="" docker buildx bake --builder "$BUILDER" -f "$BAKE_FILE" "$@")
}

build_images() {
  local target
  for target in api app portal; do
    printf '== building %s\n' "$target"
    if ! bake --load "$target"; then
      fail "build $target"
      return 1
    fi
    pass "build $target"
  done
}

public_env_matches_bake() {
  bake --print app portal >"$SCRATCH/bake.json" 2>/dev/null &&
    (cd "$ROOT/deploy/aws" && bun public-env.ts check "$SCRATCH/bake.json")
}

node_is_22() {
  local version
  version="$(docker run --rm --entrypoint node "$(image_of "$1")" -v)"
  [[ "$version" == v22.* ]]
}

ca_is_committed_cert() {
  local inside committed
  inside="$(docker run --rm --entrypoint sh "$(image_of "$1")" -c \
    "[ \"\$DATABASE_SSL_CA\" = $CA_PATH ] && cat $CA_PATH" | shasum -a 256 | cut -d' ' -f1)"
  committed="$(shasum -a 256 <"$ROOT/deploy/aws/certs/supabase-ca.crt" | cut -d' ' -f1)"
  [[ "$inside" == "$committed" ]]
}

runs_as_non_root() {
  local user
  user="$(docker image inspect --format '{{.Config.User}}' "$(image_of "$1")")"
  [[ -n "$user" && "$user" != root && "$user" != 0 && "$user" != 0:* ]]
}

no_skip_env_validation() {
  ! docker image inspect --format '{{json .Config.Env}}' "$(image_of "$1")" |
    grep -q SKIP_ENV_VALIDATION
}

image_mb() {
  docker run --rm --user root --entrypoint du "$(image_of "$1")" -sxm / | cut -f1
}

under_size_ceiling() {
  local size ceiling
  size="$(image_mb "$1")"
  ceiling="$(max_mb "$1")"
  printf '      %s image: %s MB (ceiling %s MB)\n' "$1" "$size" "$ceiling"
  ((size <= ceiling))
}

container_of() { printf 'comp-smoke-%s-%s' "$1" "$$"; }

# Starts the target's container detached with port $2 published on a random loopback port
# and prints the host port. Remaining arguments go to docker run before the image. Callers
# register container_of <target> in CONTAINERS first (this runs in a command substitution).
start() {
  local target="$1" port="$2" name
  shift 2
  name="$(container_of "$target")"
  docker run -d --name "$name" -p "127.0.0.1::$port" "$@" "$(image_of "$target")" >/dev/null
  docker port "$name" "$port/tcp" | head -n1 | sed 's/.*://'
}

# Polls URL until it answers 200 or 60 seconds pass; leaves the last body in $SCRATCH/body.
answers_200() {
  local url="$1" code=""
  for _ in $(seq 1 60); do
    code="$(curl -s -o "$SCRATCH/body" -w '%{http_code}' --max-time 5 "$url" || true)"
    [[ "$code" == 200 ]] && return 0
    sleep 1
  done
  printf '      %s answered %s: %s\n' "$url" "${code:-nothing}" "$(head -c 300 "$SCRATCH/body" 2>/dev/null)"
  return 1
}

FAKE_NEXT_ENV=(-e "DATABASE_URL=$FAKE_DATABASE_URL" -e AUTH_SECRET=smoke-only
  -e RESEND_API_KEY=smoke-only -e REVALIDATION_SECRET=smoke-only)

check_portal() {
  local port
  CONTAINERS+=("$(container_of portal)")
  port="$(start portal 3000 "${FAKE_NEXT_ENV[@]}")"
  check "portal answers /api/health with 200" answers_200 "http://127.0.0.1:$port/api/health"
  check_bundle portal
}

static_chunk_answers() {
  local base="$1" chunk
  curl -sL --max-time 30 -o "$SCRATCH/root.html" "$base/" || return 1
  chunk="$(grep -oE '/_next/static/[^"]+\.js' "$SCRATCH/root.html" | head -n1)"
  [[ -n "$chunk" ]] || return 1
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "$base$chunk")" == 200 ]]
}

image_optimizer_answers() {
  local url="$1/_next/image?url=%2Ffavicon-96x96.png&w=64&q=75"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$url")" == 200 ]]
}

# Counts fixed-string matches of $2 across the target's client bundle (.next/static).
bundle_count() {
  docker run --rm --entrypoint sh "$(image_of "$1")" -c \
    'grep -rhoF -- "$1" "apps/$2/.next/static" | wc -l' _ "$2" "$1"
}

# The client bundle carries the API host as the compiled NEXT_PUBLIC_API_URL value.
bundle_has_api_url() {
  (($(bundle_count "$1" "NEXT_PUBLIC_API_URL:\"https://$API_HOST\"") > 0))
}

# localhost:3333 may appear only as the dead fallback in `env.NEXT_PUBLIC_API_URL ||
# 'http://localhost:3333'` (the env object holds the compiled API URL, checked above); a
# fallback minifies away only where code reads process.env directly.
bundle_has_no_localhost_api() {
  local total fallbacks
  total="$(bundle_count "$1" localhost:3333)"
  fallbacks="$(bundle_count "$1" 'NEXT_PUBLIC_API_URL||"http://localhost:3333"')"
  printf '      %s: %s localhost:3333 literal(s), %s of them env fallbacks\n' "$1" "$total" "$fallbacks"
  ((total == fallbacks))
}

check_bundle() {
  check "$1 client bundle compiles NEXT_PUBLIC_API_URL as https://$API_HOST" bundle_has_api_url "$1"
  check "$1 client bundle uses localhost:3333 only as a dead env fallback" \
    bundle_has_no_localhost_api "$1"
}

check_app() {
  local port base
  CONTAINERS+=("$(container_of app)")
  port="$(start app 3000 "${FAKE_NEXT_ENV[@]}")"
  base="http://127.0.0.1:$port"
  check "app answers /api/health/live with 200" answers_200 "$base/api/health/live"
  check "app serves a static chunk referenced by /" static_chunk_answers "$base"
  check "app answers a /_next/image request with 200" image_optimizer_answers "$base"
  check_bundle app
}

# Prints the names (never values) the env file assigns, minus the ones the image owns.
env_file_names() {
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)= ]] || continue
    [[ "$IMAGE_OWNED_ENV" == *" ${BASH_REMATCH[1]} "* ]] && continue
    printf '%s\n' "${BASH_REMATCH[1]}"
  done <"$API_ENV_FILE"
}

# -e NAME for every name in the env file; docker run reads the values from the environment
# of the subshell that sourced the file (see with_env_file).
API_ENV_ARGS=()
load_api_env_names() {
  local name
  [[ -f "$API_ENV_FILE" ]] || { printf '      API_ENV_FILE not found\n'; return 1; }
  API_ENV_ARGS=()
  while IFS= read -r name; do API_ENV_ARGS+=(-e "$name"); done < <(env_file_names)
}

# Runs a command with the env file's variables exported, in a subshell, so no value
# reaches this shell or its output.
with_env_file() {
  (
    set -a
    # shellcheck disable=SC1090
    source "$API_ENV_FILE" >/dev/null 2>&1
    set +a
    "$@"
  )
}

api_ready_with_env_file() {
  local port
  load_api_env_names || return 1
  CONTAINERS+=("$(container_of api)")
  port="$(with_env_file start api 3333 "${API_ENV_ARGS[@]}" -e NODE_ENV=production)"
  answers_200 "http://127.0.0.1:$port/v1/health/ready"
}

# The api must stop at boot, before connecting, when production has no CA. Its output is
# captured and searched, never printed (the container gets the real env file values).
api_exits_without_ca() {
  local name="comp-smoke-api-noca-$$" state="" code logs
  load_api_env_names || return 1
  CONTAINERS+=("$name")
  with_env_file docker run -d --name "$name" "${API_ENV_ARGS[@]}" -e NODE_ENV=production \
    -e DATABASE_SSL_CA= -e PRISMA_ALLOW_INSECURE_TLS= "$(image_of api)" >/dev/null || return 1
  for _ in $(seq 1 60); do
    state="$(docker inspect --format '{{.State.Status}}' "$name")"
    [[ "$state" == exited ]] && break
    sleep 1
  done
  [[ "$state" == exited ]] || { printf '      still running after 60 s\n'; return 1; }
  code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
  logs="$(docker logs "$name" 2>&1 >/dev/null)"
  printf '      exit code %s\n' "$code"
  [[ "$code" != 0 && "$logs" == *ca_file_missing* ]]
}

main() {
  command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
  ensure_builder
  check "every NEXT_PUBLIC_ key read in code is a bake arg or intentionally unset" \
    public_env_matches_bake
  build_images || { printf '%s check(s) failed\n' "$FAILURES"; exit 1; }
  local target
  for target in api app portal; do
    check "$target runs node 22" node_is_22 "$target"
    check "$target carries the committed CA at $CA_PATH" ca_is_committed_cert "$target"
    check "$target runs as a non-root user" runs_as_non_root "$target"
    check "$target has no SKIP_ENV_VALIDATION in its runtime env" no_skip_env_validation "$target"
    check "$target is under its size ceiling" under_size_ceiling "$target"
  done
  check_portal
  check_app
  check "api answers /v1/health/ready with 200 using API_ENV_FILE" api_ready_with_env_file
  check "api exits with ca_file_missing when DATABASE_SSL_CA is empty" api_exits_without_ca
  if ((FAILURES > 0)); then
    printf '%s check(s) failed\n' "$FAILURES"
    exit 1
  fi
  echo "all image checks passed"
}

main "$@"

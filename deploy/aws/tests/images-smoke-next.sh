# shellcheck shell=bash
# App and portal checks for images.smoke.sh, which sources this file. It relies on that
# script's globals and helpers (ROOT, CONTAINERS, check, fail, start, container_of,
# image_of, answers_200, SCRATCH).
# shellcheck disable=SC2154

API_HOST=api.comp.revola.ai
# Throwaway values for the app and portal runtime env checks (a local, unreachable database).
FAKE_DATABASE_URL=postgresql://smoke:smoke@127.0.0.1:5432/smoke
FAKE_NEXT_ENV=(-e "DATABASE_URL=$FAKE_DATABASE_URL" -e AUTH_SECRET=smoke-only
  -e RESEND_API_KEY=smoke-only -e REVALIDATION_SECRET=smoke-only)

# Starts a Next image for the HTTP checks and sets NEXT_PORT to its host port. When the
# container does not start it records a FAIL and returns non-zero, and the run continues
# to its summary. Called as a plain statement (it updates FAILURES and CONTAINERS).
NEXT_PORT=""
start_next() {
  local target="$1"
  CONTAINERS+=("$(container_of "$target")")
  NEXT_PORT=""
  if ! NEXT_PORT="$(start "$target" 3000 "${FAKE_NEXT_ENV[@]}")" || [[ -z "$NEXT_PORT" ]]; then
    fail "$target container starts"
    return 1
  fi
}

check_portal() {
  local port
  start_next portal || return 0
  port="$NEXT_PORT"
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

# The runtime image sets every NEXT_PUBLIC_ key public-env.ts gives the target, with its
# value: server code reads them from process.env (getPublicApiUrl, better-auth's origin).
runtime_env_has_public_urls() {
  local expected actual line missing=0
  expected="$(cd "$ROOT/deploy/aws" && bun public-env.ts env "$1")" || return 1
  actual="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$(image_of "$1")")"
  while IFS= read -r line; do
    grep -qxF -- "$line" <<<"$actual" && continue
    printf '      %s runtime env lacks %s\n' "$1" "$line"
    missing=1
  done <<<"$expected"
  ((missing == 0))
}

# localhost:3333 literals allowed in the build output (client and server, .next and
# server.js), each dead because the image compiles and sets NEXT_PUBLIC_API_URL:
#   NEXT_PUBLIC_API_URL||"http://localhost:3333"
#     `env.NEXT_PUBLIC_API_URL || 'http://localhost:3333'` on the t3 env object, whose
#     value is compiled in; the literal survives minification.
#   ("NEXT_PUBLIC_API_URL")??"http://localhost:3333"
#     server-api-base-url.ts: readEnv('NEXT_PUBLIC_API_URL') ?? LOCAL_API_URL, read from
#     the runtime env checked by runtime_env_has_public_urls.
# Any other occurrence (for example a bare "http://localhost:3333" API base) fails.
LOCALHOST_ALLOWED_RE='NEXT_PUBLIC_API_URL("\))?(\|\||\?\?)"http://localhost:3333"'

output_has_no_live_localhost_api() {
  local result total allowed
  result="$(docker run --rm --entrypoint sh "$(image_of "$1")" -c '
    paths="apps/$1/.next apps/$1/server.js"
    total=$(grep -rhoF --exclude-dir=cache localhost:3333 $paths | wc -l)
    allowed=$(grep -rhoE --exclude-dir=cache -- "$2" $paths | wc -l)
    echo "$total $allowed"
    grep -rhoE --exclude-dir=cache ".{0,60}localhost:3333.{0,12}" $paths | grep -vE -- "$2" | head -n5
  ' _ "$1" "$LOCALHOST_ALLOWED_RE")" || return 1
  read -r total allowed <<<"$(head -n1 <<<"$result")"
  printf '      %s: %s localhost:3333 literal(s) in .next and server.js, %s allowlisted\n' \
    "$1" "$total" "$allowed"
  ((total == allowed)) && return 0
  tail -n +2 <<<"$result" | sed 's/^/      not allowlisted: /'
  return 1
}

check_bundle() {
  check "$1 runtime env carries its NEXT_PUBLIC_ URLs" runtime_env_has_public_urls "$1"
  check "$1 client bundle compiles NEXT_PUBLIC_API_URL as https://$API_HOST" bundle_has_api_url "$1"
  check "$1 build output uses localhost:3333 only in allowlisted dead fallbacks" \
    output_has_no_live_localhost_api "$1"
}

check_app() {
  local port base
  start_next app || return 0
  port="$NEXT_PORT"
  base="http://127.0.0.1:$port"
  check "app answers /api/health/live with 200" answers_200 "$base/api/health/live"
  check "app serves a static chunk referenced by /" static_chunk_answers "$base"
  check "app answers a /_next/image request with 200" image_optimizer_answers "$base"
  check_bundle app
}

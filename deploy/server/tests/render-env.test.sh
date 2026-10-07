#!/usr/bin/env bash
# Tests for deploy/server/render-env.sh. Run: bash deploy/server/tests/render-env.test.sh
# `aws` is a stub that returns a fake secret; nothing reaches AWS.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
install_aws_stub

sorted() { printf '%s\n' "$@" | sort; }

SHARED=(
  DATABASE_URL APP_AWS_ENDPOINT APP_AWS_REGION APP_AWS_ACCESS_KEY_ID APP_AWS_SECRET_ACCESS_KEY
  APP_AWS_BUCKET_NAME APP_AWS_ORG_ASSETS_BUCKET UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN
  RESEND_API_KEY COMP_FORWARDED_IP_TOKEN
)
API_AND_APP=(
  APP_AWS_QUESTIONNAIRE_UPLOAD_BUCKET APP_AWS_KNOWLEDGE_BASE_BUCKET SECRET_KEY ENCRYPTION_KEY
  AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET RESEND_FROM_SYSTEM RESEND_FROM_DEFAULT UNSUBSCRIBE_SECRET
  OPENAI_API_KEY ANTHROPIC_API_KEY
)
RUNTIME=(NODE_ENV DATABASE_SSL_CA DATABASE_POOL_MAX)
EXPECTED_API="$(sorted "${SHARED[@]}" "${API_AND_APP[@]}" "${RUNTIME[@]}" \
  INTERNAL_API_TOKEN SERVICE_TOKEN_TRIGGER SERVICE_TOKEN_PORTAL MACED_API_KEY TRIGGER_SECRET_KEY \
  SELF_HOSTED NEXT_PUBLIC_SELF_HOSTED AUTH_COOKIE_DOMAIN AUTH_TRUSTED_ORIGINS \
  AUTH_ALLOWED_EMAIL_DOMAINS BASE_URL APP_URL PORTAL_URL NEXT_PUBLIC_APP_URL NEXT_PUBLIC_API_URL \
  NEXT_PUBLIC_PORTAL_URL TRUSTED_EDGE_PROXY_IPS)"
EXPECTED_APP="$(sorted "${SHARED[@]}" "${API_AND_APP[@]}" "${RUNTIME[@]}" \
  AUTH_SECRET GOOGLE_GENERATIVE_AI_API_KEY REVALIDATION_SECRET TRIGGER_SECRET_KEY BACKEND_API_URL)"
EXPECTED_PORTAL="$(sorted "${SHARED[@]}" "${RUNTIME[@]}" \
  SERVICE_TOKEN_PORTAL BACKEND_API_URL PORTAL_DISABLE_MICROSOFT_SIGN_IN)"
EXPECTED_CLOUDFLARED="TUNNEL_TOKEN"

# ---------------------------------------------------------------- committed files
committed_names_only() { # every .keys line is a comment, NAME or "NAME from KEY"
  ! grep -hvE '^(#.*|[A-Z][A-Z0-9_]*( from [A-Z][A-Z0-9_]*)?)$' "$SERVER_DIR"/env/*.keys
}
public_holds_no_secret_key() { # no secret key name is given a value in a public file
  local key
  for key in "${FIXTURE_KEYS[@]}"; do
    if grep -qE "^$key=" "$SERVER_DIR"/env/*.public.env; then return 1; fi
  done
}
check "keys files hold names only" committed_names_only
check "public env files set no secret key" public_holds_no_secret_key
check "services are api, app, cloudflared and portal" \
  test "$(cd "$SERVER_DIR/env" && printf '%s ' *.keys)" = "api.keys app.keys cloudflared.keys portal.keys "

# ---------------------------------------------------------------- success
OUT="$TMP/out"
write_fixture "$TMP/secret.json"
render "$OUT" "$TMP/ok.log"
status=$?
check "renders with a complete secret" test "$status" -eq 0
check "reads comp/production/config in us-east-2 once" test "$(cat "$AWS_STUB_LOG")" = \
  "secretsmanager get-secret-value --secret-id comp/production/config --region us-east-2 --query SecretString --output text"
check "api has exactly its keys" test "$(names_of "$OUT/api.env")" = "$EXPECTED_API"
check "app has exactly its keys" test "$(names_of "$OUT/app.env")" = "$EXPECTED_APP"
check "portal has exactly its keys" test "$(names_of "$OUT/portal.env")" = "$EXPECTED_PORTAL"
check "cloudflared has exactly its keys" test "$(names_of "$OUT/cloudflared.env")" = "$EXPECTED_CLOUDFLARED"
check "writes no other file (no temporary left)" test "$(files_in "$OUT")" = "api.env app.env cloudflared.env portal.env"
for service in api app portal cloudflared; do
  check "$service.env is 0600" test "$(mode_of "$OUT/$service.env")" = 600
done
check "the env directory is 0700" test "$(mode_of "$OUT")" = 700
check "app never gets INTERNAL_API_TOKEN" bash -c "! grep -q '^INTERNAL_API_TOKEN=' '$OUT/app.env'"
check "portal never gets INTERNAL_API_TOKEN" bash -c "! grep -q '^INTERNAL_API_TOKEN=' '$OUT/portal.env'"
check "values are written verbatim" test "$(value_of "$OUT/api.env" DATABASE_URL)" = "$TRICKY_VALUE"
check "app AUTH_SECRET is SECRET_KEY" test "$(value_of "$OUT/app.env" AUTH_SECRET)" = "$(fake_value SECRET_KEY)"
check "api TRIGGER_SECRET_KEY is the api project key" \
  test "$(value_of "$OUT/api.env" TRIGGER_SECRET_KEY)" = "$(fake_value TRIGGER_SECRET_KEY_API)"
check "app TRIGGER_SECRET_KEY is the app project key" \
  test "$(value_of "$OUT/app.env" TRIGGER_SECRET_KEY)" = "$(fake_value TRIGGER_SECRET_KEY_APP)"
check "no value is printed" bash -c "! grep -q fakesecret '$TMP/ok.log'"

expect_public() { # expect_public <service> <name> <value>
  check "$1 $2=$3" test "$(value_of "$OUT/$1.env" "$2")" = "$3"
}
for service in api app portal; do
  expect_public "$service" NODE_ENV production
  expect_public "$service" DATABASE_SSL_CA /app/certs/supabase-ca.crt
done
expect_public api DATABASE_POOL_MAX 4
expect_public app DATABASE_POOL_MAX 2
expect_public portal DATABASE_POOL_MAX 1
expect_public api SELF_HOSTED true
expect_public api AUTH_COOKIE_DOMAIN .comp.revola.ai
expect_public api AUTH_ALLOWED_EMAIL_DOMAINS revola.ai
expect_public api AUTH_TRUSTED_ORIGINS \
  https://app.comp.revola.ai,https://portal.comp.revola.ai,https://api.comp.revola.ai
expect_public api BASE_URL https://api.comp.revola.ai
expect_public app BACKEND_API_URL http://api:3333
expect_public portal BACKEND_API_URL http://api:3333

# ---------------------------------------------------------------- refusals
refuses() { # refuses <label> <expected-message> <fixture edits...>: nothing written, names only
  local label="$1" message="$2" out="$TMP/refused-$1"
  shift 2
  write_fixture "$TMP/secret.json" "$@"
  render "$out" "$TMP/$label.log"
  local status=$?
  check "$label: exits non-zero" test "$status" -ne 0
  check "$label: names the problem" grep -qF -- "$message" "$TMP/$label.log"
  check "$label: writes no env file" bash -c "! ls '$out'/*.env >/dev/null 2>&1"
  check "$label: prints no value" bash -c "! grep -q fakesecret '$TMP/$label.log'"
}
refuses missing "api: SERVICE_TOKEN_PORTAL is missing from comp/production/config" \
  --drop SERVICE_TOKEN_PORTAL
check "missing: names every service that needs it" \
  grep -qF "portal: SERVICE_TOKEN_PORTAL is missing" "$TMP/missing.log"
refuses renamed "app: TRIGGER_SECRET_KEY_APP is missing from comp/production/config" \
  --drop TRIGGER_SECRET_KEY_APP
refuses empty "api: RESEND_API_KEY is empty in comp/production/config" --set RESEND_API_KEY ""
refuses linebreak "api: OPENAI_API_KEY contains a line break" \
  --set OPENAI_API_KEY $'fakesecret-one\nfakesecret-two'

write_fixture "$TMP/secret.json" --drop TUNNEL_TOKEN
render "$OUT" "$TMP/keep.log"
check "a refused render leaves the previous files unchanged" \
  test "$(value_of "$OUT/cloudflared.env" TUNNEL_TOKEN)" = "$(fake_value TUNNEL_TOKEN)"

write_fixture "$TMP/secret.json"
AWS_STUB_FAIL=1 render "$TMP/aws-failed" "$TMP/aws-failed.log"
status=$?
check "aws failure: exits non-zero" test "$status" -ne 0
check "aws failure: says the secret could not be read" \
  grep -qF "could not read comp/production/config" "$TMP/aws-failed.log"
check "aws failure: writes no env file" bash -c "! ls '$TMP/aws-failed'/*.env >/dev/null 2>&1"

printf 'not json fakesecret' >"$TMP/secret.json"
render "$TMP/not-json" "$TMP/not-json.log"
status=$?
check "invalid JSON: exits non-zero" test "$status" -ne 0
check "invalid JSON: prints none of the secret" bash -c "! grep -q fakesecret '$TMP/not-json.log'"

finish

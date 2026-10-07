#!/usr/bin/env bash
# Refusal paths of deploy/server/render-env.sh that need a malformed secret or a malformed
# copy of the committed env files. Run: bash deploy/server/tests/render-env-refusals.test.sh
# `aws` is a stub that returns a fake secret; nothing reaches AWS. Every refusal must name
# the problem, write no env file and print no value.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
install_aws_stub

# ---------------------------------------------------------------- malformed secret
printf '["fakesecret-in-a-list"]' >"$TMP/list.json"
AWS_STUB_SECRET="$TMP/list.json" render "$TMP/refused-list" "$TMP/list.log"
status=$?
check "non-object JSON: exits non-zero" test "$status" -ne 0
check "non-object JSON: names the problem" \
  grep -qF "comp/production/config is not a JSON object" "$TMP/list.log"
check "non-object JSON: writes no env file" bash -c "! ls '$TMP/refused-list'/*.env >/dev/null 2>&1"
check "non-object JSON: prints no value" bash -c "! grep -q fakesecret '$TMP/list.log'"

refuses number "api: OPENAI_API_KEY is not a string in comp/production/config" \
  --set-json OPENAI_API_KEY 4242
refuses object "api: OPENAI_API_KEY is not a string in comp/production/config" \
  --set-json OPENAI_API_KEY '{"nested": "fakesecret-nested"}'
refuses nul "api: OPENAI_API_KEY contains a line break or NUL" \
  --set-json OPENAI_API_KEY '"fakesecret-a\u0000fakesecret-b"'
refuses carriage "api: OPENAI_API_KEY contains a line break or NUL" \
  --set OPENAI_API_KEY $'fakesecret-a\rfakesecret-b'

# ---------------------------------------------------------------- malformed committed files
# Each case runs a copy of render-env.sh next to an edited copy of deploy/server/env.
with_edited_env() { # with_edited_env <label> <file> <line to append>
  local tree="$TMP/tree-$1"
  mkdir -p "$tree"
  cp -f "$SERVER_DIR/render-env.sh" "$tree/render-env.sh"
  cp -rf "$SERVER_DIR/env" "$tree/env"
  printf '%s\n' "$3" >>"$tree/env/$2"
  RENDER_SCRIPT="$tree/render-env.sh"
}

with_edited_env duplicate portal.keys RESEND_API_KEY
refuses duplicate "portal: RESEND_API_KEY is listed twice"

with_edited_env malformed-keys portal.keys "RESEND_API_KEY=fakesecret-pasted-value"
refuses malformed-keys 'portal.keys line 16 is not NAME or "NAME from KEY"'

with_edited_env lowercase-keys portal.keys "resend_api_key"
refuses lowercase-keys 'portal.keys line 16 is not NAME or "NAME from KEY"'

with_edited_env collision portal.public.env "RESEND_API_KEY=fakesecret-public-copy"
refuses collision "portal: RESEND_API_KEY is set twice (keys and public values)"

with_edited_env malformed-public portal.public.env "fakesecret-without-a-name"
refuses malformed-public "portal.public.env line 11 is not NAME=VALUE"

with_edited_env lowercase-public portal.public.env "lower_name=fakesecret-public"
refuses lowercase-public "portal.public.env line 11 is not NAME=VALUE"

RENDER_SCRIPT="$SERVER_DIR/render-env.sh"
finish

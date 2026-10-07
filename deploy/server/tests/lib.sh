#!/usr/bin/env bash
# Shared helpers for deploy/server/tests/*.test.sh (sourced, never run on its own).
# Every secret in the fixture is fake and contains the marker "fakesecret", so a test can
# prove no value reaches the output by searching for the marker.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVER_DIR="$ROOT/deploy/server"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0

# A value with every character an env file could mangle: $, quotes, " #", braces.
TRICKY_VALUE="postgresql://u:fakesecret\$p'a\"ss #x \${HOME}@pooler:5432/db?sslmode=verify-full"

# Every key of comp/production/config the four services read (names only).
FIXTURE_KEYS=(
  DATABASE_URL APP_AWS_ENDPOINT APP_AWS_REGION APP_AWS_ACCESS_KEY_ID APP_AWS_SECRET_ACCESS_KEY
  APP_AWS_BUCKET_NAME APP_AWS_ORG_ASSETS_BUCKET APP_AWS_QUESTIONNAIRE_UPLOAD_BUCKET
  APP_AWS_KNOWLEDGE_BASE_BUCKET UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN RESEND_API_KEY
  RESEND_FROM_SYSTEM RESEND_FROM_DEFAULT UNSUBSCRIBE_SECRET COMP_FORWARDED_IP_TOKEN SECRET_KEY
  ENCRYPTION_KEY AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET OPENAI_API_KEY ANTHROPIC_API_KEY
  GOOGLE_GENERATIVE_AI_API_KEY INTERNAL_API_TOKEN SERVICE_TOKEN_TRIGGER SERVICE_TOKEN_PORTAL
  REVALIDATION_SECRET MACED_API_KEY TRIGGER_SECRET_KEY_API TRIGGER_SECRET_KEY_APP TUNNEL_TOKEN
  # Present in the secret but read by no container (migrations and Trigger.dev deploys).
  DATABASE_MIGRATION_URL TRIGGER_PROJECT_REF_API TRIGGER_PROJECT_REF_APP
)

check() { # check <name> <command...>: one ok/FAIL line per assertion
  local name="$1"
  shift
  if "$@"; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    failures=$((failures + 1))
  fi
}

finish() {
  if [[ "$failures" -gt 0 ]]; then
    echo "$failures failure(s)"
    exit 1
  fi
  echo "all passed"
}

fake_value() { printf 'fakesecret-%s-value' "$1"; }

# write_fixture <file> [--drop KEY] [--set KEY VALUE]...: the secret JSON the aws stub returns.
write_fixture() {
  local file="$1"
  shift
  python3 - "$file" "$TRICKY_VALUE" "${FIXTURE_KEYS[@]}" -- "$@" <<'PY'
import json, sys
file, tricky = sys.argv[1], sys.argv[2]
rest = sys.argv[3:]
split = rest.index('--')
keys, edits = rest[:split], rest[split + 1:]
secret = {key: f'fakesecret-{key}-value' for key in keys}
secret['DATABASE_URL'] = tricky
i = 0
while i < len(edits):
    if edits[i] == '--drop':
        secret.pop(edits[i + 1], None)
        i += 2
    elif edits[i] == '--set':
        secret[edits[i + 1]] = edits[i + 2]
        i += 3
    else:
        raise SystemExit(f'unknown fixture edit {edits[i]}')
with open(file, 'w') as handle:
    json.dump(secret, handle)
PY
}

# An `aws` on PATH that logs its arguments and prints $AWS_STUB_SECRET (or fails).
install_aws_stub() {
  mkdir -p "$TMP/bin"
  cat >"$TMP/bin/aws" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$AWS_STUB_LOG"
if [[ -n "${AWS_STUB_FAIL:-}" ]]; then
  echo "An error occurred (AccessDeniedException) when calling the GetSecretValue operation" >&2
  exit 254
fi
cat "$AWS_STUB_SECRET"
SH
  chmod 755 "$TMP/bin/aws"
  export PATH="$TMP/bin:$PATH" AWS_STUB_LOG="$TMP/aws.log" AWS_STUB_SECRET="$TMP/secret.json"
}

# render <out-dir> <output-file>: runs render-env.sh; stdout and stderr go to <output-file>.
render() {
  bash "$SERVER_DIR/render-env.sh" --out-dir "$1" >"$2" 2>&1
}

value_of() { # value_of <env-file> <name>: the value after the first "=", verbatim
  grep -E "^$2=" "$1" | head -n 1 | cut -d= -f2-
}

names_of() { # names_of <env-file>: the sorted variable names
  cut -d= -f1 "$1" | sort
}

files_in() { python3 -c 'import os, sys; print(" ".join(sorted(os.listdir(sys.argv[1]))))' "$1"; }

mode_of() { python3 -c 'import os, sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$1"; }

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

# write_fixture <file> [--drop KEY] [--set KEY VALUE] [--set-json KEY JSON]...: the secret JSON
# the aws stub returns; --set-json gives a raw JSON value (a number, an escaped NUL).
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
    elif edits[i] == '--set-json':
        secret[edits[i + 1]] = json.loads(edits[i + 2])
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

# render <out-dir> <output-file>: runs $RENDER_SCRIPT (default the committed render-env.sh);
# stdout and stderr go to <output-file>.
RENDER_SCRIPT="$SERVER_DIR/render-env.sh"
render() {
  bash "$RENDER_SCRIPT" --out-dir "$1" >"$2" 2>&1
}

# refuses <label> <expected-message> [fixture edits...]: the render fails, names the problem,
# writes no env file and prints no value.
refuses() {
  local label="$1" message="$2" out="$TMP/refused-$1" status
  shift 2
  write_fixture "$TMP/secret.json" "$@"
  render "$out" "$TMP/$label.log"
  status=$?
  check "$label: exits non-zero" test "$status" -ne 0
  check "$label: names the problem" grep -qF -- "$message" "$TMP/$label.log"
  check "$label: writes no env file" bash -c "! ls '$out'/*.env >/dev/null 2>&1"
  check "$label: prints no value" bash -c "! grep -q fakesecret '$TMP/$label.log'"
}

value_of() { # value_of <env-file> <name>: the value after the first "=", verbatim
  grep -E "^$2=" "$1" | head -n 1 | cut -d= -f2-
}

names_of() { # names_of <env-file>: the sorted variable names
  cut -d= -f1 "$1" | sort
}

files_in() { python3 -c 'import os, sys; print(" ".join(sorted(os.listdir(sys.argv[1]))))' "$1"; }

mode_of() { python3 -c 'import os, sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$1"; }

# ---------------------------------------------------------------- provision.sh
# A stateful fake `aws` (tests/fake_aws.py) and a `sleep` that only records its argument.
# Region variables from the operator's shell are cleared so they cannot change a result.
install_fake_aws() {
  mkdir -p "$TMP/bin"
  printf '#!/usr/bin/env bash\nexec python3 %q "$@"\n' "$SERVER_DIR/tests/fake_aws.py" >"$TMP/bin/aws"
  # shellcheck disable=SC2016 # expanded by the stub when it runs
  printf '#!/usr/bin/env bash\necho "$*" >>"$FAKE_AWS_LOG.sleeps"\n' >"$TMP/bin/sleep"
  chmod 755 "$TMP/bin/aws" "$TMP/bin/sleep"
  export PATH="$TMP/bin:$PATH" FAKE_AWS_LOG="$TMP/aws.log" FAKE_AWS_STATE="$TMP/aws-state.json"
  unset AWS_REGION AWS_DEFAULT_REGION
}

# shellcheck disable=SC2034 # used by the provision tests that source this file
TEST_EMAIL="alerts-test@example.com"

lines_of() { # lines_of <word> <count>: <count> lines of <word>, for typed answers on stdin
  local i
  for ((i = 0; i < $2; i++)); do printf '%s\n' "$1"; done
}

# harness <tty_run.py args...>: runs tests/tty_run.py and returns its status. A timeout (124)
# is also a failed check of its own, so a hang can never pass as "exited non-zero and created
# nothing".
harness() {
  local status=0
  python3 "$SERVER_DIR/tests/tty_run.py" "$@" || status=$?
  if [[ "$status" -eq 124 ]]; then
    echo "FAIL tty_run timed out: $*"
    failures=$((failures + 1))
  fi
  return "$status"
}

# provision <typed> <output-file> [args...]: runs provision.sh from an empty working directory
# with a pseudo-terminal as its /dev/tty, <typed> typed into it (then end-of-input) and an empty
# stdin; stdout and stderr go to <output-file>; the aws log starts empty.
provision() {
  local typed="$1" output="$2"
  shift 2
  : >"$FAKE_AWS_LOG"
  mkdir -p "$TMP/cwd"
  harness --typed "$typed" --cwd "$TMP/cwd" --out "$output" -- bash "$SERVER_DIR/provision.sh" "$@"
}

# provision_piped <tty|no-tty> <stdin> <output-file> [args...]: like provision, but <stdin> is
# piped in and nothing is typed (tty) or there is no terminal at all (no-tty).
provision_piped() {
  local mode=(--typed "") input="$2" output="$3"
  [[ "$1" == no-tty ]] && mode=(--no-tty)
  shift 3
  : >"$FAKE_AWS_LOG"
  mkdir -p "$TMP/cwd"
  harness "${mode[@]}" --stdin "$input" --cwd "$TMP/cwd" --out "$output" \
    -- bash "$SERVER_DIR/provision.sh" "$@"
}

ops_of() { # ops_of <aws-log>: "service operation" of each call, one per line
  awk '{ print $2, $3 }' "$1"
}

MUTATING='^aws [a-z0-9]+ (create-|put-|attach-|add-|run-|subscribe|change-tags|authorize-|revoke-|delete-|modify-|tag-|update-)'
mutations_in() { grep -E "$MUTATING" "$1"; } # mutations_in <aws-log>: the calls that change AWS

fake_state() { # fake_state <python expression over `s`>: reads the fake's saved state
  python3 -c 'import json, sys; s = json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' \
    "$FAKE_AWS_STATE" "$1"
}

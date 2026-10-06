#!/usr/bin/env bash
# Tests for scripts/local-env-init.sh. Run: bash scripts/tests/local-env-init.test.sh
# The script runs from a copy inside a temporary tree, so it writes only there.
# Generated values are compared by name and equality only; nothing is printed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0

mkdir -p "$TMP/scripts" "$TMP/packages/db" "$TMP/apps/framework-editor" "$TMP/apps/api" "$TMP/apps/app" "$TMP/apps/portal"
cp -f "$ROOT/scripts/local-env-init.sh" "$TMP/scripts/local-env-init.sh"
bash "$TMP/scripts/local-env-init.sh" >/dev/null

value_of() { # value_of <file> <key>: the value, for comparison only
  grep -E "^$2=" "$1" | head -n 1 | cut -d= -f2-
}

check() { # check <name> <condition...>
  local name="$1"; shift
  if "$@"; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    failures=$((failures + 1))
  fi
}

has_key() { grep -qE "^$2=" "$1"; }
lacks_key() { ! grep -qE "^$2=" "$1"; }
same_value() { # same_value <key> <file...>
  local key="$1" first; shift
  first="$(value_of "$1" "$key")"
  [[ -n "$first" ]] || return 1
  for file in "$@"; do [[ "$(value_of "$file" "$key")" == "$first" ]] || return 1; done
}

API="$TMP/apps/api/.env"
APP="$TMP/apps/app/.env"
PORTAL="$TMP/apps/portal/.env"

check "api keeps the privileged internal token" has_key "$API" INTERNAL_API_TOKEN
check "app never gets the privileged internal token" lacks_key "$APP" INTERNAL_API_TOKEN
check "portal never gets the privileged internal token" lacks_key "$PORTAL" INTERNAL_API_TOKEN
check "api, app and portal share one forwarded-IP token" same_value COMP_FORWARDED_IP_TOKEN "$API" "$APP" "$PORTAL"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "all passed"

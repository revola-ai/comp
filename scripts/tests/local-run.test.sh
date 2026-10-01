#!/usr/bin/env bash
# Tests for scripts/local-run.sh helpers. Run: bash scripts/tests/local-run.test.sh
# Each case runs in a subshell with a fake HOME (no nvm) and a fake `node` on PATH.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/local-run.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0

fake_node() { # fake_node <dir> <version>
  mkdir -p "$1"
  printf '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v%s; else echo %s; fi\n' "$2" "${2%%.*}" >"$1/node"
  chmod +x "$1/node"
}

check() { # check <name> <expected-exit> <expected-output-substring> <cmd...>
  local name="$1" want_exit="$2" want_out="$3"; shift 3
  local out exit_code
  out="$("$@" 2>&1)"; exit_code=$?
  if [[ "$exit_code" == "$want_exit" && "$out" == *"$want_out"* ]]; then
    echo "ok   $name"
  else
    echo "FAIL $name: exit=$exit_code (want $want_exit), output: $out"
    failures=$((failures + 1))
  fi
}

run_use_node() { # run_use_node <path-dir-or-empty>
  env -i HOME="$TMP/home" PATH="$1:/usr/bin:/bin" bash -c "source '$SCRIPT'; use_node && echo node-ok"
}

fake_node "$TMP/node22" 22.11.0
fake_node "$TMP/node23" 23.1.0
mkdir -p "$TMP/home" "$TMP/empty"

check "use_node accepts Node 22 without nvm" 0 "node-ok" run_use_node "$TMP/node22"
check "use_node rejects Node 23 with a message" 1 "Node 22 is required, found v23.1.0" run_use_node "$TMP/node23"
check "use_node reports a missing node" 1 "Node 22 is required" run_use_node "$TMP/empty"

build_opts() { env -i HOME="$TMP/home" PATH="/usr/bin:/bin" NODE_OPTIONS="$1" bash -c "source '$SCRIPT'; build_node_options"; }
check "heap flag added when NODE_OPTIONS is empty" 0 "--max-old-space-size=4096" build_opts ""
check "heap flag appended to existing NODE_OPTIONS" 0 "--enable-source-maps --max-old-space-size=4096" build_opts "--enable-source-maps"
check "an existing heap setting is kept" 0 "--max-old-space-size=8192" build_opts "--max-old-space-size=8192"

check "sourcing the script runs no command" 0 "" env -i HOME="$TMP/home" PATH="/usr/bin:/bin" bash -c "source '$SCRIPT'"

exit "$failures"

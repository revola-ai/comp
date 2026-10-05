#!/usr/bin/env bash
# Tests for scripts/local-run.sh helpers. Run: bash scripts/tests/local-run.test.sh
# Each case runs in a clean environment: a fake HOME, no nvm (NVM_SCRIPTS emptied after
# sourcing, so a real Homebrew nvm is never touched), and a PATH holding only a fake `node`
# plus the few tools the script needs.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# LOCAL_RUN_SCRIPT lets a regression check run these cases against a modified copy.
SCRIPT="${LOCAL_RUN_SCRIPT:-$ROOT/scripts/local-run.sh}"
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

# Only the tools the script touches, so a system node in /usr/bin cannot leak in.
mkdir -p "$TMP/tools" "$TMP/home" "$TMP/empty"
for tool in tr dirname mkdir cat; do ln -s "$(command -v "$tool")" "$TMP/tools/$tool"; done
# The interpreter running this file, so `/bin/bash scripts/tests/local-run.test.sh` tests bash 3.2.
ln -s "$BASH" "$TMP/tools/bash"
BASH_BIN="$TMP/tools/bash"

# The requirement under test, read from the script so .nvmrc or NODE_MIN changes need no edits here.
WANT="$(tr -d '[:space:]' <"$ROOT/.nvmrc")"; WANT="${WANT#v}"; WANT="${WANT%%.*}"
NODE_MIN="$(sed -n 's/^NODE_MIN="\(.*\)"$/\1/p' "$SCRIPT")"
HEAP_MB="$(sed -n 's/^BUILD_HEAP_MB=//p' "$SCRIPT")"
if [[ -z "$WANT" || -z "$NODE_MIN" || -z "$HEAP_MB" ]]; then
  echo "FAIL could not read .nvmrc, NODE_MIN or BUILD_HEAP_MB from $SCRIPT"; exit 1
fi
check "the runner runs under the interpreter being tested" 0 "$BASH_VERSION" "$TMP/tools/bash" -c 'echo "$BASH_VERSION"'
nvmrc_matches_minimum() { [[ "${NODE_MIN%%.*}" == "$WANT" ]] && echo same-major; }
check "NODE_MIN and .nvmrc name the same Node major" 0 "same-major" nvmrc_matches_minimum

run_use_node() { # run_use_node <node-dir>
  env -i HOME="$TMP/home" PATH="$1:$TMP/tools" "$BASH_BIN" -c "source '$SCRIPT'; NVM_SCRIPTS=(); use_node; echo node-ok"
}

fake_node "$TMP/node-ok" "$NODE_MIN.0"
fake_node "$TMP/node-next" "$((WANT + 1)).0.0"

check "use_node accepts Node $NODE_MIN without nvm" 0 "node-ok" run_use_node "$TMP/node-ok"
check "use_node rejects the next major with a message" 1 "Node $WANT ($NODE_MIN or newer) is required, found v$((WANT + 1)).0.0" run_use_node "$TMP/node-next"
check "use_node reports a missing node" 1 "no node is on PATH" run_use_node "$TMP/empty"

build_opts() { env -i HOME="$TMP/home" PATH="$TMP/tools" NODE_OPTIONS="$1" "$BASH_BIN" -c "source '$SCRIPT'; build_node_options"; }
check "heap flag added when NODE_OPTIONS is empty" 0 "--max-old-space-size=$HEAP_MB" build_opts ""
check "heap flag appended to existing NODE_OPTIONS" 0 "--enable-source-maps --max-old-space-size=$HEAP_MB" build_opts "--enable-source-maps"
check "an existing heap setting is kept" 0 "--max-old-space-size=8192" build_opts "--max-old-space-size=8192"

# --- nvm path -------------------------------------------------------------------------
# A fake nvm.sh that behaves like the real one where it matters: loaded without --no-use
# it runs its own `nvm use` and fails (exit 3 under set -e), and `nvm use` puts the node in
# NVM_OK_DIR on PATH or fails when NVM_OK_DIR is empty.
mkdir -p "$TMP/nvm"
cat >"$TMP/nvm/nvm.sh" <<'NVM'
[ "${1:-}" = "--no-use" ] || return 3
nvm() {
  [ "$1" = "use" ] || return 0
  if [ -n "${EXPECT_NVM_DIR:-}" ] && [ "${NVM_DIR:-}" != "$EXPECT_NVM_DIR" ]; then
    echo "wrong NVM_DIR: ${NVM_DIR:-unset}" >&2; return 4
  fi
  [ -n "${NVM_OK_DIR:-}" ] || { echo "N/A: version not installed" >&2; return 3; }
  PATH="$NVM_OK_DIR:$PATH"
}
NVM
fake_node "$TMP/node-old" "$WANT.$(( ${NODE_MIN#*.} - 1 )).0"

run_with_nvm() { # run_with_nvm <path-node-dir> <nvm-node-dir-or-empty>
  env -i HOME="$TMP/home" PATH="$1:$TMP/tools" NVM_OK_DIR="$2" "$BASH_BIN" -c \
    "source '$SCRIPT'; NVM_SCRIPTS=('$TMP/nvm/nvm.sh'); use_node; node -v"
}
check "use_node loads nvm without its auto-use and switches when PATH has no node" 0 "v$NODE_MIN.0" run_with_nvm "$TMP/empty" "$TMP/node-ok"
check "use_node reports an nvm switch failure" 1 "nvm could not switch to Node $WANT" run_with_nvm "$TMP/empty" ""
check "use_node prefers a qualifying PATH node over nvm" 0 "v$NODE_MIN.0" run_with_nvm "$TMP/node-ok" ""
check "use_node switches with nvm when the PATH node is too old" 0 "v$NODE_MIN.0" run_with_nvm "$TMP/node-old" "$TMP/node-ok"
check "use_node rejects the node nvm switched to when it is below the minimum" 1 "($NODE_MIN or newer) is required, found v$WANT." run_with_nvm "$TMP/empty" "$TMP/node-old"
# NVM_DIR follows the nvm.sh that was found: its own directory for a standard or XDG
# install, ~/.nvm for Homebrew (whose nvm.sh lives outside the versions directory).
mkdir -p "$TMP/xdg/nvm" "$TMP/brew/opt/nvm"
cp "$TMP/nvm/nvm.sh" "$TMP/xdg/nvm/nvm.sh"; cp "$TMP/nvm/nvm.sh" "$TMP/brew/opt/nvm/nvm.sh"
nvm_dir_for() { # nvm_dir_for <nvm.sh> <expected NVM_DIR>
  env -i HOME="$TMP/home" PATH="$TMP/empty:$TMP/tools" NVM_OK_DIR="$TMP/node-ok" EXPECT_NVM_DIR="$2" "$BASH_BIN" -c \
    "source '$SCRIPT'; NVM_SCRIPTS=('$1'); use_node; node -v"
}
check "an XDG nvm install gets NVM_DIR set to its own directory" 0 "v$NODE_MIN.0" nvm_dir_for "$TMP/xdg/nvm/nvm.sh" "$TMP/xdg/nvm"
check "a Homebrew nvm gets NVM_DIR set to ~/.nvm" 0 "v$NODE_MIN.0" nvm_dir_for "$TMP/brew/opt/nvm/nvm.sh" "$TMP/home/.nvm"
xdg_in_defaults() { env -i HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/xdg" PATH="$TMP/tools" "$BASH_BIN" -c "source '$SCRIPT'; printf '%s\\n' \"\${NVM_SCRIPTS[@]}\""; }
check "the default nvm locations include \$XDG_CONFIG_HOME/nvm" 0 "$TMP/xdg/nvm/nvm.sh" xdg_in_defaults
check "use_node rejects a node below the minimum without nvm" 1 "($NODE_MIN or newer) is required, found v$WANT." run_use_node "$TMP/node-old"

# --- heap options -----------------------------------------------------------------------
check "heap flag added when NODE_OPTIONS is unset" 0 "--max-old-space-size=$HEAP_MB" env -i HOME="$TMP/home" PATH="$TMP/tools" "$BASH_BIN" -c "source '$SCRIPT'; build_node_options"
check "the underscore heap spelling is kept" 0 "--max_old_space_size=6000" build_opts "--max_old_space_size=6000"
heap_pct() { [[ "$(build_opts "--max-old-space-size-percentage=50")" == "--max-old-space-size-percentage=50" ]] && echo exact; }
check "a heap percentage counts as a heap setting and is kept alone" 0 "exact" heap_pct

# --- dispatch ---------------------------------------------------------------------------
check "an unknown command prints usage" 1 "usage: scripts/local-run.sh" env -i HOME="$TMP/home" PATH="$TMP/tools" "$BASH_BIN" "$SCRIPT" bogus

# --- build orchestration ----------------------------------------------------------------
# Stub turbo and bun record their directory, arguments and NODE_OPTIONS in order.
FAKE_ROOT="$TMP/root"; CALLS="$TMP/calls"
mkdir -p "$FAKE_ROOT/node_modules/.bin" "$FAKE_ROOT/apps/api" "$FAKE_ROOT/apps/app" "$TMP/stubs"
cp "$ROOT/.nvmrc" "$FAKE_ROOT/.nvmrc"
for stub in "$FAKE_ROOT/node_modules/.bin/turbo" "$TMP/stubs/bun"; do
  printf '#!/bin/sh\nprintf "%%s|%%s|%%s\\n" "${PWD#%s}" "$*" "${NODE_OPTIONS:-}" >>"%s"\n' "$FAKE_ROOT" "$CALLS" >"$stub"
  chmod +x "$stub"
done
run_build() {
  : >"$CALLS"
  env -i HOME="$TMP/home" PATH="$TMP/node-ok:$TMP/stubs:$TMP/tools" "$BASH_BIN" -c \
    "source '$SCRIPT'; NVM_SCRIPTS=(); ROOT='$FAKE_ROOT'; cmd_build" >/dev/null && cat "$CALLS"
}
EXPECTED_CALLS="|run build --ui=stream --filter=@trycompai/api^... --filter=@trycompai/app^...|
/apps/api|run build|--max-old-space-size=$HEAP_MB
/apps/app|run build|"
build_calls_exact() { [[ "$(run_build)" == "$EXPECTED_CALLS" ]] && echo exact || { echo "got:"; run_build; }; }
check "build runs turbo for the libraries, then api with the heap, then app" 0 "exact" build_calls_exact

build_in_fake_root() { # build_in_fake_root; prints the recorded calls after the build
  : >"$CALLS"
  env -i HOME="$TMP/home" PATH="$TMP/node-ok:$TMP/stubs:$TMP/tools" "$BASH_BIN" -c \
    "source '$SCRIPT'; NVM_SCRIPTS=(); ROOT='$FAKE_ROOT'; cmd_build"
  local rc=$?
  echo "calls:$(tr '\n' ';' <"$CALLS")"
  return "$rc"
}
TURBO="$FAKE_ROOT/node_modules/.bin/turbo"
mv -f "$TURBO" "$TMP/turbo.ok"
check "build stops with a message when turbo is not installed" 1 "turbo is not installed; run: bun install" build_in_fake_root
printf '#!/bin/sh\nprintf "%%s|%%s|%%s\\n" "turbo" "$*" "" >>"%s"\nexit 1\n' "$CALLS" >"$TURBO"; chmod +x "$TURBO"
turbo_fails_only_turbo_ran() { local out; out="$(build_in_fake_root 2>&1)"; [[ $? -ne 0 && "$out" == *"calls:turbo|"*";" && "$out" != *"/apps/"* ]] && echo stopped; }
check "a failing library build stops before the api and app" 0 "stopped" turbo_fails_only_turbo_ran
mv -f "$TMP/turbo.ok" "$TURBO"

source_is_silent() { [[ -z "$(env -i HOME="$TMP/home" PATH="$TMP/tools" "$BASH_BIN" -c "source '$SCRIPT'" 2>&1)" ]] && echo silent; }
check "sourcing the script prints nothing and runs no command" 0 "silent" source_is_silent

exit "$failures"

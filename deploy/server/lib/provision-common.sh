# shellcheck shell=bash
# Helpers for deploy/server/provision.sh (sourced, never run on its own); release.sh reuses
# die (prefixed with $TOOL_NAME), capture, quote_cmd, open_terminal and ask.
#
# Every step looks before it creates: `probe` (a get that fails with NotFound when the thing
# is missing) or `query` (a describe/list that returns nothing), then `create`, which prints
# the exact command and runs it only when the operator types "yes" at the terminal ($TTY_FD,
# opened on /dev/tty by provision.sh; piped stdin is never read for answers). A declined create is
# recorded in SKIPPED, and every step that depends on it is recorded too (`needs`), so the run
# ends non-zero with the list. READY[label] marks what exists; CREATED[label] what this run made.

declare -A READY=() CREATED=()
SKIPPED=()
PROBLEMS=()
OUT="" # stdout of the last probe, query or create
ERR="" # its stderr, shown only when the call fails
TTY_FD=""

die() {
  echo "${TOOL_NAME:-provision}: $*" >&2
  exit 1
}

# quote_arg <arg>: the argument as Python's shlex.quote writes it, so a printed command can be
# pasted into a shell and equals what ran.
SAFE_ARG='^[A-Za-z0-9_@%+=:,./-]+$'
quote_arg() {
  local s="$1" escaped="'\"'\"'"
  if [[ -z "$s" ]]; then
    printf "''"
  elif [[ "$s" =~ $SAFE_ARG ]]; then
    printf '%s' "$s"
  else
    printf "'%s'" "${s//\'/$escaped}"
  fi
}

quote_cmd() { # quote_cmd <args...>: the command line, each argument quoted as needed
  local line="" arg
  for arg in "$@"; do
    line+="${line:+ }$(quote_arg "$arg")"
  done
  printf '%s' "$line"
}

# capture <command...>: runs it with OUT = its stdout and ERR = its stderr (trailing newlines
# dropped) and returns its status. Both stay in memory: nothing is written to a file.
capture() {
  local status=""
  {
    IFS= read -r -d '' OUT || true
    IFS= read -r -d '' status || true
    IFS= read -r -d '' ERR || true
  } < <(
    exec 4>&1
    err="$({
      if out="$("$@")"; then code=0; else code=$?; fi
      printf '%s\0%s\0' "$out" "$code" >&4
    } 2>&1)"
    printf '%s\0' "$err"
  )
  return "${status:-1}"
}

# open_terminal [message]: opens /dev/tty for the answers; refuses with <message> when there is
# no terminal.
open_terminal() {
  if ! { exec {TTY_FD}</dev/tty; } 2>/dev/null; then
    die "${1:-provision.sh needs a terminal to confirm each create; run it from an interactive shell (piped answers are never accepted)}"
  fi
}

ask() { # ask <prompt>: OUT is the line typed at the terminal (empty at end of input)
  printf '%s' "$1"
  OUT=""
  IFS= read -r -u "$TTY_FD" OUT || true
  [[ -t 1 ]] || echo
}

# probe <label> <aws args...>: 0 with OUT set when AWS finds it, 1 when AWS answers that it does
# not exist; any other failure (credentials, permissions, network) stops the run.
probe() {
  local label="$1"
  shift
  if capture aws "$@"; then
    return 0
  fi
  if [[ "$ERR" =~ \((NoSuchEntity|NotFound)\) ]]; then
    OUT=""
    return 1
  fi
  die "could not check $label: $ERR"
}

# query <label> <aws args...>: OUT is the answer, blank lines removed (empty when nothing
# matches). Paginated text output puts each page on its own line, some of them empty.
query() {
  local label="$1"
  shift
  capture aws "$@" || die "could not check $label: $ERR"
  OUT="$(sed '/^[[:space:]]*$/d' <<<"$OUT")"
}

words() { # words <array name>: every whitespace-separated word of OUT, across all lines
  read -ra "$1" -d '' <<<"$OUT" || true
}

# needs <label> <prerequisite labels...>: true when every prerequisite is READY; otherwise
# records <label> as skipped, naming what it waits for.
needs() {
  local label="$1" prerequisite missing=""
  shift
  for prerequisite in "$@"; do
    [[ -n "${READY[$prerequisite]:-}" ]] || missing+="${missing:+, }$prerequisite"
  done
  [[ -z "$missing" ]] && return 0
  SKIPPED+=("$label (needs $missing)")
  return 1
}

# create <verb> <label> <aws args...>: prints the command and runs it only when the operator
# types exactly "yes"; anything else (or end of input) skips it. On success OUT holds the output
# and <label> is READY and CREATED; a failed command stops the run. Retries the identical
# command up to 6 times, 10 seconds apart, while the error contains $RETRY_ON (when set).
create() {
  local verb="$1" label="$2" attempt
  shift 2
  echo
  echo "$verb $label:"
  echo "  $(quote_cmd aws "$@")"
  ask 'Type yes to run it: '
  if [[ "$OUT" != yes ]]; then
    echo "Skipped."
    SKIPPED+=("$label (declined)")
    return 0
  fi
  for attempt in 1 2 3 4 5 6; do
    if capture aws "$@"; then
      READY[$label]=1
      CREATED[$label]=1
      return 0
    fi
    [[ -n "${RETRY_ON:-}" && "$ERR" == *"$RETRY_ON"* && "$attempt" -lt 6 ]] || break
    echo "  AWS has not caught up yet ($RETRY_ON); retrying in 10 seconds"
    sleep 10
  done
  die "creating $label failed: $ERR"
}

same_json() { # same_json <json> <json>: true when both parse to the same value
  python3 -c 'import json, sys; sys.exit(json.loads(sys.argv[1]) != json.loads(sys.argv[2]))' "$1" "$2"
}

finish_run() { # lists problems and skipped work; exits non-zero when there is any
  if ((${#PROBLEMS[@]} > 0)); then
    echo
    echo "Problems (fix them, then rerun provision.sh):"
    printf '  - %s\n' "${PROBLEMS[@]}"
  fi
  if ((${#SKIPPED[@]} > 0)); then
    echo
    echo "Not done (rerun provision.sh to finish):"
    printf '  - %s\n' "${SKIPPED[@]}"
  fi
  if ((${#PROBLEMS[@]} + ${#SKIPPED[@]} > 0)); then
    exit 1
  fi
  echo
  echo "Everything is in place."
}

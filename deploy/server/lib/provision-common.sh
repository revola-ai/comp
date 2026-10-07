# shellcheck shell=bash
# Helpers for deploy/server/provision.sh (sourced, never run on its own).
#
# Every step looks before it creates: `probe` (a get that fails with NotFound when the thing
# is missing) or `query` (a describe/list that returns nothing), then `create`, which prints
# the exact command and runs it only when the operator types "yes". A declined create is
# recorded in SKIPPED, and every step that depends on it is recorded too (`needs`), so the run
# ends non-zero with the list. READY[label] marks what exists; CREATED[label] what this run made.

declare -A READY=() CREATED=()
SKIPPED=()
PROBLEMS=()
OUT="" # output of the last probe, query or create

die() {
  echo "provision: $*" >&2
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

# probe <label> <aws args...>: 0 with OUT set when AWS finds it, 1 when AWS answers that it does
# not exist; any other failure (credentials, permissions, network) stops the run. stderr is
# captured with stdout: on success the CLI writes nothing to it.
probe() {
  local label="$1"
  shift
  if OUT="$(aws "$@" 2>&1)"; then
    return 0
  fi
  if [[ "$OUT" =~ \((NoSuchEntity|NotFound)\) ]]; then
    OUT=""
    return 1
  fi
  die "could not check $label: $OUT"
}

query() { # query <label> <aws args...>: OUT is the answer (empty when nothing matches)
  local label="$1"
  shift
  OUT="$(aws "$@" 2>&1)" || die "could not check $label: $OUT"
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
  local verb="$1" label="$2" answer="" attempt
  shift 2
  echo
  echo "$verb $label:"
  echo "  $(quote_cmd aws "$@")"
  printf 'Type yes to run it: '
  IFS= read -r answer || true
  [[ -t 0 ]] || echo
  if [[ "$answer" != yes ]]; then
    echo "Skipped."
    SKIPPED+=("$label (declined)")
    return 0
  fi
  for attempt in 1 2 3 4 5 6; do
    if OUT="$(aws "$@" 2>&1)"; then
      READY[$label]=1
      CREATED[$label]=1
      return 0
    fi
    [[ -n "${RETRY_ON:-}" && "$OUT" == *"$RETRY_ON"* && "$attempt" -lt 6 ]] || break
    echo "  AWS has not caught up yet ($RETRY_ON); retrying in 10 seconds"
    sleep 10
  done
  die "creating $label failed: $OUT"
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

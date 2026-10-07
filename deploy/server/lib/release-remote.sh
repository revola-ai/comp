# shellcheck shell=bash
# Laptop-side checks and the SSM transport of deploy/server/release.sh (sourced, never run on
# its own; needs lib/provision-common.sh).
#
# A server step is one SSM Run Command (AWS-RunShellScript) whose text is
# lib/server-common.sh followed by on-server/entry.sh (steps that may change something) or
# on-server/status.sh (read-only), so it never depends on the server's checkout having them.
# The command carries names, tags and SHAs only; secrets never appear in SSM parameters.
# `remote` waits for it, prints what it printed (before "comp-meta-begin") and keeps what
# follows: comp-log (the server's log path), comp-result lines and comp-end.

INSTANCE_ID=""
REMOTE_CODE=0    # the step's exit status (1 when SSM itself failed)
REMOTE_STATUS="" # how SSM says the command ended (Success, Failed, TimedOut, Cancelled...)
REMOTE_ENDED=""  # set when the server's end marker (comp-end) arrived
REMOTE_LOG=""    # the server's log of the last step, when it reported one
REMOTE_QUIET=""  # set: keep the step's output to itself (paging through a log)
# What is in flight, for lib/release-interrupt.sh:
SENDING=""       # set while send-command runs: a command may be on its way, its id unknown
SENT_ANY=""      # set once any command was sent
INFLIGHT_ID=""   # the SSM command being waited for
INFLIGHT_KIND="" # its kind: entry or status
INFLIGHT_STEP="" # its step name (status for a read-only one)
LAST_STEP=""     # the name of the last step that ended
DELIVERY_SECONDS=600
POLL_SECONDS=5
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# require_local <tools...>: the region and the tools, before anything else.
require_local() {
  local variable value tool
  for variable in AWS_REGION AWS_DEFAULT_REGION; do
    value="${!variable:-}"
    if [[ -n "$value" && "$value" != "$REGION" ]]; then
      die "$variable is $value; release.sh only works in $REGION (unset it or set it to $REGION)"
    fi
  done
  for tool in "$@"; do
    command -v "$tool" >/dev/null || die "$tool is not installed"
  done
}

# resolve_pushed <sha>: FULL_SHA and TAG for a 12- or 40-character SHA that some branch of the
# fork contains; anything else stops before any AWS call. "Pushed" is decided against the URL
# the server fetches from (COMP_REPO_URL), never a remote name (Kyle's `origin` is upstream):
# its branches are fetched with --prune into refs/comp-release/, so a deleted branch no longer
# counts and no remote's refs are touched.
resolve_pushed() {
  [[ "$1" =~ ^[0-9a-f]{12}$|^[0-9a-f]{40}$ ]] || die "'$1' is not a 12- or 40-character git SHA"
  git -C "$REPO_ROOT" fetch --prune --quiet "$COMP_REPO_URL" '+refs/heads/*:refs/comp-release/*' ||
    die "git fetch --prune $COMP_REPO_URL failed"
  FULL_SHA="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "$1^{commit}")" ||
    die "$1 is not a commit in this repository (after fetching $COMP_REPO_URL)"
  local refs
  refs="$(git -C "$REPO_ROOT" for-each-ref --contains "$FULL_SHA" --format='%(refname)' refs/comp-release/)" ||
    die "git for-each-ref failed"
  [[ -n "$refs" ]] ||
    die "$FULL_SHA is not on any branch of revola-ai/comp; push it there first (git push revola <branch>)"
  TAG="${FULL_SHA:0:12}"
}

# connect: the account check, then INSTANCE_ID of the one running comp-server.
connect() {
  capture aws sts get-caller-identity --query Account --output text --region "$REGION" ||
    die "could not read the caller identity: $ERR"
  [[ "$OUT" == "$ACCOUNT" ]] || die "these credentials are for account $OUT, not $ACCOUNT; refusing"
  capture aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$NAME" Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].InstanceId' --output text --region "$REGION" ||
    die "could not look up the $NAME instance: $ERR"
  local ids
  read -ra ids -d '' <<<"$OUT" || true
  case "${#ids[@]}" in
    1) INSTANCE_ID="${ids[0]}" ;;
    0) die "there is no running instance named $NAME in $REGION (deploy/server/provision.sh creates it)" ;;
    *) die "there are ${#ids[@]} running instances named $NAME (${ids[*]}); expected one" ;;
  esac
}

step_name() { # step_name <step> [tag]: "<utc>-<step>[-<tag>]", the name of a step's log
  printf '%s-%s%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$1" "${2:+-$2}"
}

# run_id <step> [tag]: the step name and 8 random hex characters; the server's lease names the
# run, so two operators starting in the same second never share one.
run_id() {
  local random
  random="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "$random" =~ ^[0-9a-f]{8}$ ]] || die "could not read /dev/urandom"
  printf '%s-%s' "$(step_name "$@")" "$random"
}

# ssm_parameters <timeout> <entry|status> <args...>: the send-command parameters. The script
# text goes through a quoted here-document into a mktemp file (the server's shell expands
# nothing in it), which bash then runs with <args>.
ssm_parameters() {
  local timeout="$1" kind="$2"
  shift 2
  python3 - "$timeout" "$SERVER_DIR/lib/server-common.sh" "$SERVER_DIR/on-server/$kind.sh" \
    "$(quote_cmd "$@")" <<'PY'
import json, sys
timeout, common, script, args = sys.argv[1:5]
text = open(common).read() + '\n' + open(script).read()
if any(line == 'COMP_SCRIPT' for line in text.splitlines()):
    raise SystemExit('a script line equals the here-document terminator')
commands = ['script="$(mktemp)" || exit 1', "cat >\"$script\" <<'COMP_SCRIPT'", *text.splitlines(),
            'COMP_SCRIPT', f'bash "$script" {args}', 'status=$?', 'rm -f "$script"', 'exit "$status"']
print(json.dumps({'commands': commands, 'executionTimeout': [timeout]}))
PY
}

# remote <comment> <timeout-seconds> <entry|status> <args...>: runs one server step and waits
# for it; sets REMOTE_CODE and REMOTE_LOG and keeps its comp-result lines for result_of.
remote() {
  local comment="$1" timeout="$2" kind="$3" parameters
  shift 3
  parameters="$(ssm_parameters "$timeout" "$kind" "$@")"
  INFLIGHT_KIND="$kind"
  [[ "$kind" == entry ]] || INFLIGHT_STEP=status
  SENDING=1 SENT_ANY=1
  if ! capture aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
    --comment "$comment" --timeout-seconds "$DELIVERY_SECONDS" --parameters "$parameters" \
    --query Command.CommandId --output text --region "$REGION"; then
    SENDING=""
    die "could not send the SSM command: $ERR"
  fi
  INFLIGHT_ID="$OUT"
  SENDING=""
  await_command "$INFLIGHT_ID" $(((timeout + DELIVERY_SECONDS + 300) / POLL_SECONDS))
}

# await_command <command-id> <max polls>: waits for an SSM command to end, prints its output
# and sets REMOTE_STATUS, REMOTE_CODE, REMOTE_ENDED and REMOTE_LOG.
await_command() {
  local id="$1" max="$2" polls=0 status code details
  while :; do
    ((polls++ < max)) || die "gave up waiting for SSM command $id; it may still run (aws ssm get-command-invocation --command-id $id --instance-id $INSTANCE_ID --region $REGION)"
    sleep "$POLL_SECONDS"
    if ! capture aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
      --output json --region "$REGION"; then
      [[ "$ERR" == *InvocationDoesNotExist* ]] && continue
      die "could not read SSM command $id: $ERR"
    fi
    read -r status code details < <(printf '%s' "$OUT" | python3 -c '
import json, sys
answer = json.load(sys.stdin)
open(sys.argv[1], "w").write(answer.get("StandardOutputContent") or "")
open(sys.argv[2], "w").write(answer.get("StandardErrorContent") or "")
print(answer.get("Status", "Unknown"), answer.get("ResponseCode", -1), answer.get("StatusDetails", "-"))' "$WORK/out" "$WORK/err")
    case "$status" in
      Pending | InProgress | Delayed | Cancelling) continue ;;
    esac
    break
  done
  INFLIGHT_ID=""
  REMOTE_STATUS="$status"
  split_output
  case "$status" in
    Success) REMOTE_CODE=0 ;;
    Failed)
      REMOTE_CODE="$code"
      [[ "$details" == Failed ]] || echo "SSM command $id ended Failed ($details); the server step may not have run to completion."
      ;;
    *) REMOTE_CODE=1; echo "SSM command $id ended $status ($details); the server step may not have run to completion." ;;
  esac
  [[ "$REMOTE_CODE" -ne 0 || "$status" == Success ]] || REMOTE_CODE=1
}

# split_output: prints the step's own output and keeps its meta lines in $WORK/meta.
split_output() {
  : >"$WORK/meta"
  REMOTE_LOG="" REMOTE_ENDED=""
  if grep -qx comp-meta-begin "$WORK/out"; then
    [[ -n "$REMOTE_QUIET" ]] || awk '/^comp-meta-begin$/ { exit } !/^comp-result: / { print }' "$WORK/out"
    awk 'after { print } /^comp-meta-begin$/ { after = 1 }' "$WORK/out" >"$WORK/meta"
    REMOTE_LOG="$(sed -n 's/^comp-log: //p' "$WORK/meta")"
    grep -q '^comp-end: ' "$WORK/meta" && REMOTE_ENDED=1
  else
    cat "$WORK/out"
    echo
    echo "The server's output was cut short (SSM keeps 24,000 characters) or the step stopped early."
    CUT_SHORT=1
  fi
  if [[ -s "$WORK/err" ]]; then
    echo "stderr on the server:"
    cat "$WORK/err"
  fi
}

result_of() { sed -n "s/^comp-result: $1=//p" "$WORK/meta" | tail -n 1; } # result_of <key>

# unchanged: true only when the step ended normally and the server said it changed nothing.
unchanged() {
  [[ "$REMOTE_STATUS" =~ ^(Success|Failed)$ && -n "$REMOTE_ENDED" && "$(result_of changed)" == no ]]
}

# step <step> <timeout> <run-id> <new|own> <sha|-> <script> [args...]: a server step through
# on-server/entry.sh, with its log named after <step> and the run's tag; prints where the log is.
step() {
  local name="$1" timeout="$2" run="$3" lease="$4" sha="$5" log
  shift 5
  log="$(step_name "$name" "$TAG").log"
  CUT_SHORT="" INFLIGHT_STEP="$name"
  remote "comp release.sh $name${TAG:+ $TAG}" "$timeout" entry "$log" "$run" "$lease" "$sha" "$@"
  LAST_STEP="$name"
  if [[ -n "$CUT_SHORT" ]]; then
    echo "Full log: /opt/comp/logs/$log (fetch it with: deploy/server/release.sh logs --release $log)"
  elif [[ -n "$REMOTE_LOG" ]]; then
    echo "Full log: $REMOTE_LOG (deploy/server/release.sh logs --release $log)"
  fi
}

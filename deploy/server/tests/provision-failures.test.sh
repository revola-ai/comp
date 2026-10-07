#!/usr/bin/env bash
# Refusals, partial states and failure paths of deploy/server/provision.sh.
# Run: bash deploy/server/tests/provision-failures.test.sh
# `aws` is a stateful fake (tests/fake_aws.py); nothing reaches AWS.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
install_fake_aws

fresh() { rm -f "$FAKE_AWS_STATE" "$FAKE_AWS_LOG.sleeps"; }
nothing_created() { ! grep -qE "$MUTATING" "$FAKE_AWS_LOG"; }
no_aws_call() { test ! -s "$FAKE_AWS_LOG"; }
ALL_YES="$(lines_of yes 40)"

# provision_everything: a complete fake account, as a confirmed run leaves it.
provision_everything() {
  fresh
  provision "$ALL_YES" "$TMP/setup.out" --alert-email "$TEST_EMAIL" || echo "setup run failed" >&2
}
edit_state() { # edit_state <python statements over `s`>: changes the fake account
  python3 -c 'import json, sys; p = sys.argv[1]; s = json.load(open(p)); exec(sys.argv[2]); json.dump(s, open(p, "w"))' \
    "$FAKE_AWS_STATE" "$1"
}

# ---------------------------------------------------------------- the harness itself
# A run that hangs must fail the suite, never pass as "exited non-zero and created nothing".
# /bin/sleep, because the sleep on PATH is the recording stub.
for mode in "--typed ''" --no-tty; do
  (
    failures=0
    TTY_RUN_TIMEOUT=1 eval harness "$mode" --out "'$TMP/hung.out'" -- /bin/sleep 30
    echo "status=$? failures=$failures"
  ) >"$TMP/hung.report" 2>&1
  check "hung child ($mode): reported as a failed check" grep -qF "FAIL tty_run timed out" "$TMP/hung.report"
  check "hung child ($mode): counted as a failure" grep -qF "status=124 failures=1" "$TMP/hung.report"
  check "hung child ($mode): the output says so" grep -qxF "tty_run: timed out after 1 seconds" "$TMP/hung.out"
done

# ---------------------------------------------------------------- refusals before any create
fresh
FAKE_AWS_ACCOUNT=111122223333 provision "$ALL_YES" "$TMP/account.out" --alert-email "$TEST_EMAIL"
status=$?
check "wrong account: exits non-zero" test "$status" -ne 0
check "wrong account: names both accounts" \
  grep -qF "account 111122223333, not 455986776194" "$TMP/account.out"
check "wrong account: makes no call after the identity check" \
  test "$(cat "$FAKE_AWS_LOG")" = "aws sts get-caller-identity --query Account --output text --region us-east-2"

for variable in AWS_REGION AWS_DEFAULT_REGION; do
  export "$variable=eu-west-1"
  provision "$ALL_YES" "$TMP/region.out" --alert-email "$TEST_EMAIL"
  status=$?
  unset "$variable"
  check "$variable=eu-west-1: exits non-zero" test "$status" -ne 0
  check "$variable=eu-west-1: says why" grep -qF "$variable is eu-west-1" "$TMP/region.out"
  check "$variable=eu-west-1: no aws call" no_aws_call
done
AWS_REGION=us-east-2 provision "" "$TMP/region-ok.out" --alert-email "$TEST_EMAIL"
check "AWS_REGION=us-east-2 is accepted" grep -q "sts get-caller-identity" "$FAKE_AWS_LOG"

provision "" "$TMP/no-email.out"
status=$?
check "no email: exits non-zero" test "$status" -ne 0
check "no email: says it is required" grep -qF "an alert email address is required" "$TMP/no-email.out"
check "no email: no aws call" no_aws_call
for bad in "person@revola" "kyle revola.ai" "x'@example.com" "a@b.c\"]"; do
  provision "" "$TMP/bad-email.out" --alert-email "$bad"
  status=$?
  check "email '$bad': refused" test "$status" -ne 0
  check "email '$bad': no aws call" no_aws_call
done
provision "" "$TMP/usage.out" --bogus
check "unknown argument: exits 2" test "$?" -eq 2
provision "" "$TMP/help.out" --help
check "--help: exits zero" test "$?" -eq 0
check "--help: shows usage" grep -qF "usage: provision.sh" "$TMP/help.out"
if [[ "$(/bin/bash -c 'echo "${BASH_VERSINFO[0]}"')" -lt 4 ]]; then # macOS ships bash 3.2
  (cd "$TMP" && /bin/bash "$SERVER_DIR/provision.sh" --alert-email "$TEST_EMAIL" </dev/null >"$TMP/old-bash.out" 2>&1)
  check "bash 3: refused by name" grep -qF "provision.sh needs bash 4 or newer" "$TMP/old-bash.out"
fi

# ---------------------------------------------------------------- answers
fresh
provision "$TEST_EMAIL"$'\n'"$ALL_YES" "$TMP/prompt.out"
status=$?
check "email from the prompt: exits zero" test "$status" -eq 0
check "email from the prompt: subscribes it" grep -qF -- "--notification-endpoint $TEST_EMAIL " "$FAKE_AWS_LOG"
for answer in y YES " yes" "yes please" ""; do
  fresh
  provision "$(lines_of "$answer" 40)" "$TMP/answer.out" --alert-email "$TEST_EMAIL"
  status=$?
  check "answer '$answer': not a yes" nothing_created
  check "answer '$answer': exits non-zero" test "$status" -ne 0
done

# ---------------------------------------------------------------- aws failures
fresh
FAKE_AWS_DENY="iam get-role" provision "$ALL_YES" "$TMP/denied.out" --alert-email "$TEST_EMAIL"
status=$?
check "describe denied: exits non-zero" test "$status" -ne 0
check "describe denied: says what it could not check" grep -qF "could not check IAM role comp-server" "$TMP/denied.out"
check "describe denied: shows the aws error" grep -qF "AccessDenied" "$TMP/denied.out"
check "describe denied: creates nothing" nothing_created

fresh
FAKE_AWS_DENY="iam create-role" provision "$ALL_YES" "$TMP/create-denied.out" --alert-email "$TEST_EMAIL"
status=$?
check "create denied: exits non-zero" test "$status" -ne 0
check "create denied: says what failed" grep -qF "creating IAM role comp-server failed" "$TMP/create-denied.out"
check "create denied: stops there" test "$(tail -n 1 "$FAKE_AWS_LOG" | awk '{ print $3 }')" = create-role

fresh
FAKE_AWS_PROFILE_NOT_READY=2 provision "$ALL_YES" "$TMP/propagation.out" --alert-email "$TEST_EMAIL"
status=$?
check "profile propagating: exits zero" test "$status" -eq 0
check "profile propagating: retries the same command" \
  test "$(grep 'ec2 run-instances' "$FAKE_AWS_LOG" | sort -u | wc -l | tr -d ' ')" = 1
check "profile propagating: three attempts" test "$(grep -c 'ec2 run-instances' "$FAKE_AWS_LOG")" -eq 3
check "profile propagating: waits 10 seconds between" test "$(cat "$FAKE_AWS_LOG.sleeps")" = $'10\n10'
check "profile propagating: one instance" test "$(fake_state "len(s['instances'])")" = 1

fresh
FAKE_AWS_PROFILE_NOT_READY=99 provision "$ALL_YES" "$TMP/never-ready.out" --alert-email "$TEST_EMAIL"
status=$?
check "profile never ready: exits non-zero" test "$status" -ne 0
check "profile never ready: gives up after 6 attempts" test "$(grep -c 'ec2 run-instances' "$FAKE_AWS_LOG")" -eq 6
check "profile never ready: says so" grep -qF "creating instance comp-server failed" "$TMP/never-ready.out"

# ---------------------------------------------------------------- partial and drifted accounts
provision_everything
edit_state "s['security_groups'][0]['inbound'] = 1; s['instances'] = []"
provision "$ALL_YES" "$TMP/inbound.out" --alert-email "$TEST_EMAIL"
status=$?
check "inbound rule: exits non-zero" test "$status" -ne 0
check "inbound rule: names the group" \
  grep -qF "security group comp-server (sg-0fake0000) has 1 inbound rule(s); remove them" "$TMP/inbound.out"
check "inbound rule: launches no instance" bash -c "! grep -q 'run-instances' '$FAKE_AWS_LOG'"
check "inbound rule: never touches the rules" bash -c "! grep -qE 'authorize|revoke' '$FAKE_AWS_LOG'"

provision_everything
edit_state "s['instances'].append('i-0second')"
provision "$ALL_YES" "$TMP/two.out" --alert-email "$TEST_EMAIL"
status=$?
check "two instances: exits non-zero" test "$status" -ne 0
check "two instances: names them" grep -qF "2 instances are tagged Name=comp-server" "$TMP/two.out"
check "two instances: creates nothing" nothing_created

provision_everything
edit_state "s['inline']['Statement'] = s['inline']['Statement'][:1]"
provision "$ALL_YES" "$TMP/drift.out" --alert-email "$TEST_EMAIL"
status=$?
check "drifted role policy: exits zero" test "$status" -eq 0
check "drifted role policy: offered as an update" grep -qF "Update inline policy comp-server on role comp-server:" "$TMP/drift.out"
check "drifted role policy: the only change" \
  test "$(mutations_in "$FAKE_AWS_LOG" | awk '{ print $3 }')" = put-role-policy
check "drifted role policy: restored" test "$(fake_state "len(s['inline']['Statement'])")" = 2

provision_everything
edit_state "s['log_groups']['/comp/portal'] = None; s['profile_roles'] = []; s['attached'] = []"
provision "$ALL_YES" "$TMP/partial.out" --alert-email "$TEST_EMAIL"
status=$?
check "partial: exits zero" test "$status" -eq 0
check "partial: only the missing pieces" test "$(mutations_in "$FAKE_AWS_LOG" | awk '{ print $3 }' | tr '\n' ' ')" = \
  "attach-role-policy add-role-to-instance-profile put-retention-policy "
check "partial: retention on the right group" grep -qF -- "--log-group-name /comp/portal --retention-in-days 30" "$FAKE_AWS_LOG"

provision_everything
edit_state "s['alarms'] = {}"
provision "$(lines_of no 40)" "$TMP/alarm-declined.out" --alert-email "$TEST_EMAIL"
status=$?
check "declined alarms: exits non-zero" test "$status" -ne 0
check "declined alarms: lists all three" test "$(grep -c '^  - alarm comp-' "$TMP/alarm-declined.out")" -eq 3
check "declined alarms: asks only for them" test "$(grep -c 'Type yes to run it' "$TMP/alarm-declined.out")" -eq 3

provision_everything
edit_state "s['alarms']['comp-api-health'] = 'fake-check-deleted'"
provision "$ALL_YES" "$TMP/alarm-drift.out" --alert-email "$TEST_EMAIL"
status=$?
check "alarm on an old check: exits zero" test "$status" -eq 0
check "alarm on an old check: offered as an update" grep -qF "Update alarm comp-api-health:" "$TMP/alarm-drift.out"
check "alarm on an old check: the only change" \
  test "$(mutations_in "$FAKE_AWS_LOG" | awk '{ print $3 }')" = put-metric-alarm
check "alarm on an old check: now on the current check" test "$(fake_state "s['alarms']['comp-api-health']")" = fake-check-0

# ---------------------------------------------------------------- what the CLI prints
provision_everything
FAKE_AWS_WARN=1 provision "" "$TMP/warn.out" --alert-email "$TEST_EMAIL"
status=$?
check "stderr notices on success: exits zero" test "$status" -eq 0
check "stderr notices on success: not read as answers" bash -c "! grep -q 'Type yes' '$TMP/warn.out'"
check "stderr notices on success: create nothing" nothing_created
FAKE_AWS_PAGED=1 provision "" "$TMP/paged.out" --alert-email "$TEST_EMAIL"
status=$?
check "paged answers: exits zero" test "$status" -eq 0
check "paged answers: finds the checks and the instance on later pages" nothing_created
edit_state "s['instances'].append('i-0second')"
FAKE_AWS_PAGED=1 provision "" "$TMP/paged-two.out" --alert-email "$TEST_EMAIL"
check "paged answers: counts instances across pages" \
  grep -qF "2 instances are tagged Name=comp-server (i-0fake000000000000 i-0second)" "$TMP/paged-two.out"

finish

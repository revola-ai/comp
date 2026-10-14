#!/usr/bin/env bash
# Tests for the operator in /opt/comp/releases.log: every line names who ran the step, the
# caller ARN of the laptop's credentials (`<utc> <action> <sha12> <outcome> <operator>`), the
# laptop refuses an ARN it cannot vouch for, the server refuses a malformed one before any change,
# and lines written before the field existed still drive the serving history.
# Run: bash deploy/server/tests/operator.test.sh
# Laptop and server share one sandbox (tests/release-lib.sh); nothing reaches AWS or the server.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/server/tests/release-lib.sh
source "$SERVER_DIR/tests/release-lib.sh"
install_release_fakes
said() { grep -qF -- "$2" "$1"; } # said <output> <text>
OTHER="arn:aws:iam::455986776194:user/ops.oncall+2@revola.ai" # a second operator (an IAM user)
lines() { wc -l <"$SERVER/releases.log" | tr -d ' '; }
# new_records <from> <operator>: every releases.log line after line <from> has five fields and
# names <operator> last; there is at least one.
new_records() {
  local rest
  rest="$(tail -n +"$(($1 + 1))" "$SERVER/releases.log")"
  [[ -n "$rest" ]] && awk -v who="$2" 'NF != 5 || $5 != who { bad = 1 } END { exit bad }' <<<"$rest"
}

# ---------------------------------------------------------------- every record names its operator
reset_server
released "$TAG_D" "$TAG_A"
before="$(lines)"
release_sh "$TMP/release.out" release "$SHA_B"
check "release: recorded ok" test "$?:$(last_record)" = "0:release $TAG_B ok"
check "release: the record names the operator" new_records "$before" "$OPERATOR"
check "release: the laptop reads the caller's account and ARN in one call" test "$(sed -n 1p "$FAKE_AWS_LOG")" = \
  "aws sts get-caller-identity --query '[Account, Arn]' --output text --region us-east-2"
check "release: each step carries the operator to the server" \
  test "$(for n in 1 2 3; do ssm_call "$n" args | cut -d' ' -f3; done | sort -u)" = "$OPERATOR"
before="$(lines)"
FAKE_AWS_ARN="$OTHER" release_sh "$TMP/rollback.out" rollback
check "rollback: recorded ok, naming its own operator" \
  test "$?:$(last_record):$(new_records "$before" "$OTHER" && echo named)" = "0:rollback $TAG_A ok:named"

reset_server
released "$TAG_A"
before="$(lines)"
FAKE_DOCKER_FAIL_BUILD=app release_sh "$TMP/build-failed.out" release "$SHA_B"
check "a release whose build fails: recorded, naming the operator" \
  test "$(last_record):$(new_records "$before" "$OPERATOR" && echo named)" = "release $TAG_B failed:named"
before="$(lines)"
FAKE_CURL_BAD_TAG="$TAG_B" release_sh "$TMP/rolled-back.out" release "$SHA_B"
check "a release that is rolled back: recorded, naming the operator" \
  test "$(last_record):$(new_records "$before" "$OPERATOR" && echo named)" = "release $TAG_B rolled-back:named"

reset_server
released "$TAG_A"
docker_state "s['migrations'] = 'pending'"
before="$(lines)"
FAKE_AWS_ARN="$OTHER" release_typed "migrate" "$TMP/migrate.out" migrate "$SHA_B"
check "migrate: recorded ok, naming the operator" \
  test "$?:$(last_record):$(new_records "$before" "$OTHER" && echo named)" = "0:migrate $TAG_B ok:named"
before="$(lines)"
release_typed "trigger" "$TMP/trigger.out" trigger "$SHA_B"
check "trigger: recorded ok, naming the operator" \
  test "$?:$(last_record):$(new_records "$before" "$OPERATOR" && echo named)" = "0:trigger $TAG_B ok:named"

reset_server
released "$TAG_A"
printf '20261007T120000Z-release-%s-0123abcd %s release %s\n' "$TAG_C" "$(($(date +%s) + 600))" "$TAG_C" >"$SERVER/release.lease"
before="$(lines)"
FAKE_AWS_ARN="$OTHER" release_typed "unlock" "$TMP/unlock.out" unlock
check "unlock: recorded, naming who unlocked (not who started the run)" \
  test "$?:$(last_record):$(new_records "$before" "$OTHER" && echo named)" = "0:release $TAG_C unlocked:named"

# ---------------------------------------------------------------- an operator that is not an ARN
# shellcheck disable=SC2016 # a literal $(id) the laptop must never pass on
for bad in "arn:aws:sts::45598677619:assumed-role/x/y" "arn:aws:s3:::bucket" "arn:aws:iam::455986776194:user/a b" \
  'arn:aws:sts::455986776194:assumed-role/x/$(id)' "arn:aws:iam::455986776194:"; do
  reset_server
  released "$TAG_A"
  FAKE_AWS_ARN="$bad" release_sh "$TMP/bad-arn.out" release "$SHA_B"
  check "laptop, caller ARN '$bad': refused" test "$?" -ne 0
  check "laptop, caller ARN '$bad': says why" said "$TMP/bad-arn.out" "is not the ARN of an IAM user, role or assumed-role session; refusing"
  check "laptop, caller ARN '$bad': no SSM command" test "$(ssm_sends)" -eq 0
done

entry() { COMP_ROOT="$SERVER" bash "$SERVER_DIR/on-server/entry.sh" "$@" >"$TMP/entry.out" 2>&1; }
RUN="20261007T120000Z-release-$TAG_B-0123abcd"
for bad in "-" "arn:aws:sts::455986776194:assumed-role/x/;reboot" "arn:aws:sts::455986776194:assumed-role/x y" ""; do
  reset_server
  released "$TAG_A"
  docker_state "s['images'] += ['comp-api:$TAG_B', 'comp-app:$TAG_B', 'comp-portal:$TAG_B', 'comp-migrate:$TAG_B']"
  entry "20261007T120000Z-release-$TAG_B.log" "$RUN" "$bad" new "$SHA_B" release up release "$TAG_B"
  check "server, operator '$bad': refused with 2" test "$?" -eq 2
  check "server, operator '$bad': says why" said "$TMP/entry.out" "bad operator"
  check "server, operator '$bad': changed nothing" bash -c "grep -qxF 'comp-result: changed=no' '$TMP/entry.out' &&
    test ! -e '$SERVER/logs/20261007T120000Z-release-$TAG_B.log' && test ! -s '$FAKE_DOCKER_LOG' &&
    test ! -e '$SERVER/release.lease' && test '$(last_record)' = 'release $TAG_A ok'"
done

# record() on its own: without an operator, or with one that is not an ARN, the field is "-".
reset_server
for value in unset "bad operator" "$OPERATOR"; do
  (
    if [[ "$value" == unset ]]; then unset COMP_OPERATOR; else export COMP_OPERATOR="$value"; fi
    # shellcheck source=deploy/server/lib/server-common.sh
    COMP_ROOT="$SERVER" && source "$SERVER_DIR/lib/server-common.sh" && record release "$TAG_B" failed
  )
done
check "record: '-' without a valid operator, the ARN with one" \
  test "$(cut -d' ' -f2- "$SERVER/releases.log")" = "$(printf 'release %s failed %s\n' "$TAG_B" - "$TAG_B" - "$TAG_B" "$OPERATOR")"

# ---------------------------------------------------------------- lines from before the field
# released() writes four-field lines, as the server did before; a new line has five.
reset_server
released "$TAG_D" "$TAG_A"
release_sh "$TMP/mixed.out" release "$SHA_B"
check "old and new lines: the new release serves, recorded with five fields" \
  test "$(serving):$(tail -n 1 "$SERVER/releases.log" | awk '{ print NF }')" = "comp-api:$TAG_B:5"
release_sh "$TMP/mixed-status.out" status
check "old and new lines: status reads the history across them" \
  bash -c "grep -qF 'current: $TAG_B' '$TMP/mixed-status.out' && grep -qxF 'previous: $TAG_A' '$TMP/mixed-status.out'"
release_sh "$TMP/mixed-back.out" rollback
check "old and new lines: rollback goes to the old line's tag" test "$?:$(serving)" = "0:comp-api:$TAG_A"
release_sh "$TMP/mixed-back2.out" rollback
check "old and new lines: rolling back again walks further back, to an old line's tag" test "$?:$(serving)" = "0:comp-api:$TAG_D"
no_secret "operators" "$TMP"/*.out

check "shellcheck -x: this suite" bash -c "cd '$ROOT' && shellcheck -x deploy/server/tests/operator.test.sh"
finish

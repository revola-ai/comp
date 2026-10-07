#!/usr/bin/env bash
# Tests for `deploy/server/release.sh rollback`, `status` and `logs`, the server lock and the
# account checks. Run: bash deploy/server/tests/rollback.test.sh
# Laptop and server share one sandbox (tests/release-lib.sh); nothing reaches AWS or the server.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/server/tests/release-lib.sh
source "$SERVER_DIR/tests/release-lib.sh"
install_release_fakes
UP="up -d --no-build --wait --wait-timeout 600"

# ---------------------------------------------------------------- rollback to the previous ok release
reset_server
released "$TAG_D" "$TAG_A" "$TAG_B"
printf '2026-10-02T00:00:00Z release %s failed\n' "$TAG_C" >>"$SERVER/releases.log"
release_sh "$TMP/back.out" rollback
status=$?
check "rollback: exits zero" test "$status" -eq 0
check "rollback: brings back the ok release before the current one" \
  test "$(container_changes)" = "TAG=$TAG_A $COMPOSE_ARGV $UP"
check "rollback: serving it" test "$(serving)" = "comp-api:$TAG_A"
check "rollback: recorded ok" test "$(last_record)" = "rollback $TAG_A ok"
check "rollback: says what it will do first" grep -qF "Rolling back from $TAG_B to $TAG_A" "$TMP/back.out"
check "rollback: reads the tags, then up, then finish (3 SSM commands)" test "$(ssm_sends)" -eq 3
check "rollback: never checks out or builds" bash -c "! grep -qE 'checkout|fetch' '$FAKE_GIT_LOG' && ! grep -q bake '$FAKE_DOCKER_LOG'"
check "rollback: no migration check" bash -c "! grep -q 'run --rm' '$FAKE_DOCKER_LOG'"
check "rollback: smoke-checked" test -s "$FAKE_CURL_LOG"
check "rollback: up step allows 20 minutes" test "$(ssm_call 2 timeout)" = 1200
no_secret "rollback" "$TMP/back.out"

: >"$FAKE_DOCKER_LOG"
release_sh "$TMP/back2.out" rollback
check "second rollback: goes back to the release before (from $TAG_A to $TAG_B)" \
  test "$(container_changes)" = "TAG=$TAG_B $COMPOSE_ARGV $UP"

reset_server
released "$TAG_D" "$TAG_A" "$TAG_B"
release_sh "$TMP/explicit.out" rollback "$SHA_D"
check "rollback <sha>: exits zero" test "$?" -eq 0
check "rollback <sha>: brings back that tag" test "$(container_changes)" = "TAG=$TAG_D $COMPOSE_ARGV $UP"
check "rollback <sha>: recorded ok" test "$(last_record)" = "rollback $TAG_D ok"

reset_server
released "$TAG_A" "$TAG_B"
docker_state "s['images'].remove('comp-app:$TAG_A')"
release_sh "$TMP/missing.out" rollback
check "missing images: refused" test "$?" -ne 0
check "missing images: names the missing image" grep -qF "comp-app:$TAG_A" "$TMP/missing.out"
check "missing images: no container changed" test -z "$(container_changes)"
check "missing images: still serving" test "$(serving)" = "comp-api:$TAG_B"

reset_server
released "$TAG_A" "$TAG_B"
release_sh "$TMP/same.out" rollback "$TAG_B"
check "rollback to the serving tag: refused" test "$?" -ne 0
check "rollback to the serving tag: says so" grep -qF "already serving $TAG_B" "$TMP/same.out"
check "rollback to the serving tag: no container changed" test -z "$(container_changes)"

reset_server
released "$TAG_B"
release_sh "$TMP/none.out" rollback
check "no earlier release: refused" test "$?" -ne 0
check "no earlier release: says so" grep -qF "no earlier ok release" "$TMP/none.out"

reset_server
released "$TAG_A" "$TAG_B"
FAKE_DOCKER_FAIL_UP="$TAG_A" release_sh "$TMP/back-fails.out" rollback
check "rollback fails health: restores the tag that was serving" test "$(container_changes)" = \
  "$(printf '%s\n' "TAG=$TAG_A $COMPOSE_ARGV $UP" "TAG=$TAG_B $COMPOSE_ARGV $UP")"
check "rollback fails health: recorded as rolled back" test "$(last_record)" = "rollback $TAG_A rolled-back"
check "rollback fails health: says which tag serves" grep -qF "Now serving $TAG_B" "$TMP/back-fails.out"

# ---------------------------------------------------------------- one operation at a time
reset_server
released "$TAG_A"
mkdir -p "$SERVER"
exec 8>>"$SERVER/release.lock"
flock -n 8
release_sh "$TMP/locked.out" release "$SHA_B"
status=$?
exec 8>&-
check "locked: refused" test "$status" -ne 0
check "locked: says another operation is running" grep -qF "another release.sh step" "$TMP/locked.out"
check "locked: fails fast (one SSM command)" test "$(ssm_sends)" -eq 1
check "locked: no docker or git call on the server" \
  bash -c "! grep -q 'docker' '$FAKE_DOCKER_LOG' && ! grep -q '$SERVER/src' '$FAKE_GIT_LOG'"
check "locked: records nothing" test "$(last_record)" = "release $TAG_A ok"

reset_server
released "$TAG_D" "$TAG_A"
printf '20261007T120000Z-release-%s %s release %s\n' "$TAG_C" "$(($(date +%s) + 600))" "$TAG_C" >"$SERVER/release.lease"
release_sh "$TMP/leased.out" rollback "$TAG_D"
check "lease held by another run: refused" test "$?" -ne 0
check "lease held by another run: names it" grep -qF "release $TAG_C" "$TMP/leased.out"
check "lease held by another run: nothing changed" test -z "$(container_changes)"
check "lease held by another run: the lease stays" test -e "$SERVER/release.lease"

reset_server
released "$TAG_D" "$TAG_A"
printf '20261007T120000Z-release-%s %s release %s\n' "$TAG_C" "$(($(date +%s) - 1))" "$TAG_C" >"$SERVER/release.lease"
release_sh "$TMP/expired.out" rollback
check "expired lease: ignored" test "$(last_record)" = "rollback $TAG_D ok"

# entry.sh on its own (as SSM runs it): a step whose run lost the lease, and bad arguments
entry() { COMP_ROOT="$SERVER" bash "$SERVER_DIR/on-server/entry.sh" "$@" >"$TMP/entry.out" 2>&1; }
reset_server
released "$TAG_A"
entry 20261007T120000Z-finish-"$TAG_B".log 20261007T115900Z-release-"$TAG_B" own - release finish release "$TAG_B"
check "lapsed lease: refused with 75" test "$?" -eq 75
check "lapsed lease: says the run no longer holds the server" grep -qF "no longer holds the server" "$TMP/entry.out"
check "lapsed lease: records nothing" test "$(last_record)" = "release $TAG_A ok"
check "lapsed lease: ends with the meta block" test "$(tail -n 1 "$TMP/entry.out")" = "comp-end: 75"
for bad in "../../env/api.env 20261007T120000Z-release-$TAG_B new - release up release $TAG_B" \
  "20261007T120000Z-release-$TAG_B.log 20261007T120000Z-release-$TAG_B new main release up release $TAG_B" \
  "20261007T120000Z-release-$TAG_B.log 20261007T120000Z-release-$TAG_B new - ../x"; do
  # shellcheck disable=SC2086 # one word per argument
  entry $bad
  check "entry refuses: $bad" test "$?" -eq 2
done
check "entry refusals: nothing ran" test ! -s "$FAKE_DOCKER_LOG"
printf 'stale\n' >"$SERVER/logs/20261007T120000Z-release-$TAG_B.log"
entry 20261007T120000Z-release-"$TAG_B".log 20261007T120000Z-release-"$TAG_B" new - release up rollback "$TAG_B"
check "entry never overwrites a log" test "$(cat "$SERVER/logs/20261007T120000Z-release-$TAG_B.log")" = stale

# ---------------------------------------------------------------- account and instance checks
reset_server
released "$TAG_A"
FAKE_AWS_ACCOUNT=111111111111 release_sh "$TMP/account.out" status
check "other account: refused" grep -qF "not 455986776194" "$TMP/account.out"
check "other account: no SSM call" test "$(ssm_sends)" -eq 0
printf '{"instances": []}\n' >"$FAKE_AWS_STATE"
release_sh "$TMP/noinstance.out" status
check "no running comp-server: refused" grep -qF "no running instance named comp-server" "$TMP/noinstance.out"
printf '{"instances": ["i-0fake1", "i-0fake2"]}\n' >"$FAKE_AWS_STATE"
release_sh "$TMP/two.out" status
check "two running comp-server: refused" grep -qF "2 running instances named comp-server" "$TMP/two.out"
check "instance problems: no SSM call" test "$(ssm_sends)" -eq 0

# ---------------------------------------------------------------- status and logs
reset_server
released "$TAG_D" "$TAG_A"
release_sh "$TMP/status.out" status
check "status: exits zero" test "$?" -eq 0
check "status: current tag" grep -qF "current: $TAG_A" "$TMP/status.out"
check "status: previous tag" grep -qF "previous: $TAG_D" "$TMP/status.out"
check "status: last releases" grep -qF "release $TAG_D ok" "$TMP/status.out"
check "status: container health" grep -qF "(healthy)" "$TMP/status.out"
check "status: disk use of /" grep -qE "^Filesystem" "$TMP/status.out"
check "status: takes no lock and changes nothing" bash -c "test ! -e '$SERVER/release.lock' && test -z \"\$(grep -vE 'docker ps' '$FAKE_DOCKER_LOG')\""
check "status: quick SSM timeout" test "$(ssm_call 1 timeout)" = 120

release_sh "$TMP/logs-api.out" logs api
check "logs api: prints the aws logs tail command" \
  grep -qxF "aws logs tail /comp/api --follow --region us-east-2" "$TMP/logs-api.out"
check "logs: no AWS call" test "$(ssm_sends)" -eq 1
release_sh "$TMP/logs-bad.out" logs database
check "logs <unknown service>: refused" test "$?" -ne 0

reset_server
released "$TAG_A"
release_sh "$TMP/for-log.out" release "$SHA_B" >/dev/null
log_path="$(printf '%s\n' "$SERVER"/logs/*-release-"$TAG_B".log)"
log_name="${log_path##*/}"
python3 -c 'import sys; open(sys.argv[1], "a").write("".join(f"line {i} " + "x" * 120 + "\n" for i in range(900)))' "$SERVER/logs/$log_name"
release_sh "$TMP/fetched.out" logs --release "/opt/comp/logs/$log_name"
check "logs --release: exits zero" test "$?" -eq 0
check "logs --release: the last 500 lines, in order" \
  test "$(grep -E '^line [0-9]+ ' "$TMP/fetched.out" | cut -d' ' -f2 | tr '\n' ' ')" = "$(seq 400 899 | tr '\n' ' ')"
check "logs --release: fetched in pages under the SSM limit" test "$(ssm_sends)" -ge 6
for bad in /opt/comp/env/api.env ../env/api.env "/opt/comp/logs/../env/api.env" "$log_name.bak"; do
  release_sh "$TMP/badlog.out" logs --release "$bad"
  check "logs --release $bad: refused" test "$?" -ne 0
done
finish

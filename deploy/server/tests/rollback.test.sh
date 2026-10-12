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
check "rollback: never fetches or builds" bash -c "! grep -qE 'fetch|worktree add' '$FAKE_GIT_LOG' && ! grep -q bake '$FAKE_DOCKER_LOG'"
check "rollback: comes up with the tag's own snapshot" test "$(up_configs)" = "$TAG_A up releases/$TAG_A"
check "rollback: once recorded, /opt/comp/src is at the tag's SHA" test "$(cat "$FAKE_GIT_HEAD")" = "$SHA_A"
check "rollback: no migration check" bash -c "! grep -q 'run --rm' '$FAKE_DOCKER_LOG'"
check "rollback: smoke-checked" test -s "$FAKE_CURL_LOG"
check "rollback: up step allows 30 minutes (two 600 s waits and render)" test "$(ssm_call 2 timeout)" = 1800
no_secret "rollback" "$TMP/back.out"

# The serving history is a stack: release pushes, rollback pops back to its tag.
: >"$FAKE_DOCKER_LOG"
release_sh "$TMP/back2.out" rollback
check "second rollback: goes on to the release before ($TAG_A to $TAG_D), never back to $TAG_B" \
  test "$(container_changes)" = "TAG=$TAG_D $COMPOSE_ARGV $UP"
check "second rollback: says so first" grep -qF "Rolling back from $TAG_A to $TAG_D" "$TMP/back2.out"
release_sh "$TMP/back3.out" rollback
check "third rollback: nothing below $TAG_D, refused" grep -qF "no earlier ok release" "$TMP/back3.out"
check "third rollback: no container changed" test "$(serving)" = "comp-api:$TAG_D"

reset_server
released "$TAG_D" "$TAG_A" "$TAG_B"
release_sh "$TMP/stack1.out" rollback >/dev/null
release_sh "$TMP/stack2.out" release "$SHA_B"
check "release after a rollback: serving $TAG_B again" test "$(last_record)" = "release $TAG_B ok"
: >"$FAKE_DOCKER_LOG"
release_sh "$TMP/stack3.out" rollback
check "release after a rollback, then rollback: back to $TAG_A" \
  test "$(container_changes)" = "TAG=$TAG_A $COMPOSE_ARGV $UP"
: >"$FAKE_DOCKER_LOG"
release_sh "$TMP/stack4.out" rollback
check "and again: on to $TAG_D" test "$(container_changes)" = "TAG=$TAG_D $COMPOSE_ARGV $UP"

reset_server
released "$TAG_D" "$TAG_A" "$TAG_B"
release_sh "$TMP/explicit-first.out" rollback "$TAG_D" >/dev/null
: >"$FAKE_DOCKER_LOG"
release_sh "$TMP/explicit-then.out" rollback
check "rollback <sha> pops everything above it: a default rollback then has nothing below" \
  grep -qF "no earlier ok release" "$TMP/explicit-then.out"
check "rollback <sha> then default: no container changed" test -z "$(container_changes)"

reset_server
release_sh "$TMP/empty.out" rollback
check "no release at all: refused" test "$?" -ne 0
check "no release at all: says so" grep -qF "no earlier ok release" "$TMP/empty.out"
check "no release at all: one read-only SSM command" test "$(ssm_sends)" -eq 1

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
entry 20261007T120000Z-finish-"$TAG_B".log 20261007T115900Z-release-"$TAG_B"-0123abcd own - release finish release "$TAG_B"
check "lapsed lease: refused with 75" test "$?" -eq 75
check "lapsed lease: says the run no longer holds the server" grep -qF "no longer holds the server" "$TMP/entry.out"
check "lapsed lease: records nothing" test "$(last_record)" = "release $TAG_A ok"
check "lapsed lease: ends with the meta block" test "$(tail -n 1 "$TMP/entry.out")" = "comp-end: 75"
for bad in "../../env/api.env 20261007T120000Z-release-$TAG_B-0123abcd new - release up release $TAG_B" \
  "20261007T120000Z-release-$TAG_B.log 20261007T120000Z-release-$TAG_B-0123abcd new main release up release $TAG_B" \
  "20261007T120000Z-release-$TAG_B.log 20261007T120000Z-release-$TAG_B-0123abcd new - ../x" \
  "20261007T120000Z-release-$TAG_B.log 20261007T120000Z-release-$TAG_B new - release up release $TAG_B"; do
  # shellcheck disable=SC2086 # one word per argument
  entry $bad
  check "entry refuses: $bad" test "$?" -eq 2
done
check "entry refusals: nothing ran" test ! -s "$FAKE_DOCKER_LOG"
entry 20261007T120000Z-release-"$TAG_X".log 20261007T120000Z-release-"$TAG_X"-0123abcd new "$SHA_X" release up release "$TAG_X"
check "entry refuses a SHA only on a feature branch" test "$?" -eq 1
check "entry refuses a SHA only on a feature branch: names revola/self-host" grep -qF "is not on revola/self-host" "$TMP/entry.out"
check "entry refuses a SHA only on a feature branch: changed nothing" grep -qxF "comp-result: changed=no" "$TMP/entry.out"
check "entry refuses a SHA only on a feature branch: never checks it out, no docker call" \
  bash -c "! grep -q 'checkout' '$FAKE_GIT_LOG' && test ! -s '$FAKE_DOCKER_LOG'"
printf 'stale\n' >"$SERVER/logs/20261007T120000Z-release-$TAG_B.log"
entry 20261007T120000Z-release-"$TAG_B".log 20261007T120000Z-release-"$TAG_B"-0123abcd new - release up rollback "$TAG_B"
check "entry never overwrites a log" test "$(cat "$SERVER/logs/20261007T120000Z-release-$TAG_B.log")" = stale

# The server lock: finish, revert and unlock ("own" steps of a run) wait up to 120 s for it, so
# the reboot check or a security update skipping under the lease cannot make them fail; a new
# step never waits. The fake flock waits at most 2 real seconds (FAKE_FLOCK_MAX_WAIT).
own_lease() { printf '20261007T120000Z-release-%s-0123abcd %s release %s\n' "$TAG_C" "$(($(date +%s) + 600))" "$TAG_C" >"$SERVER/release.lease"; }
unlock_c() { entry "20261007T12010$1Z-unlock-$TAG_C.log" "20261007T120000Z-release-$TAG_C-0123abcd" own - release unlock release "$TAG_C"; }
reset_server
released "$TAG_A"
own_lease
export FAKE_FLOCK_LOG="$TMP/flock.log"
: >"$FAKE_FLOCK_LOG"
# The holder lets go once the own step is waiting for the lock (its flock call is logged), not
# after a fixed time, so the wait ends on that condition however slow the machine is.
python3 -c 'import fcntl, os, sys, time
f = open(sys.argv[1], "a"); fcntl.flock(f, fcntl.LOCK_EX); open(sys.argv[2], "w").close()
deadline = time.monotonic() + 60
while "flock -w" not in open(sys.argv[3]).read() and time.monotonic() < deadline: time.sleep(0.05)' \
  "$SERVER/release.lock" "$TMP/held" "$FAKE_FLOCK_LOG" &
holder=$!
until [[ -e "$TMP/held" ]]; do /bin/sleep 0.05; done
FAKE_FLOCK_MAX_WAIT=60 unlock_c 1
check "an own step waits for a lock held briefly" test "$?" -eq 0
wait "$holder"
check "an own step waits for a lock held briefly: it ran" test "$(last_record):$(test -e "$SERVER/release.lease" && echo leased)" = "release $TAG_C unlocked:"
check "an own step waits at most 120 s" grep -qxF "flock -w 120 9" "$FAKE_FLOCK_LOG"
own_lease
exec 8>>"$SERVER/release.lock"
flock -n 8
unlock_c 2
check "an own step refused after its wait: 75" test "$?" -eq 75
check "an own step refused after its wait: says how long it waited" grep -qF "waited 120 seconds for the server lock" "$TMP/entry.out"
check "an own step refused after its wait: the lease stays" test -s "$SERVER/release.lease"
: >"$FAKE_FLOCK_LOG"
rm -f "$SERVER/release.lease"
entry "20261007T120200Z-release-$TAG_B.log" "20261007T120200Z-release-$TAG_B-0123abcd" new "$SHA_B" build "$TAG_B"
check "a new step never waits for the lock" test "$?:$(cat "$FAKE_FLOCK_LOG")" = "75:flock -n 9"
exec 8>&-
unset FAKE_FLOCK_LOG

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
check "status: the tags with a snapshot" grep -qxF "snapshots (rollback targets, with their images): $TAG_A $TAG_D" "$TMP/status.out"
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
for bad in "/opt/comp/releases/$TAG_A/env/api.env" ../releases/api.env "/opt/comp/logs/../releases/$TAG_A/sha" "$log_name.bak"; do
  release_sh "$TMP/badlog.out" logs --release "$bad"
  check "logs --release $bad: refused" test "$?" -ne 0
done
finish

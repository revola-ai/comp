#!/usr/bin/env bash
# Tests for `deploy/server/release.sh release` when a step ends abnormally (SSM timed out,
# cancelled, undeliverable or terminated), its output is cut short (SSM keeps 24,000
# characters), or what it reports would be wrong.
# Run: bash deploy/server/tests/release-failures.test.sh
# Laptop and server share one sandbox (tests/release-lib.sh); nothing reaches AWS or the server.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/server/tests/release-lib.sh
source "$SERVER_DIR/tests/release-lib.sh"
install_release_fakes
LOG_NAME_RE='[0-9]{8}T[0-9]{6}Z-[a-z-]+-[0-9a-f]{12}\.log'

# ---------------------------------------------------------------- the up step ends abnormally
for ending in "TimedOut:ExecutionTimedOut:-1" "Cancelled:Cancelled:-1" "Failed:Undeliverable:-1" \
  "Failed:Terminated:-1" "Failed:Failed:9"; do
  reset_server
  released "$TAG_A"
  FAKE_SSM_END="1:$ending" release_sh "$TMP/ending.out" release "$SHA_B"
  check "up ends $ending: exits non-zero" test "$?" -ne 0
  check "up ends $ending: the serving state is unknown" grep -qF "serving state is unknown" "$TMP/ending.out"
  check "up ends $ending: prints the status command" grep -qF "deploy/server/release.sh status" "$TMP/ending.out"
  check "up ends $ending: never claims no container changed" bash -c "! grep -qF 'before any container changed' '$TMP/ending.out'"
  check "up ends $ending: no smoke check, no finish" test "$(ssm_sends):$(wc -c <"$FAKE_CURL_LOG" | tr -d ' ')" = "2:0"
  reset_server
  released "$TAG_A"
  FAKE_SSM_END="0:$ending" release_sh "$TMP/build-ending.out" release "$SHA_B"
  check "build ends $ending: exits non-zero" test "$?" -ne 0
  check "build ends $ending: a build changes no container, so the earlier release serves" \
    grep -qF "it changes no container, so the earlier release still serves" "$TMP/build-ending.out"
  check "build ends $ending: no up step" test "$(ssm_sends)" -eq 1
done
reset_server
released "$TAG_A"
FAKE_SSM_TRUNCATE=40 FAKE_DOCKER_FAIL_UP="$TAG_B" release_sh "$TMP/cut-fail.out" release "$SHA_B"
check "cut output of a failed up: the serving state is unknown" grep -qF "serving state is unknown" "$TMP/cut-fail.out"
check "cut output of a failed up: never claims no container changed" \
  bash -c "! grep -qF 'before any container changed' '$TMP/cut-fail.out'"

# ---------------------------------------------------------------- SSM keeps 24,000 characters
reset_server
released "$TAG_A"
FAKE_SSM_TRUNCATE=40 release_sh "$TMP/cut.out" release "$SHA_B"
cut_status=$?
check "cut output: the release still completes" test "$(last_record)" = "release $TAG_B ok"
check "cut output: says the output was cut short" grep -qF "cut short" "$TMP/cut.out"
check "cut output: prints where the full log is" grep -qE "/opt/comp/logs/$LOG_NAME_RE" "$TMP/cut.out"
check "cut output: prints the command that fetches it" grep -qF "deploy/server/release.sh logs --release" "$TMP/cut.out"
check "cut output of finish: whether it was recorded is unknown" \
  grep -qF "The output of the finish step of $TAG_B was cut short, so whether it was recorded is unknown" "$TMP/cut.out"
check "cut output of finish: points at status" \
  grep -qF "check with deploy/server/release.sh status (its last releases list a recorded release)" "$TMP/cut.out"
check "cut output of finish: never says to rerun or that recording failed" \
  bash -c "! grep -qiE 'rerun|recording it failed|could not record' '$TMP/cut.out'"
check "cut output of finish: exits 1 (the outcome is unknown)" test "$cut_status" -eq 1

# ---------------------------------------------------------------- the previous tag cannot come back (exit 6)
reset_server
released "$TAG_D" "$TAG_A"
docker_state "s['images'].remove('comp-app:$TAG_A')"
FAKE_DOCKER_FAIL_UP="$TAG_B" release_sh "$TMP/gone.out" release "$SHA_B"
check "previous images gone: exits non-zero" test "$?" -ne 0
check "previous images gone: the server names them" grep -qF "the images of $TAG_A are gone (comp-app:$TAG_A" "$TMP/gone.out"
check "previous images gone: the laptop says the restore failed and the site may be down" \
  grep -qF "COULD NOT BRING THE PREVIOUS RELEASE BACK: $TAG_B failed, and restoring the release before it failed too (above); the site may be down" "$TMP/gone.out"
check "previous images gone: never claims the server did not report" bash -c "! grep -qF 'did not report how the step ended' '$TMP/gone.out'"
check "previous images gone: recorded as failed" test "$(last_record)" = "release $TAG_B failed"
reset_server
released "$TAG_D" "$TAG_A"
FAKE_DOCKER_FAIL_UP="$TAG_B $TAG_A" release_sh "$TMP/both.out" release "$SHA_B"
check "restore up fails too: exits non-zero" test "$?" -ne 0
check "restore up fails too: the server says so" grep -qF "BRINGING $TAG_A BACK FAILED TOO" "$TMP/both.out"
check "restore up fails too: the laptop says the site may be down" grep -qF "COULD NOT BRING THE PREVIOUS RELEASE BACK" "$TMP/both.out"
check "restore up fails too: points at status" grep -qF "deploy/server/release.sh status" "$TMP/both.out"
check "restore up fails too: never claims the server did not report" bash -c "! grep -qF 'did not report how the step ended' '$TMP/both.out'"

# ---------------------------------------------------------------- the up step after the build step
# Another step may run between the build and the up step (no lease yet): the up step checks again.
reset_server
released "$TAG_A"
COMP_ROOT="$SERVER" bash "$SERVER_DIR/on-server/entry.sh" "20261007T120000Z-release-$TAG_B.log" \
  "20261007T120000Z-release-$TAG_B-0123abcd" new "$SHA_B" release up release "$TAG_B" >"$TMP/unbuilt.out" 2>&1
check "up with an image missing since the build: refused" test "$?" -eq 1
check "up with an image missing since the build: says to release again" \
  grep -qF "(removed since the build step?); release $TAG_B again, which builds them" "$TMP/unbuilt.out"
check "up with an image missing since the build: changed nothing" grep -qxF "comp-result: changed=no" "$TMP/unbuilt.out"
check "up with an image missing since the build: never builds, no container changed" \
  bash -c "! grep -q 'buildx bake' '$FAKE_DOCKER_LOG' && test -z \"\$(grep -E ' (up|stop)( |\$)' '$FAKE_DOCKER_LOG')\""

# ---------------------------------------------------------------- state writes that fail
lease_holder() { cut -d' ' -f1 "$SERVER/release.lease" 2>/dev/null; }
reset_server
released "$TAG_A"
chmod 444 "$SERVER/releases.log" # appending fails, as on a full disk
release_sh "$TMP/norecord.out" release "$SHA_B"
check "finish cannot record: exits non-zero" test "$?" -ne 0
check "finish cannot record: the server says so" grep -qF "COULD NOT RECORD 'release $TAG_B ok'" "$SERVER"/logs/*-finish-"$TAG_B".log
check "finish cannot record: never reports recorded=ok" bash -c "! grep -qF 'recorded=ok' '$SERVER'/logs/*-finish-$TAG_B.log"
check "finish cannot record: the run keeps its lease" test "$(lease_holder)" = "$(ssm_call 1 args | cut -d' ' -f2)"
check "finish cannot record: the laptop says it is not recorded, and what to do" bash -c "
  grep -qF '$TAG_B is up and passes the smoke checks, but the server could not record it (above)' '$TMP/norecord.out' &&
  grep -qF 'then run deploy/server/release.sh unlock and release $TAG_B again' '$TMP/norecord.out'"
check "finish cannot record: never says released" bash -c "! grep -qF 'Released $TAG_B' '$TMP/norecord.out'"
check "finish cannot record: /opt/comp/src stays at the recorded release" test "$(cat "$FAKE_GIT_HEAD")" = "$SHA_A"
chmod 644 "$SERVER/releases.log"

reset_server
released "$TAG_A"
mkdir -p "$SERVER/release.lease" # the lease file cannot be written
release_sh "$TMP/nolease.out" release "$SHA_B"
check "up cannot take the lease: exits non-zero" test "$?" -ne 0
check "up cannot take the lease: says so" grep -qF "COULD NOT WRITE the lease" "$TMP/nolease.out"
check "up cannot take the lease: brings the previous tag back at once" test "$(up_configs)" = \
  "$(printf '%s\n' "$TAG_B up stage" "$TAG_A up releases/$TAG_A")"
check "up cannot take the lease: serving the previous tag, recorded as rolled back" \
  test "$(serving):$(last_record)" = "comp-api:$TAG_A:release $TAG_B rolled-back"
check "up cannot take the lease: no smoke check of $TAG_B, no finish (build and up only)" test "$(ssm_sends)" -eq 2
check "up cannot take the lease: says which tag serves" grep -qF "Now serving $TAG_A" "$TMP/nolease.out"

# ---------------------------------------------------------------- slow smoke checks and the lease
# Every check passes, but only on its 24th try after 23 timeouts (10 s each, 5 s apart): five
# checks would take about 1,775 s, more than the 1,200 s lease. Time is fake (FAKE_CLOCK).
reset_server
released "$TAG_A"
date +%s >"$TMP/clock"
FAKE_CLOCK="$TMP/clock" FAKE_CURL_SLOW=23 release_sh "$TMP/slow.out" release "$SHA_B"
check "slow smoke checks: exits non-zero" test "$?" -ne 0
check "slow smoke checks: stop at their deadline, half the lease" grep -qF \
  "when the smoke checks' deadline passed (600 s for all of them: half the 1200-second lease)" "$TMP/slow.out"
check "slow smoke checks: the revert is accepted under the run's lease" bash -c "! grep -qF 'no longer holds the server' '$TMP/slow.out'"
check "slow smoke checks: the previous tag serves again" test "$(serving):$(last_record)" = "comp-api:$TAG_A:release $TAG_B rolled-back"
check "slow smoke checks: no lease left" test ! -e "$SERVER/release.lease"
check "slow smoke checks: a try never runs past the deadline (curl --max-time is capped)" \
  bash -c "! grep -qF 'answered 000 on 24 tries' '$TMP/slow.out'"
reset_server
released "$TAG_A"
FAKE_CURL_BAD_TAG="$TAG_B" release_sh "$TMP/bad-api.out" release "$SHA_B"
check "a failing check says how long it tried, from the constants" \
  grep -qF "FAIL  https://api.comp.revola.ai/v1/health/ready answered 502 on all 24 tries, 5 seconds apart" "$TMP/bad-api.out"
check "a failing check never claims 2 minutes" bash -c "! grep -qF 'for 2 minutes' '$TMP/bad-api.out'"

# ---------------------------------------------------------------- the lease runs out before finish or revert
# A laptop that slept during a check: the clock jumps 1,300 s, past the 1,200 s lease, during one
# try (FAKE_CURL_JUMP), so the server refuses the run's finish or revert (its lease expired).
for case in "finish:5:" "revert:1:$TAG_B"; do
  IFS=: read -r own_step jump_at bad_tag <<<"$case"
  reset_server
  released "$TAG_A"
  date +%s >"$TMP/clock"
  FAKE_CLOCK="$TMP/clock" FAKE_CURL_JUMP="$jump_at:1300" FAKE_CURL_BAD_TAG="$bad_tag" release_sh "$TMP/lapsed.out" release "$SHA_B"
  check "lease ran out before $own_step: exits non-zero" test "$?" -ne 0
  check "lease ran out before $own_step: the server refuses it" grep -qF "no longer holds the server (its lease expired)" "$TMP/lapsed.out"
  check "lease ran out before $own_step: nothing recorded" test "$(grep -c " $TAG_B " "$SERVER/releases.log")" -eq 0
  check "lease ran out before $own_step: $TAG_B still serves" test "$(serving)" = "comp-api:$TAG_B"
  check "lease ran out before $own_step: says the $own_step step was refused" grep -qF "The $own_step step of $TAG_B was refused (above)" "$TMP/lapsed.out"
  check "lease ran out before $own_step: points at status and unlock" grep -qF \
    "Check deploy/server/release.sh status (a lease it lists is freed with deploy/server/release.sh unlock)" "$TMP/lapsed.out"
  check "lease ran out before $own_step: never claims the server did not report" bash -c "! grep -qF 'did not report how the step ended' '$TMP/lapsed.out'"
  check "lease ran out before $own_step: never says released" bash -c "! grep -qF 'Released $TAG_B' '$TMP/lapsed.out'"
done
check "a check the deadline stopped after one try says so in the singular" \
  grep -qF "answered 502 after 1 try, when the smoke checks' deadline passed" "$TMP/lapsed.out"

# ---------------------------------------------------------------- SSM errors while waiting for a step
polls_of() { grep -c "^aws ssm get-command-invocation --command-id $1 " "$FAKE_AWS_LOG"; }
reset_server
released "$TAG_A"
FAKE_SSM_POLL_ERRORS=3 release_sh "$TMP/flaky.out" release "$SHA_B"
check "a few failed polls (throttling): the release completes" test "$?:$(last_record)" = "0:release $TAG_B ok"
reset_server
released "$TAG_A"
FAKE_SSM_POLL_ERRORS=100@fake-command-1 release_sh "$TMP/lost-up.out" release "$SHA_B"
check "polls failing during the up step: exits non-zero" test "$?" -ne 0
check "polls failing during the up step: gives up after 12 in a row, saying so" \
  test "$(polls_of fake-command-1):$(grep -c 'could not read SSM command fake-command-1 12 times in a row' "$TMP/lost-up.out")" = "12:1"
check "polls failing during the up step: the guidance of leaving it running" grep -qF \
  "Next: deploy/server/release.sh status, then deploy/server/release.sh unlock, then release (or roll back to) the SHA that should serve." "$TMP/lost-up.out"
check "polls failing during the up step: sends nothing else" test "$(ssm_sends)" -eq 2
reset_server
released "$TAG_A"
FAKE_SSM_POLL_ERRORS=100@fake-command-2 release_sh "$TMP/lost-finish.out" release "$SHA_B"
check "polls failing during finish: points at status, the step's log and unlock" bash -c "
  grep -qF 'The finish step is still running on the server; check it with deploy/server/release.sh status' '$TMP/lost-finish.out' &&
  grep -qF 'free it with deploy/server/release.sh unlock' '$TMP/lost-finish.out'"

reset_server
released "$TAG_A"
FAKE_SSM_NOT_YET=12 release_sh "$TMP/not-yet.out" release "$SHA_B"
check "SSM not knowing each new command for 12 polls (InvocationDoesNotExist): the release completes" \
  test "$?:$(last_record)" = "0:release $TAG_B ok"
check "SSM not knowing a new command yet: polled on (12 times not yet, once in progress, then done)" test "$(polls_of fake-command-1)" -eq 14
reset_server
released "$TAG_A"
FAKE_SSM_PENDING_POLLS=1000 release_sh "$TMP/gave-up.out" status
check "a step that never ends: exits non-zero" test "$?" -ne 0
check "a step that never ends: gives up after its poll budget ((120 + 600 + 300) / 5), saying so" grep -qF \
  "gave up waiting for SSM command fake-command-0 after 204 polls; it may still run (aws ssm get-command-invocation --command-id fake-command-0" "$TMP/gave-up.out"
check "a step that never ends: polled exactly that often" test "$(polls_of fake-command-0)" -eq 204
check "a step that never ends: points at status and unlock" grep -qF \
  "Check the server with deploy/server/release.sh status; free a lease left behind with deploy/server/release.sh unlock." "$TMP/gave-up.out"

check "shellcheck -x: this suite" bash -c "cd '$ROOT' && shellcheck -x deploy/server/tests/release-failures.test.sh"
finish

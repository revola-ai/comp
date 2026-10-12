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
check "cut output: the release still completes" test "$(last_record)" = "release $TAG_B ok"
check "cut output: says the output was cut short" grep -qF "cut short" "$TMP/cut.out"
check "cut output: prints where the full log is" grep -qE "/opt/comp/logs/$LOG_NAME_RE" "$TMP/cut.out"
check "cut output: prints the command that fetches it" grep -qF "deploy/server/release.sh logs --release" "$TMP/cut.out"

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

check "shellcheck -x: this suite" bash -c "cd '$ROOT' && shellcheck -x deploy/server/tests/release-failures.test.sh"
finish

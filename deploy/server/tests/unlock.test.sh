#!/usr/bin/env bash
# Tests for `deploy/server/release.sh unlock`, which frees the lease a release or rollback left
# between its steps when its laptop stopped. Run: bash deploy/server/tests/unlock.test.sh
# Laptop and server share one sandbox (tests/release-lib.sh); nothing reaches AWS or a server.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/server/tests/release-lib.sh
source "$SERVER_DIR/tests/release-lib.sh"
install_release_fakes
said() { grep -qF -- "$2" "$1"; } # said <output> <text>

lease() { # lease <seconds left> <what>: a lease of a run that stopped between its steps
  printf '20261007T120000Z-release-%s-0123abcd %s %s\n' "$TAG_C" "$(($(date +%s) + $1))" "$2" >"$SERVER/release.lease"
}
reset_server
released "$TAG_A"
date +%s >"$TMP/clock"
export FAKE_CLOCK="$TMP/clock" # the lease's age is exact, however long the steps take
lease 600 "release $TAG_C"
harness --no-tty --stdin unlock --cwd "$TMP/cwd" --out "$TMP/u-notty.out" -- bash "$SERVER_DIR/release.sh" unlock
check "unlock without a terminal: refused" test "$?" -ne 0
check "unlock without a terminal: no AWS call" test ! -s "$FAKE_AWS_LOG"

release_typed "no" "$TMP/u-no.out" unlock
check "unlock declined: exits non-zero" test "$?" -ne 0
check "unlock declined: shows the holder and its age" \
  grep -qF "release $TAG_C (run 20261007T120000Z-release-$TAG_C-0123abcd), taken 600 seconds ago, for 600 more seconds" "$TMP/u-no.out"
check "unlock declined: the lease stays" test -s "$SERVER/release.lease"
check "unlock declined: one read-only SSM command" test "$(ssm_sends)" -eq 1

: >"$FAKE_AWS_LOG"
release_typed "unlock" "$TMP/u-yes.out" unlock
check "unlock: exits zero" test "$?" -eq 0
check "unlock: asks for the word unlock" said "$TMP/u-yes.out" "Type unlock"
check "unlock: removes the lease under that run" grep -qE \
  "^[0-9]{8}T[0-9]{6}Z-unlock-$TAG_C\.log 20261007T120000Z-release-$TAG_C-0123abcd $OPERATOR own - release unlock release $TAG_C\$" <<<"$(ssm_call 2 args)"
check "unlock: the lease is gone" test ! -e "$SERVER/release.lease"
check "unlock: recorded" test "$(last_record)" = "release $TAG_C unlocked"
check "unlock: no container changed" test -z "$(container_changes)"

reset_server
released "$TAG_A"
lease 600 "release $TAG_C"
exec 8>>"$SERVER/release.lock"
flock -n 8
release_typed "unlock" "$TMP/u-running.out" unlock
check "unlock while a step runs: refused" test "$?" -ne 0
exec 8>&-
check "unlock while a step runs: says so" said "$TMP/u-running.out" "a step is running on the server"
check "unlock while a step runs: the lease stays" test -s "$SERVER/release.lease"

reset_server
released "$TAG_A"
release_typed "unlock" "$TMP/u-none.out" unlock
check "unlock with no lease: exits zero" test "$?" -eq 0
check "unlock with no lease: says so" said "$TMP/u-none.out" "No lease on the server"
check "unlock with no lease: never asks" bash -c "! grep -qF 'Type unlock' '$TMP/u-none.out'"

lease -5 "release $TAG_C"
release_typed "unlock" "$TMP/u-expired.out" unlock
check "unlock with an expired lease: exits zero" test "$?" -eq 0
check "unlock with an expired lease: says it blocks nothing" said "$TMP/u-expired.out" "blocks nothing"
check "unlock with an expired lease: never asks" bash -c "! grep -qF 'Type unlock' '$TMP/u-expired.out'"
no_secret "unlock" "$TMP"/*.out

check "shellcheck -x: this suite" bash -c "cd '$ROOT' && shellcheck -x deploy/server/tests/unlock.test.sh"
finish

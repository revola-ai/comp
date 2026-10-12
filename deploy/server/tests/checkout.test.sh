#!/usr/bin/env bash
# Tests for the checkouts on the server: /opt/comp/src following the serving release (the
# laptop warning when a finish step could not move it, status showing it, rollback refusing
# while it lags behind).
# Run: bash deploy/server/tests/checkout.test.sh
# Laptop and server share one sandbox (tests/release-lib.sh); nothing reaches AWS or the server.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/server/tests/release-lib.sh
source "$SERVER_DIR/tests/release-lib.sh"
install_release_fakes
said() { grep -qF -- "$2" "$1"; } # said <output> <text>
src_at() { test "$(cat "$FAKE_GIT_HEAD")" = "$1"; } # src_at <sha>: where /opt/comp/src is

# ---------------------------------------------------------------- the finish step cannot move /opt/comp/src
reset_server
released "$TAG_D" "$TAG_A"
FAKE_GIT_FAIL_CHECKOUT=1 release_sh "$TMP/stuck.out" release "$SHA_B"
check "/opt/comp/src cannot move: exits non-zero" test "$?" -ne 0
check "/opt/comp/src cannot move: the release stands, recorded" test "$(last_record):$(serving)" = "release $TAG_B ok:comp-api:$TAG_B"
check "/opt/comp/src cannot move: says it is released" said "$TMP/stuck.out" "Released $TAG_B: it serves and passes the smoke checks (release)."
check "/opt/comp/src cannot move: a WARNING line says so" said "$TMP/stuck.out" \
  "WARNING: /opt/comp/src did not move to $TAG_B (above), so it still holds the scripts of the release before it."
check "/opt/comp/src cannot move: says what that means" said "$TMP/stuck.out" \
  "rollback, prune and unlock run those scripts, and rollback refuses until /opt/comp/src is at $TAG_B;"
check "/opt/comp/src cannot move: says what to do" said "$TMP/stuck.out" \
  "fix the cause (above), then release $TAG_B again, which moves it."
check "/opt/comp/src cannot move: it stays at $TAG_A" src_at "$SHA_A"
release_sh "$TMP/stuck-status.out" status
check "status: the current tag and where /opt/comp/src is" \
  grep -qxF "current: $TAG_B (/opt/comp/src at $TAG_A)" "$TMP/stuck-status.out"
check "status: a WARNING line when they differ" grep -qxF \
  "WARNING: /opt/comp/src is at $TAG_A, not at the current tag $TAG_B: rollback refuses until it is; release $TAG_B again to move it" \
  "$TMP/stuck-status.out"
: >"$FAKE_DOCKER_LOG"
release_sh "$TMP/stuck-back.out" rollback
check "rollback while /opt/comp/src lags: refused" test "$?" -ne 0
check "rollback while /opt/comp/src lags: says why and how to fix it" said "$TMP/stuck-back.out" \
  "Refusing: /opt/comp/src is at $TAG_A, not at the serving $TAG_B, so this rollback would run the scripts of another release; release $TAG_B again (deploy/server/release.sh release $TAG_B), which moves it, then roll back."
check "rollback while /opt/comp/src lags: before any container changed" said "$TMP/stuck-back.out" "before any container changed"
check "rollback while /opt/comp/src lags: no container changed" test -z "$(container_changes)"
check "rollback while /opt/comp/src lags: recorded failed" test "$(last_record)" = "rollback $TAG_A failed"
release_sh "$TMP/unstuck.out" release "$SHA_B"
check "released again: exits zero, /opt/comp/src at $TAG_B" bash -c "test $? -eq 0 && test \"\$(cat '$FAKE_GIT_HEAD')\" = '$SHA_B'"
check "released again: no warning" bash -c "! grep -qF WARNING '$TMP/unstuck.out'"
release_sh "$TMP/unstuck-status.out" status
check "status: /opt/comp/src at the current tag, no warning" bash -c \
  "grep -qxF 'current: $TAG_B (/opt/comp/src at $TAG_B)' '$TMP/unstuck-status.out' && ! grep -qF WARNING '$TMP/unstuck-status.out'"
release_sh "$TMP/unstuck-back.out" rollback
check "then the rollback works" test "$?:$(serving)" = "0:comp-api:$TAG_A"

check "shellcheck -x: this suite" bash -c "cd '$ROOT' && shellcheck -x deploy/server/tests/checkout.test.sh"
finish

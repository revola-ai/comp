#!/usr/bin/env bash
# Tests for the checkouts on the server: /opt/comp/src following the serving release (the
# laptop warning when a finish step could not move it, status showing it, rollback refusing
# while it lags behind) and the released commits pinned in it (refs/comp/releases/<tag>).
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

# ---------------------------------------------------------------- released commits are pinned
# refs/comp/releases/<tag> keeps each released commit from git gc, so a rollback can check it
# out even after revola/self-host was force-pushed past it (FAKE_GIT_GONE: no branch holds it).
refs_of() { cut -d' ' -f1 "$FAKE_GIT_REFS" | sed 's|^refs/comp/releases/||' | sort | tr '\n' ' '; }
unpin() { grep -v "^refs/comp/releases/$1 " "$FAKE_GIT_REFS" >"$FAKE_GIT_REFS.new"; mv -f "$FAKE_GIT_REFS.new" "$FAKE_GIT_REFS"; }
reset_server
released "$TAG_D" "$TAG_A"
release_sh "$TMP/pin.out" release "$SHA_B"
check "a release pins its commit" bash -c "grep -qxF 'git -C $SERVER/src update-ref refs/comp/releases/$TAG_B $SHA_B' '$FAKE_GIT_LOG' &&
  grep -qxF 'refs/comp/releases/$TAG_B $SHA_B' '$FAKE_GIT_REFS'"
FAKE_GIT_GONE="$SHA_A" release_sh "$TMP/force-pushed.out" rollback
check "rollback to a commit no branch holds any more: /opt/comp/src moves to it (pinned)" \
  test "$?:$(cat "$FAKE_GIT_HEAD")" = "0:$SHA_A"
check "rollback to a commit no branch holds any more: no warning" bash -c "! grep -qF WARNING '$TMP/force-pushed.out'"
check "a rollback pins nothing new" test "$(grep -c ' update-ref ' "$FAKE_GIT_LOG")" -eq 1
unpin "$TAG_D"
FAKE_GIT_GONE="$SHA_D" release_sh "$TMP/unpinned.out" rollback
check "an unpinned commit gc dropped: /opt/comp/src cannot move to it (what the pin prevents)" \
  bash -c "test \"\$(cat '$FAKE_GIT_HEAD')\" = '$SHA_A' && grep -qF 'WARNING: /opt/comp/src did not move to $TAG_D' '$TMP/unpinned.out'"

reset_server
released "$TAG_A"
FAKE_GIT_FAIL_UPDATE_REF=1 release_sh "$TMP/nopin.out" release "$SHA_B"
check "the pin cannot be written: exits non-zero" test "$?" -ne 0
check "the pin cannot be written: the server says it is not recorded" \
  said "$TMP/nopin.out" "Not recorded: $TAG_B serves, but its commit could not be pinned (above)."
check "the pin cannot be written: nothing recorded, no snapshot, /opt/comp/src stays" \
  test "$(last_record):$(test -e "$SERVER/releases/$TAG_B" && echo kept):$(cat "$FAKE_GIT_HEAD")" = "release $TAG_A ok::$SHA_A"
check "the pin cannot be written: the run keeps its lease, the laptop says so" bash -c "test -s '$SERVER/release.lease' &&
  grep -qF 'but the server could not record it (above); its lease stays' '$TMP/nopin.out'"

TAG_E=eeeeeeeeeeee TAG_F=ffffffffffff
reset_server
released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A" "$TAG_B"
rm -rf "${SERVER:?}/releases/$TAG_F" # its snapshot removed by hand; its pin stays
release_typed "prune" "$TMP/prune.out" prune
check "prune unpins the tags whose snapshots it removes, and a pin left without one" \
  test "$(refs_of)" = "$TAG_A $TAG_B $TAG_C $TAG_D "
check "prune says so" bash -c "grep -qxF 'removed the snapshot of $TAG_E' '$TMP/prune.out' &&
  grep -qxF 'unpinned $TAG_E (refs/comp/releases/$TAG_E)' '$TMP/prune.out' && grep -qxF 'unpinned $TAG_F (refs/comp/releases/$TAG_F)' '$TMP/prune.out'"

check "shellcheck -x: this suite" bash -c "cd '$ROOT' && shellcheck -x deploy/server/tests/checkout.test.sh"
finish

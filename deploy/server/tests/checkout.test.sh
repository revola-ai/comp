#!/usr/bin/env bash
# Tests for the checkouts on the server: /opt/comp/src following the serving release (the
# laptop warning when a finish step could not move it, status showing it, rollback refusing
# while it lags behind), the released commits pinned in it (refs/comp/releases/<tag>) and the
# worktree a release run keeps from its up step to its finish or revert.
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

# ---------------------------------------------------------------- the run's worktree, from up to finish or revert
# The up step's checkout (/opt/comp/work/<sha12>) stays for the run while it holds its lease;
# finish and revert reuse it, so they need no new worktree (FAKE_GIT_WORKTREE_ADDS: the build's
# and the up step's succeed, any later one fails as on a full disk).
adds() { grep -c ' worktree add ' "$FAKE_GIT_LOG"; }
no_work() { test -z "$(ls -A "$SERVER/work" 2>/dev/null)"; }
reset_server
released "$TAG_A"
FAKE_GIT_WORKTREE_ADDS=2 FAKE_CURL_BAD_TAG="$TAG_B" release_sh "$TMP/reuse-revert.out" release "$SHA_B"
check "revert with no room for a new worktree: the previous tag serves again" \
  test "$(serving):$(last_record)" = "comp-api:$TAG_A:release $TAG_B rolled-back"
check "revert with no room for a new worktree: reuses the up step's (adds only for build and up)" test "$(adds)" -eq 2
check "revert with no room for a new worktree: says so" grep -qF "== reusing this run's checkout of $SHA_B" "$TMP/reuse-revert.out"
check "revert with no room for a new worktree: the checkout is gone afterwards" no_work
reset_server
released "$TAG_A"
FAKE_GIT_WORKTREE_ADDS=2 release_sh "$TMP/reuse-finish.out" release "$SHA_B"
check "finish reuses the up step's checkout: recorded, no third worktree" test "$?:$(last_record):$(adds)" = "0:release $TAG_B ok:2"
check "finish reuses the up step's checkout: none left" no_work

reset_server
released "$TAG_A"
chmod 444 "$SERVER/releases.log" # finish cannot record: the run keeps its lease
release_sh "$TMP/kept.out" release "$SHA_B"
chmod 644 "$SERVER/releases.log"
check "a run that keeps its lease keeps its checkout" grep -qxF "HEAD: $SHA_B" "$SERVER/work/$TAG_B/.git"
release_typed "unlock" "$TMP/kept-unlock.out" unlock
check "unlock frees the lease" test "$?:$(last_record)" = "0:release $TAG_B unlocked"
check "unlock removes the run's checkout" no_work

# A tree at another commit is never reused: the own step checks HEAD and checks the SHA out again.
entry() { COMP_ROOT="$SERVER" bash "$SERVER_DIR/on-server/entry.sh" "$@" >>"$TMP/entry.out" 2>&1; }
RUN="20261007T120000Z-release-$TAG_B-0123abcd"
reset_server
released "$TAG_A"
docker_state "s['images'] += ['comp-api:$TAG_B', 'comp-app:$TAG_B', 'comp-portal:$TAG_B', 'comp-migrate:$TAG_B']"
entry "20261007T120000Z-release-$TAG_B.log" "$RUN" "$OPERATOR" new "$SHA_B" release up release "$TAG_B"
check "the up step leaves its checkout for the run" test "$?:$(adds):$(sed -n 's/^HEAD: //p' "$SERVER/work/$TAG_B/.git" 2>/dev/null)" = "0:1:$SHA_B"
printf 'gitdir: x\nHEAD: %s\n' "$SHA_D" >"$SERVER/work/$TAG_B/.git"
entry "20261007T120100Z-finish-$TAG_B.log" "$RUN" "$OPERATOR" own "$SHA_B" release finish release "$TAG_B"
check "a checkout at another commit is checked out again, not reused" \
  test "$?:$(adds):$(last_record)" = "0:2:release $TAG_B ok"

check "shellcheck -x: this suite" bash -c "cd '$ROOT' && shellcheck -x deploy/server/tests/checkout.test.sh"
finish

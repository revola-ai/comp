#!/usr/bin/env bash
# Tests for the disk side of `deploy/server/release.sh`: the bounded prune a release runs after
# itself when / is over 70% used, the warning `status` prints, and prune.sh apply checking each
# image and snapshot of the plan again. Run:
# bash deploy/server/tests/disk.test.sh
# Laptop and server share one sandbox (tests/release-lib.sh); nothing reaches AWS or the server.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/server/tests/release-lib.sh
source "$SERVER_DIR/tests/release-lib.sh"
install_release_fakes
has_line() { grep -qxF -- "$2" "$1"; } # has_line <file> <exact line>
TAG_E=eeeeeeeeeeee TAG_F=ffffffffffff # two releases older than release-lib.sh's tags

# ---------------------------------------------------------------- disk: prune after a release, warn in status
auto_server() { # five ok releases (A serving), then release B with / at <use> percent
  reset_server
  released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A"
  FAKE_DF_USE="$1" release_sh "$TMP/auto-$1.out" release "$SHA_B"
}
AUTO_REMOVED="$(printf 'comp-%s\n' "api:$TAG_E" "app:$TAG_E" "portal:$TAG_E" "migrate:$TAG_E" \
  "api:$TAG_F" "app:$TAG_F" "portal:$TAG_F" "migrate:$TAG_F")"
auto_server 71
check "disk over 70% after a release: the release succeeds" test "$?:$(last_record)" = "0:release $TAG_B ok"
check "disk over 70% after a release: removes the images prune would, without asking" \
  test "$(sed -n 's/^docker image rm //p' "$FAKE_DOCKER_LOG" | sort)" = "$(sort <<<"$AUTO_REMOVED")"
check "disk over 70% after a release: keeps the current, previous and last 3 ok tags" bash -c "
  for t in $TAG_B $TAG_A $TAG_C $TAG_D; do grep -qF \"comp-api:\$t\" '$FAKE_DOCKER_STATE' || exit 1; done"
check "disk over 70% after a release: keeps the pinned cloudflared image" grep -qF "\"$TUNNEL_REF\"" "$FAKE_DOCKER_STATE"
check "disk over 70% after a release: removes the snapshots of the removed tags" \
  test "$(files_in "$SERVER/releases")" = "$TAG_A $TAG_B $TAG_C $TAG_D"
check "disk over 70% after a release: trims the build cache to 20 GB" \
  has_line "$FAKE_DOCKER_LOG" "docker builder prune --keep-storage 20GB -f"
check "disk over 70% after a release: says why" grep -qF "/ is 71% used, over 70%" "$TMP/auto-71.out"
check "disk over 70% after a release: reports what it removed" \
  bash -c "grep -qxF 'removed comp-api:$TAG_E' '$TMP/auto-71.out' && grep -qxF 'removed comp-migrate:$TAG_F' '$TMP/auto-71.out'"
check "disk over 70% after a release: the finish step does it (no extra SSM command)" test "$(ssm_sends)" -eq 3
auto_server 70
check "disk at 70%: removes nothing" bash -c "! grep -qE 'image rm|builder prune' '$FAKE_DOCKER_LOG'"
check "disk at 70%: says so" grep -qF "/ is 70% used: nothing pruned" "$TMP/auto-70.out"
reset_server
released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A"
FAKE_DOCKER_FAIL_PRUNE=1 FAKE_DF_USE=90 release_sh "$TMP/auto-fail.out" release "$SHA_B"
check "a failed prune after a release: the release stands" test "$?:$(last_record)" = "0:release $TAG_B ok"
check "a failed prune after a release: the laptop says released, prune failed" \
  grep -qF "Released $TAG_B, but the post-release prune failed" "$TMP/auto-fail.out"
check "a failed prune after a release: never calls it a recording failure" bash -c "! grep -qF 'recording it failed' '$TMP/auto-fail.out'"
reset_server
released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A"
FAKE_TIMEOUT_EXPIRE=1 FAKE_DF_USE=90 release_sh "$TMP/auto-slow.out" release "$SHA_B"
check "a post-release prune that times out: the release stands" test "$?:$(last_record)" = "0:release $TAG_B ok"
check "a post-release prune that times out: bounded to 600 s" grep -qE "^timeout 600 bash .*/prune\.sh auto\$" "$FAKE_TIMEOUT_LOG"
check "a post-release prune that times out: the laptop says so" \
  grep -qF "Released $TAG_B, but the post-release prune timed out" "$TMP/auto-slow.out"
check "a post-release prune that times out: never a recording failure" bash -c "! grep -qF 'recording it failed' '$TMP/auto-slow.out'"
check "the finish step reports the recording before it prunes" bash -c "
  log=\$(ls '$SERVER'/logs/*-finish-$TAG_B.log) && grep -n '' \"\$log\" | grep -E 'comp-result: recorded=ok|post-release prune' | head -n 1 | grep -qF recorded=ok"
# The pins cannot be listed (git for-each-ref in /opt/comp/src fails, as on a full disk): the
# images still go, and only the snapshots and pins stay, with a warning.
UNLISTED="WARNING: could not list the pinned releases in $SERVER/src (git for-each-ref failed); no snapshot or pin is pruned this time"
reset_server
released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A"
FAKE_GIT_FAIL_PINS=1 FAKE_DF_USE=90 release_sh "$TMP/auto-nopins.out" release "$SHA_B"
check "pins unlisted after a release: the release stands" test "$?:$(last_record)" = "0:release $TAG_B ok"
check "pins unlisted after a release: removes the images all the same" \
  test "$(sed -n 's/^docker image rm //p' "$FAKE_DOCKER_LOG" | sort)" = "$(sort <<<"$AUTO_REMOVED")"
check "pins unlisted after a release: trims the build cache" has_line "$FAKE_DOCKER_LOG" "docker builder prune --keep-storage 20GB -f"
check "pins unlisted after a release: keeps every snapshot, says why" bash -c "grep -qxF '$UNLISTED' '$TMP/auto-nopins.out' &&
  test \"\$(ls '$SERVER/releases' | tr '\n' ' ')\" = '$TAG_A $TAG_B $TAG_C $TAG_D $TAG_E $TAG_F '"
check "pins unlisted after a release: the laptop says the prune failed" \
  grep -qF "Released $TAG_B, but the post-release prune failed" "$TMP/auto-nopins.out"
reset_server
released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A" "$TAG_B"
FAKE_GIT_FAIL_PINS=1 release_typed "prune" "$TMP/prune-nopins.out" prune
check "pins unlisted: prune lists the images, asks and removes them" bash -c "test $? -eq 0 &&
  grep -qxF '  comp-api:$TAG_E' '$TMP/prune-nopins.out' && grep -qxF 'removed comp-api:$TAG_E' '$TMP/prune-nopins.out'"
check "pins unlisted: prune says it removes no snapshot, and why" bash -c "grep -qxF '$UNLISTED' '$TMP/prune-nopins.out' &&
  grep -qxF 'Removing no snapshot or pin: the pinned releases could not be listed (above).' '$TMP/prune-nopins.out'"
check "pins unlisted: prune keeps every snapshot" test "$(files_in "$SERVER/releases")" = "$TAG_A $TAG_B $TAG_C $TAG_D $TAG_E $TAG_F"

reset_server
released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A" "$TAG_B"
FAKE_DF_USE=90 release_sh "$TMP/auto-rollback.out" rollback
check "a rollback never prunes" bash -c "! grep -qE 'image rm|builder prune' '$FAKE_DOCKER_LOG'"
FAKE_DF_USE=71 release_sh "$TMP/status-full.out" status
check "status over 70%: a warning line" grep -qxF "WARNING: / is 71% used (over 70%); free space with deploy/server/release.sh prune" "$TMP/status-full.out"
FAKE_DF_USE=70 release_sh "$TMP/status-ok.out" status
check "status at 70%: no warning" bash -c "! grep -qF WARNING '$TMP/status-ok.out'"

# ---------------------------------------------------------------- prune.sh apply checks each ref again
# As entry.sh runs it after the typed confirmation: the refs are those of the plan, and things may
# have changed since (a container now runs one of them); a ref that is not comp-* is never removed.
reset_server
released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A" "$TAG_B"
docker_state "s['images'] += ['busybox:latest']
s['containers']['worker'] = 'comp-app:$TAG_E'"
COMP_ROOT="$SERVER" bash "$SERVER/src/deploy/server/on-server/prune.sh" apply \
  "comp-api:$TAG_A" "comp-app:$TAG_E" busybox:latest "comp-api:$TAG_E" >"$TMP/apply.out" 2>&1
check "prune apply: exits zero" test "$?" -eq 0
check "prune apply: skips a kept tag's image" grep -qxF "skipping comp-api:$TAG_A: kept now" "$TMP/apply.out"
check "prune apply: skips an image a container uses since the plan" grep -qxF "skipping comp-app:$TAG_E: kept now" "$TMP/apply.out"
check "prune apply: never removes an image that is not comp-*" grep -qxF "skipping busybox:latest: not a comp image" "$TMP/apply.out"
check "prune apply: removes only the one still removable" test "$(sed -n 's/^docker image rm //p' "$FAKE_DOCKER_LOG")" = "comp-api:$TAG_E"
check "prune apply: says so" grep -qxF "removed comp-api:$TAG_E" "$TMP/apply.out"
check "prune apply: removes no snapshot it was not given, stale or not" \
  test "$(files_in "$SERVER/releases")" = "$TAG_A $TAG_B $TAG_C $TAG_D $TAG_E $TAG_F"
check "prune apply: trims the build cache" has_line "$FAKE_DOCKER_LOG" "docker builder prune --keep-storage 20GB -f"

# ---------------------------------------------------------------- a release lands between prune's plan and its apply
prune_sh() { COMP_ROOT="$SERVER" bash "$SERVER/src/deploy/server/on-server/prune.sh" "$@"; }
reset_server
released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A" "$TAG_B" # kept: B, A, C, D
prune_sh plan >"$TMP/plan.out" 2>&1
check "prune plan: reports the snapshots it would remove" grep -qxF "comp-result: snapshots=$TAG_E $TAG_F" "$TMP/plan.out"
released "$TAG_F" # kept now: F, B, A, C; D is no longer kept, E still is not
prune_sh apply "snapshot:$TAG_E" "snapshot:$TAG_F" >"$TMP/late.out" 2>&1
check "prune apply after a release: exits zero" test "$?" -eq 0
check "prune apply after a release: removes a planned snapshot that is still stale, with its pin" bash -c "
  test ! -e '$SERVER/releases/$TAG_E' && ! grep -q '^refs/comp/releases/$TAG_E ' '$FAKE_GIT_REFS' &&
  grep -qxF 'removed the snapshot of $TAG_E' '$TMP/late.out'"
check "prune apply after a release: skips a planned snapshot kept now" bash -c "
  test -f '$SERVER/releases/$TAG_F/sha' && grep -q '^refs/comp/releases/$TAG_F ' '$FAKE_GIT_REFS' &&
  grep -qxF 'skipping the snapshot of $TAG_F: kept now' '$TMP/late.out'"
check "prune apply after a release: never removes one it did not plan, though stale now" bash -c "
  test -f '$SERVER/releases/$TAG_D/sha' && grep -q '^refs/comp/releases/$TAG_D ' '$FAKE_GIT_REFS'"
prune_sh apply "snapshot:$TAG_E" >"$TMP/again.out" 2>&1
check "prune apply of a snapshot removed since: says it is gone, not kept" grep -qxF "skipping the snapshot of $TAG_E: gone already" "$TMP/again.out"
reset_server
released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A" "$TAG_B"
release_typed "prune" "$TMP/prune-args.out" prune
check "prune: the laptop sends the planned snapshots to the apply step" \
  grep -qE " prune apply( comp-[a-z]+:[0-9a-f]{12})* snapshot:$TAG_E snapshot:$TAG_F\$" <<<"$(ssm_call 2 args)"
finish

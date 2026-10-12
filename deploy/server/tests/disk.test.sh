#!/usr/bin/env bash
# Tests for the disk side of `deploy/server/release.sh`: the bounded prune a release runs after
# itself when / is over 70% used, and the warning `status` prints. Run:
# bash deploy/server/tests/disk.test.sh
# Laptop and server share one sandbox (tests/release-lib.sh); nothing reaches AWS or the server.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/server/tests/release-lib.sh
source "$SERVER_DIR/tests/release-lib.sh"
install_release_fakes
has_line() { grep -qxF -- "$2" "$1"; } # has_line <file> <exact line>

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
reset_server
released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A" "$TAG_B"
FAKE_DF_USE=90 release_sh "$TMP/auto-rollback.out" rollback
check "a rollback never prunes" bash -c "! grep -qE 'image rm|builder prune' '$FAKE_DOCKER_LOG'"
FAKE_DF_USE=71 release_sh "$TMP/status-full.out" status
check "status over 70%: a warning line" grep -qxF "WARNING: / is 71% used (over 70%); free space with deploy/server/release.sh prune" "$TMP/status-full.out"
FAKE_DF_USE=70 release_sh "$TMP/status-ok.out" status
check "status at 70%: no warning" bash -c "! grep -qF WARNING '$TMP/status-ok.out'"
finish

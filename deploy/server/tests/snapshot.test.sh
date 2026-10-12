#!/usr/bin/env bash
# Tests for the configuration each release runs with: its snapshot (/opt/comp/releases/<tag>:
# the SHA, compose.yaml and the rendered env files), what a refused or failed release leaves
# live, what a revert or rollback comes back with, and that migrate, trigger and the steps
# without a SHA leave /opt/comp/src at the serving release.
# Run: bash deploy/server/tests/snapshot.test.sh
# Laptop and server share one sandbox (tests/release-lib.sh); nothing reaches AWS or the server.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/server/tests/release-lib.sh
source "$SERVER_DIR/tests/release-lib.sh"
install_release_fakes
said() { grep -qF -- "$2" "$1"; } # said <output> <text>
# fingerprint <dir>: every file under it with its checksum (empty when it does not exist)
fingerprint() { [[ ! -d "$1" ]] || (cd "$1" && find . -type f -exec cksum {} + | sort); }
up_state() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["up"][sys.argv[2]])' "$FAKE_DOCKER_STATE" "$1"; }
src_at() { test "$(cat "$FAKE_GIT_HEAD")" = "$1"; } # src_at <sha>: where /opt/comp/src is
empty_dir() { test -z "$(ls -A "$1" 2>/dev/null)"; }
lines() { printf '%s\n' "$@"; }

# ---------------------------------------------------------------- a bad secret, then the smoke checks fail
reset_server
released "$TAG_D" "$TAG_A"
before="$(fingerprint "$SERVER/releases/$TAG_A")"
write_fixture "$TMP/secret.json" --set RESEND_API_KEY fakesecret-broken
FAKE_CURL_BAD_ENV=fakesecret-broken release_sh "$TMP/secret.out" release "$SHA_B"
check "bad secret: exits non-zero" test "$?" -ne 0
check "bad secret: $TAG_B came up with its staged configuration, then $TAG_A with its own snapshot" \
  test "$(up_configs)" = "$(lines "$TAG_B up stage" "$TAG_A up releases/$TAG_A")"
check "bad secret: the containers run $TAG_A's env files and compose.yaml again" \
  test "$(up_state env):$(up_state file)" = "$SERVER/releases/$TAG_A/env:$SERVER/releases/$TAG_A/compose.yaml"
check "bad secret: $TAG_A's snapshot is unchanged" test "$(fingerprint "$SERVER/releases/$TAG_A")" = "$before"
check "bad secret: $TAG_A serves and passes the smoke checks" said "$TMP/secret.out" "Now serving $TAG_A (it passes the smoke checks)"
check "bad secret: recorded as rolled back" test "$(last_record)" = "release $TAG_B rolled-back"
check "bad secret: no snapshot of $TAG_B" test ! -e "$SERVER/releases/$TAG_B"
check "bad secret: no staged configuration or checkout left" bash -c "$(declare -f empty_dir); empty_dir '$SERVER/stage' && empty_dir '$SERVER/work'"
check "bad secret: /opt/comp/src stays at $TAG_A" src_at "$SHA_A"
check "bad secret: no lease left" test ! -e "$SERVER/release.lease"
no_secret "bad secret" "$TMP/secret.out"

reset_server
released "$TAG_A"
before="$(fingerprint "$SERVER/releases/$TAG_A")"
write_fixture "$TMP/secret.json" --set RESEND_API_KEY fakesecret-broken
FAKE_CURL_BAD_ENV=fakesecret-broken release_sh "$TMP/same.out" release "$SHA_A"
check "bad secret, serving tag released again: back to its snapshot" \
  test "$(up_configs)" = "$(lines "$TAG_A up stage" "$TAG_A up releases/$TAG_A")"
check "bad secret, serving tag released again: its snapshot is unchanged" test "$(fingerprint "$SERVER/releases/$TAG_A")" = "$before"
check "bad secret, serving tag released again: says it serves with its env files from before" \
  said "$TMP/same.out" "It serves again with the env files and compose.yaml of its snapshot, as before this release"
check "bad secret, serving tag released again: passes the smoke checks again" bash -c "! grep -qF 'still fail' '$TMP/same.out'"

# ---------------------------------------------------------------- a compose.yaml change in the new commit
COMPOSE_B="# compose.yaml as $TAG_B has it"
compose_of_b() { { cat "$TMP/tree/deploy/server/compose.yaml"; echo "$COMPOSE_B"; } | overlay "$SHA_B" deploy/server/compose.yaml; }
reset_server
released "$TAG_A"
compose_of_b
FAKE_CURL_BAD_TAG="$TAG_B" release_sh "$TMP/compose.out" release "$SHA_B"
check "compose change: $TAG_B up with it, then $TAG_A with its own" \
  test "$(up_configs)" = "$(lines "$TAG_B up stage" "$TAG_A up releases/$TAG_A")"
check "compose change: $TAG_A came back without $TAG_B's change" bash -c "! grep -qxF '$COMPOSE_B' '$(up_state file)'"
check "compose change: /opt/comp/src keeps $TAG_A's compose.yaml" \
  cmp -s "$SERVER/src/deploy/server/compose.yaml" "$TMP/tree/deploy/server/compose.yaml"

reset_server
released "$TAG_A"
compose_of_b
release_sh "$TMP/compose-ok.out" release "$SHA_B"
check "compose change released: exits zero" test "$?" -eq 0
check "compose change released: kept in $TAG_B's snapshot" grep -qxF "$COMPOSE_B" "$SERVER/releases/$TAG_B/compose.yaml"
check "compose change released: /opt/comp/src is at $TAG_B, with it" \
  bash -c "test '$(cat "$FAKE_GIT_HEAD")' = '$SHA_B' && grep -qxF '$COMPOSE_B' '$SERVER/src/deploy/server/compose.yaml'"
check "compose change released: $TAG_A's snapshot stays for a rollback" test -f "$SERVER/releases/$TAG_A/sha"
: >"$FAKE_DOCKER_LOG"
release_sh "$TMP/compose-back.out" rollback
check "rollback after it: $TAG_A with its own compose.yaml and env files" test "$(up_configs)" = "$TAG_A up releases/$TAG_A"
check "rollback after it: /opt/comp/src is back at $TAG_A" src_at "$SHA_A"

# ---------------------------------------------------------------- refused before any change: nothing live changes
reset_server
released "$TAG_A"
before="$(fingerprint "$SERVER/releases")"
docker_state "s['migrations'] = 'pending'"
release_sh "$TMP/gate.out" release "$SHA_B"
check "refused at the gate: says no container changed" said "$TMP/gate.out" "before any container changed"
check "refused at the gate: the snapshots are unchanged, none for $TAG_B" test "$(fingerprint "$SERVER/releases")" = "$before"
check "refused at the gate: the containers still run $TAG_A's configuration" test "$(up_state env)" = "$SERVER/releases/$TAG_A/env"
check "refused at the gate: no staged configuration or checkout left" bash -c "$(declare -f empty_dir); empty_dir '$SERVER/stage' && empty_dir '$SERVER/work'"
check "refused at the gate: /opt/comp/src stays at $TAG_A" src_at "$SHA_A"
check "refused at the gate: no env file outside the snapshots" test ! -e "$SERVER/env"

# ---------------------------------------------------------------- a key missing from the secret: render-env refuses
reset_server
released "$TAG_D" "$TAG_A"
before="$(fingerprint "$SERVER/releases")"
write_fixture "$TMP/secret.json" --drop RESEND_API_KEY
for sha in "$SHA_B" "$SHA_A"; do # a new tag, and the serving one released again (a changed secret)
  : >"$FAKE_DOCKER_LOG"
  release_sh "$TMP/nokey.out" release "$sha"
  check "key missing (${sha:0:12}): exits non-zero" test "$?" -ne 0
  check "key missing (${sha:0:12}): names the key" said "$TMP/nokey.out" "RESEND_API_KEY is missing from comp/production/config"
  check "key missing (${sha:0:12}): says no container changed" said "$TMP/nokey.out" "before any container changed"
  check "key missing (${sha:0:12}): no container changed" test -z "$(container_changes)"
  check "key missing (${sha:0:12}): recorded failed" test "$(last_record)" = "release ${sha:0:12} failed"
  check "key missing (${sha:0:12}): the containers still run $TAG_A's snapshot" test "$(up_state env)" = "$SERVER/releases/$TAG_A/env"
  check "key missing (${sha:0:12}): the snapshots are unchanged" test "$(fingerprint "$SERVER/releases")" = "$before"
  check "key missing (${sha:0:12}): no staged configuration left" empty_dir "$SERVER/stage"
done
# A rollback renders nothing: it comes back with the target's snapshot whatever the secret holds.
: >"$FAKE_DOCKER_LOG"
release_sh "$TMP/nokey-back.out" rollback
check "key missing, rollback: exits zero with $TAG_D's snapshot" test "$?:$(up_configs)" = "0:$TAG_D up releases/$TAG_D"
check "key missing, rollback: never renders" bash -c "! grep -qF 'render-env' '$TMP/nokey-back.out' '$SERVER'/logs/*-rollback-$TAG_D.log"
no_secret "key missing" "$TMP/nokey.out" "$TMP/nokey-back.out"

# ---------------------------------------------------------------- rollback needs the target's snapshot
reset_server
released "$TAG_D" "$TAG_A"
rm -rf "${SERVER:?}/releases/$TAG_D"
release_sh "$TMP/nosnap.out" rollback
check "rollback without a snapshot: refused" test "$?" -ne 0
check "rollback without a snapshot: says why" said "$TMP/nosnap.out" "there is no snapshot of $TAG_D"
check "rollback without a snapshot: before any change" said "$TMP/nosnap.out" "before any container changed"
check "rollback without a snapshot: no container changed" test -z "$(container_changes)"
check "rollback without a snapshot: /opt/comp/src stays" src_at "$SHA_A"

reset_server
released "$TAG_D" "$TAG_A"
echo "# compose.yaml as $TAG_D has it" >>"$SERVER/releases/$TAG_D/compose.yaml"
release_sh "$TMP/back.out" rollback
check "rollback: exits zero" test "$?" -eq 0
check "rollback: $TAG_D with its own snapshot" test "$(up_configs)" = "$TAG_D up releases/$TAG_D"
check "rollback: /opt/comp/src at $TAG_D" src_at "$SHA_D"
check "rollback: says it uses the tag's snapshot" said "$TMP/back.out" "the env files and compose.yaml it was released with (its snapshot"

# ---------------------------------------------------------------- a server released before snapshots
reset_server
released "$TAG_A"
rm -rf "${SERVER:?}/releases"
mkdir -p "$SERVER/env"
for name in api app portal cloudflared migrate trigger; do echo "LEGACY_OF=$TAG_A" >"$SERVER/env/$name.env"; done
FAKE_CURL_BAD_TAG="$TAG_B" release_sh "$TMP/legacy.out" release "$SHA_B"
check "first release after the upgrade fails: $TAG_A comes back with the configuration it ran with" \
  test "$(up_configs)" = "$(lines "$TAG_B up stage" "$TAG_A up releases/$TAG_A")"
check "first release after the upgrade fails: that configuration became $TAG_A's snapshot" \
  test "$(cat "$SERVER/releases/$TAG_A/env/api.env"):$(cat "$SERVER/releases/$TAG_A/sha")" = "LEGACY_OF=$TAG_A:$SHA_A"
check "first release after the upgrade fails: serving $TAG_A" test "$(serving)" = "comp-api:$TAG_A"

# ---------------------------------------------------------------- migrate, trigger and steps without a SHA
reset_server
released "$TAG_A"
{ head -n 1 "$TMP/tree/deploy/server/on-server/prune.sh"; echo 'echo "prune.sh as of B"'; tail -n +2 "$TMP/tree/deploy/server/on-server/prune.sh"; } |
  overlay "$SHA_B" deploy/server/on-server/prune.sh
before="$(fingerprint "$SERVER/releases")"
docker_state "s['migrations'] = 'pending'"
release_typed "migrate" "$TMP/migrate.out" migrate "$SHA_B"
check "migrate: applied" test "$(last_record)" = "migrate $TAG_B ok"
release_typed "trigger" "$TMP/trigger.out" trigger "$SHA_B"
check "trigger: deployed" test "$(last_record)" = "trigger $TAG_B ok"
check "migrate and trigger: /opt/comp/src stays at the serving $TAG_A" src_at "$SHA_A"
check "migrate and trigger: never move /opt/comp/src" bash -c "! grep -qF 'git -C $SERVER/src checkout' '$FAKE_GIT_LOG'"
check "migrate and trigger: the snapshots are unchanged" test "$(fingerprint "$SERVER/releases")" = "$before"
check "migrate and trigger: no staged env files or checkout left" bash -c "$(declare -f empty_dir); empty_dir '$SERVER/stage' && empty_dir '$SERVER/work'"
release_typed "no" "$TMP/prune-a.out" prune
check "a step without a SHA runs the serving release's script" bash -c "! grep -qF 'prune.sh as of B' '$TMP/prune-a.out'"
release_sh "$TMP/release-b.out" release "$SHA_B"
release_typed "no" "$TMP/prune-b.out" prune
check "once $TAG_B is released, steps without a SHA run its scripts" said "$TMP/prune-b.out" "prune.sh as of B"
no_secret "snapshots" "$TMP"/*.out

check "shellcheck -x: the server scripts and this suite" \
  bash -c "cd '$ROOT' && shellcheck -x deploy/server/on-server/*.sh deploy/server/tests/snapshot.test.sh"
finish

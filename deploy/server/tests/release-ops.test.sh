#!/usr/bin/env bash
# Tests for `deploy/server/release.sh migrate`, `trigger` and `prune`, the three commands that
# ask for a typed confirmation. Run: bash deploy/server/tests/release-ops.test.sh
# Laptop and server share one sandbox (tests/release-lib.sh); nothing reaches AWS, the server,
# the database or Trigger.dev. Answers are typed into a pseudo-terminal (tests/tty_run.py).
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/server/tests/release-lib.sh
source "$SERVER_DIR/tests/release-lib.sh"
install_release_fakes
has_line() { grep -qxF -- "$2" "$1"; } # has_line <file> <exact line>
TOOLS="$COMPOSE_ARGV --profile tools run --rm -T --no-deps"

# ---------------------------------------------------------------- nothing happens without a terminal
for command in "migrate $SHA_B" "trigger $SHA_B" prune; do
  reset_server
  released "$TAG_A"
  # shellcheck disable=SC2086 # the command and its argument are two words on purpose
  harness --no-tty --stdin "$(lines_of "${command%% *}" 3)" --cwd "$TMP/cwd" --out "$TMP/notty.out" \
    -- bash "$SERVER_DIR/release.sh" $command
  status=$?
  check "$command without a terminal: refused" test "$status" -ne 0
  check "$command without a terminal: says it needs one" grep -qF "needs a terminal" "$TMP/notty.out"
  check "$command without a terminal: no AWS call" test ! -s "$FAKE_AWS_LOG"
  check "$command without a terminal: no docker call" test ! -s "$FAKE_DOCKER_LOG"
done

# ---------------------------------------------------------------- migrate
reset_server
released "$TAG_A"
docker_state "s['migrations'] = 'pending'"
harness --typed "" --stdin "migrate" --cwd "$TMP/cwd" --out "$TMP/piped.out" \
  -- bash "$SERVER_DIR/release.sh" migrate "$SHA_B"
check "migrate, piped answer: not applied" test "$?" -ne 0
check "migrate, piped answer: status only (one SSM command)" test "$(ssm_sends)" -eq 1
check "migrate, piped answer: still pending" grep -qF '"migrations": "pending"' "$FAKE_DOCKER_STATE"

reset_server
released "$TAG_A"
docker_state "s['migrations'] = 'pending'"
release_typed "no" "$TMP/declined.out" migrate "$SHA_B"
check "migrate declined: exits non-zero" test "$?" -ne 0
check "migrate declined: shows the pending migration first" grep -qF 20261001000000_add_widget "$TMP/declined.out"
check "migrate declined: says nothing was applied" grep -qF "Not applied" "$TMP/declined.out"
check "migrate declined: never runs migrate deploy" bash -c "! grep -q 'migrate deploy' '$FAKE_DOCKER_LOG'"

reset_server
released "$TAG_A"
docker_state "s['migrations'] = 'pending'"
release_typed "migrate" "$TMP/migrate.out" migrate "$SHA_B"
check "migrate: exits zero" test "$?" -eq 0
check "migrate: asks for the word migrate" grep -qF "Type migrate to apply" "$TMP/migrate.out"
check "migrate: status step, then deploy step (two SSM commands)" test "$(ssm_sends)" -eq 2
check "migrate: both steps check out the SHA" test "$(grep -c "checkout --quiet --detach $SHA_B" "$FAKE_GIT_LOG")" -eq 2
check "migrate: deploy with the production opt-in in a one-off container" grep -qE \
  "^TAG=$TAG_B $TOOLS -e COMP_I_AM_TOUCHING_PROD=1 migrate sh -c '.*exec bunx prisma migrate deploy'\$" "$FAKE_DOCKER_LOG"
check "migrate: status runs without the opt-in" grep -qE \
  "^TAG=$TAG_B $TOOLS migrate sh -c '.*exec bunx prisma migrate status'\$" "$FAKE_DOCKER_LOG"
check "migrate: TLS verified against the image's CA" grep -qF 'set("sslcert",process.env.DATABASE_SSL_CA)' "$FAKE_DOCKER_LOG"
check "migrate: applied" grep -qF '"migrations": "up-to-date"' "$FAKE_DOCKER_STATE"
check "migrate: no container of the stack changed" test -z "$(container_changes)"
check "migrate: recorded" test "$(last_record)" = "migrate $TAG_B ok"
check "migrate: the release record is unchanged" grep -qF "release $TAG_A ok" "$SERVER/releases.log"
check "migrate: steps may take an hour" test "$(ssm_call 2 timeout)" = 3600
no_secret "migrate" "$TMP/migrate.out" "$TMP/declined.out"

reset_server
released "$TAG_A"
release_typed "migrate" "$TMP/nothing.out" migrate "$SHA_B"
check "migrate, up to date: exits zero" test "$?" -eq 0
check "migrate, up to date: says nothing to apply" grep -qF "Nothing to apply" "$TMP/nothing.out"
check "migrate, up to date: never asks" bash -c "! grep -qF 'Type migrate' '$TMP/nothing.out'"
check "migrate, up to date: one SSM command" test "$(ssm_sends)" -eq 1

reset_server
released "$TAG_A"
docker_state "s['migrations'] = 'failed'"
release_typed "migrate" "$TMP/failed.out" migrate "$SHA_B"
check "migrate, a failed migration: refused" test "$?" -ne 0
check "migrate, a failed migration: never asks" bash -c "! grep -qF 'Type migrate' '$TMP/failed.out'"
check "migrate, a failed migration: never deploys" bash -c "! grep -q 'migrate deploy' '$FAKE_DOCKER_LOG'"

reset_server
release_typed "migrate" "$TMP/unpushed.out" migrate "$SHA_C"
check "migrate <unpushed>: refused before any AWS call" test ! -s "$FAKE_AWS_LOG"

# ---------------------------------------------------------------- trigger
deploy_line() { # deploy_line <project>: the one-off run that deploys it
  local suffix
  suffix="$(tr '[:lower:]' '[:upper:]' <<<"$1")"
  printf '%s\n' "TAG=$TAG_B $TOOLS -w /repo/apps/$1 trigger sh -c 'export TRIGGER_PROJECT_REF=\"\$TRIGGER_PROJECT_REF_$suffix\"; exec npx --yes trigger.dev@4.4.3 deploy --env prod'"
}
reset_server
released "$TAG_A"
release_typed "trigger" "$TMP/trigger.out" trigger "$SHA_B"
check "trigger: exits zero" test "$?" -eq 0
check "trigger: asks for the word trigger" grep -qF "Type trigger to deploy" "$TMP/trigger.out"
check "trigger: deploys api, then app, in the tools image" \
  test "$(grep ' trigger sh -c ' "$FAKE_DOCKER_LOG")" = "$(deploy_line api; deploy_line app)"
check "trigger: one SSM command, up to an hour" test "$(ssm_sends):$(ssm_call 1 timeout)" = "1:3600"
check "trigger: no ref or token on any command line" \
  bash -c "! grep -qE 'fakesecret|TRIGGER_ACCESS_TOKEN=' '$FAKE_DOCKER_LOG' '$FAKE_AWS_LOG'"
check "trigger: trigger.env holds the token and both refs" \
  test "$(names_of "$SERVER/env/trigger.env" | tr '\n' ' ')" = "TRIGGER_ACCESS_TOKEN TRIGGER_PROJECT_REF_API TRIGGER_PROJECT_REF_APP "
check "trigger: lists the Trigger dashboard env vars in the README" grep -qF "SERVICE_TOKEN_TRIGGER" "$SERVER_DIR/README.md"
check "trigger: no container of the stack changed" test -z "$(container_changes)"
check "trigger: recorded" test "$(last_record)" = "trigger $TAG_B ok"
no_secret "trigger" "$TMP/trigger.out"

reset_server
released "$TAG_A"
release_typed "trigger" "$TMP/app.out" trigger "$SHA_B" --project app
check "trigger --project app: only app" test "$(grep ' trigger sh -c ' "$FAKE_DOCKER_LOG")" = "$(deploy_line app)"

reset_server
release_typed "trigger" "$TMP/bogus.out" trigger "$SHA_B" --project web
check "trigger --project web: refused before any AWS call" test ! -s "$FAKE_AWS_LOG"

reset_server
released "$TAG_A"
release_typed "no" "$TMP/trigger-no.out" trigger "$SHA_B"
check "trigger declined: exits non-zero, no SSM command" test "$?:$(ssm_sends)" = "1:0"

reset_server
released "$TAG_A"
FAKE_DOCKER_FAIL_TRIGGER=api release_typed "trigger" "$TMP/trigger-fail.out" trigger "$SHA_B"
check "trigger, api fails: exits non-zero" test "$?" -ne 0
check "trigger, api fails: app is not deployed" test "$(grep -c ' trigger sh -c ' "$FAKE_DOCKER_LOG")" -eq 1
check "trigger, api fails: recorded failed" test "$(last_record)" = "trigger $TAG_B failed"

for upstream in "TRIGGER_PROJECT_REF_API proj_zhioyrusqertqgafqgpj" "TRIGGER_PROJECT_REF_APP proj_lhxjliiqgcdyqbgtucda"; do
  reset_server
  released "$TAG_A"
  write_fixture "$TMP/secret.json" --set "${upstream% *}" "${upstream#* }"
  release_typed "trigger" "$TMP/upstream.out" trigger "$SHA_B"
  check "upstream ${upstream% *}: refused" test "$?" -ne 0
  check "upstream ${upstream% *}: names the key" grep -qF "${upstream% *} is still the upstream" "$TMP/upstream.out"
  check "upstream ${upstream% *}: deploys nothing" bash -c "! grep -q ' trigger sh -c ' '$FAKE_DOCKER_LOG'"
done
check "trigger CLI pin equals apps/api and apps/app" test "$(grep -h '"trigger.dev":' "$ROOT/apps/api/package.json" "$ROOT/apps/app/package.json" | sort -u | tr -d ' ,')" = '"trigger.dev":"4.4.3"'

# ---------------------------------------------------------------- prune
TAG_E=eeeeeeeeeeee TAG_F=ffffffffffff TAG_G=000000000001
prune_server() { # six releases (B serving), an unreleased build, an old image a container still uses
  reset_server
  released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A" "$TAG_B"
  docker_state "s['images'] += ['comp-api:$TAG_G', 'comp-migrate:$TAG_G', 'busybox:latest']
s['containers']['worker'] = 'comp-portal:$TAG_F'
del s['containers']['cloudflared']"
}
REMOVED="$(printf 'comp-%s\n' "api:$TAG_E" "app:$TAG_E" "portal:$TAG_E" "migrate:$TAG_E" \
  "api:$TAG_F" "app:$TAG_F" "migrate:$TAG_F" "api:$TAG_G" "migrate:$TAG_G")"
prune_server
release_typed "no" "$TMP/prune-no.out" prune
check "prune declined: exits non-zero" test "$?" -ne 0
check "prune declined: lists what it would remove" bash -c "grep -qF 'comp-api:$TAG_F' '$TMP/prune-no.out' && grep -qF 'comp-migrate:$TAG_G' '$TMP/prune-no.out'"
check "prune declined: removes nothing" bash -c "! grep -qE 'image rm|builder prune' '$FAKE_DOCKER_LOG'"
check "prune declined: one SSM command" test "$(ssm_sends)" -eq 1

prune_server
release_typed "prune" "$TMP/prune.out" prune
check "prune: exits zero" test "$?" -eq 0
check "prune: asks for the word prune" grep -qF "Type prune to" "$TMP/prune.out"
check "prune: removes the comp images outside the kept tags" \
  test "$(sed -n 's/^docker image rm //p' "$FAKE_DOCKER_LOG" | sort)" = "$(sort <<<"$REMOVED")"
check "prune: keeps the current tag and the last 3 ok tags" bash -c "
  for t in $TAG_B $TAG_A $TAG_C $TAG_D; do grep -qF \"comp-api:\$t\" '$FAKE_DOCKER_STATE' || exit 1; done
  ! grep -qF 'comp-api:$TAG_E' '$FAKE_DOCKER_STATE'"
check "prune: keeps the image of a running container" grep -qF "\"comp-portal:$TAG_F\"" "$FAKE_DOCKER_STATE"
check "prune: keeps the pinned cloudflared image without its container" grep -qF "\"$TUNNEL_REF\"" "$FAKE_DOCKER_STATE"
check "prune: says it keeps the pinned cloudflared image" grep -qF "cloudflare/cloudflared:2026.10.0@sha256:" "$TMP/prune.out"
check "prune: never touches other images" grep -qF '"busybox:latest"' "$FAKE_DOCKER_STATE"
check "prune: trims the build cache to 20 GB" has_line "$FAKE_DOCKER_LOG" "docker builder prune --keep-storage 20GB -f"
check "prune: never prunes images wholesale" bash -c "! grep -qE 'image prune|system prune' '$FAKE_DOCKER_LOG'"
check "prune: no container changed" test -z "$(container_changes)"
finish

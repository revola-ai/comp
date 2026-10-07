#!/usr/bin/env bash
# Tests for `deploy/server/release.sh release`. Run: bash deploy/server/tests/release.test.sh
# Laptop and server share one sandbox (tests/release-lib.sh); nothing reaches AWS or the server.
# Covers the pushed check, the exact calls of a release, the migration gate, the rollback after
# a failed health check or smoke check, a first release that fails, and the SSM output limit.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/server/tests/release-lib.sh
source "$SERVER_DIR/tests/release-lib.sh"
install_release_fakes
has_line() { grep -qxF -- "$2" "$1"; } # has_line <file> <exact line>
LOG_NAME_RE='[0-9]{8}T[0-9]{6}Z-[a-z-]+-[0-9a-f]{12}\.log'

# ---------------------------------------------------------------- refusals before any AWS call
reset_server
released "$TAG_A"
FORK=https://github.com/revola-ai/comp
NOT_ON_FORK="is not on any branch of revola-ai/comp; push it there first (git push revola <branch>)"
for bad in "$SHA_C:$NOT_ON_FORK" "$TAG_C:$NOT_ON_FORK" "$SHA_U:$NOT_ON_FORK" "$TAG_U:$NOT_ON_FORK" \
  "eeeeeeeeeeee:is not a commit" "main:is not a 12- or 40-character" "${SHA_B:0:7}:is not a 12- or 40-character"; do
  sha="${bad%%:*}" message="${bad#*:}"
  : >"$FAKE_AWS_LOG"
  release_sh "$TMP/refused.out" release "$sha"
  status=$?
  check "release $sha: refused" test "$status" -ne 0
  check "release $sha: says why" grep -qF -- "$message" "$TMP/refused.out"
  check "release $sha: no AWS call at all" test ! -s "$FAKE_AWS_LOG"
done
check "refusals: no docker call" test ! -s "$FAKE_DOCKER_LOG"
check "refusals: the laptop fetches the fork's branches by URL (never a remote name, no tags) into its own refs, pruning" \
  has_line "$FAKE_GIT_LOG" "git -C $ROOT fetch --prune --no-tags --quiet $FORK +refs/heads/*:refs/comp-release/*"
check "refusals: the laptop never fetches a remote by name" bash -c "! grep -qE '^git -C $ROOT fetch .* (origin|revola)( |\$)' '$FAKE_GIT_LOG'"
check "refusals: the pushed check asks only the fork's refs" \
  has_line "$FAKE_GIT_LOG" "git -C $ROOT for-each-ref --contains $SHA_U --format=%(refname) refs/comp-release/"
release_sh "$TMP/upstream.out" release "$TAG_U"
check "only on upstream: refused, naming the full SHA" grep -qF "$SHA_U $NOT_ON_FORK" "$TMP/upstream.out"
: >"$FAKE_AWS_LOG"
FAKE_GIT_STALE="$SHA_D" release_sh "$TMP/stale.out" release "$SHA_D"
check "only on a deleted fork branch: refused" test "$?" -ne 0
check "only on a deleted fork branch: says why" grep -qF "$NOT_ON_FORK" "$TMP/stale.out"
check "only on a deleted fork branch: no AWS call" test ! -s "$FAKE_AWS_LOG"
AWS_REGION=eu-west-1 release_sh "$TMP/region.out" release "$SHA_B"
check "another AWS_REGION: refused" grep -qF "only works in us-east-2" "$TMP/region.out"

# ---------------------------------------------------------------- a release that works
reset_server
released "$TAG_A"
# A server that checked out under umask 077 before: a tracked file and a directory too tight
# for the node user of the images; and a symlink in the tree to a root-only file outside it.
chmod 600 "$SERVER/src/deploy/server/README.md"
chmod 700 "$SERVER/src/deploy/server/env"
printf 'outside\n' >"$TMP/root-only" && chmod 600 "$TMP/root-only"
ln -s "$TMP/root-only" "$SERVER/src/deploy/server/link"
release_sh "$TMP/ok.out" release "$TAG_B"
status=$?
cp -f "$FAKE_AWS_LOG" "$TMP/ok.aws.log"
check "release: exits zero" test "$status" -eq 0
check "release: checks the account first" test "$(sed -n 1p "$FAKE_AWS_LOG")" = \
  "aws sts get-caller-identity --query Account --output text --region us-east-2"
check "release: finds the one running comp-server" test "$(sed -n 2p "$FAKE_AWS_LOG")" = \
  "aws ec2 describe-instances --filters Name=tag:Name,Values=comp-server Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text --region us-east-2"
check "release: two SSM commands (release, finish)" test "$(ssm_sends)" -eq 2
check "release: send-command shape" grep -qE "^aws ssm send-command --instance-ids $INSTANCE --document-name AWS-RunShellScript --comment 'comp release.sh release $TAG_B' --timeout-seconds 600 --parameters '.*' --query Command.CommandId --output text --region us-east-2\$" "$FAKE_AWS_LOG"
check "release: builds may take 2 hours" test "$(ssm_call 1 timeout)" = 7200
check "release: delivery timeout 600 s" test "$(ssm_call 1 delivery)" = 600
check "release: step 1 runs release up from the checkout of the full SHA" grep -qE \
  "^$LOG_NAME_RE [0-9]{8}T[0-9]{6}Z-release-$TAG_B-[0-9a-f]{8} new $SHA_B release up release $TAG_B\$" <<<"$(ssm_call 1 args)"
check "release: step 2 records it under the same run" grep -qE \
  "^$LOG_NAME_RE [0-9]{8}T[0-9]{6}Z-release-$TAG_B-[0-9a-f]{8} own - release finish release $TAG_B\$" <<<"$(ssm_call 2 args)"
check "release: polls each command until it ends" test "$(grep -c "^aws ssm get-command-invocation --command-id fake-command-[01] --instance-id $INSTANCE --output json --region us-east-2\$" "$FAKE_AWS_LOG")" -eq 4
check "release: the server fetches every branch of the fork by URL" \
  has_line "$FAKE_GIT_LOG" "git -C $SERVER/src fetch --quiet $FORK +refs/heads/*:refs/remotes/origin/*"
check "release: the server checks out the SHA detached" \
  has_line "$FAKE_GIT_LOG" "git -C $SERVER/src checkout --quiet --detach $SHA_B"
EXPECTED_DOCKER="$(
  for target in api app portal migrate; do
    printf '%s\n' "docker image inspect comp-$target:$TAG_B" \
      "TAG=$TAG_B REGISTRY= docker buildx bake -f deploy/aws/docker-bake.hcl --load $target"
  done
  printf '%s\n' "TAG=$TAG_B $COMPOSE_ARGV --profile tools run --rm -T --no-deps migrate sh -c MIGRATE_STATUS" \
    "TAG=$TAG_B $COMPOSE_ARGV up -d --no-build --wait --wait-timeout 600"
)"
actual_docker="$(sed -E "s/ migrate sh -c '.*prisma migrate status'\$/ migrate sh -c MIGRATE_STATUS/" "$FAKE_DOCKER_LOG")"
check "release: builds four images one at a time, checks migrations, then compose up" \
  test "$actual_docker" = "$EXPECTED_DOCKER"
check "release: prisma runs with TLS verified against the CA" \
  grep -qF "sslaccept\",\"strict\")" "$FAKE_DOCKER_LOG"
check "release: smoke checks the four public URLs" test "$(sort -u "$FAKE_CURL_LOG")" = "$(printf '%s\n' \
  https://api.comp.revola.ai/v1/health/ready https://app.comp.revola.ai/ \
  https://app.comp.revola.ai/api/health/live https://portal.comp.revola.ai/api/health)"
check "release: serves the new tag" test "$(serving)" = "comp-api:$TAG_B"
check "release: recorded ok" test "$(last_record)" = "release $TAG_B ok"
check "release: releases nothing else" test "$(wc -l <"$SERVER/releases.log")" -eq 2
check "release: no lease left" test ! -e "$SERVER/release.lease"
run_one="$(ssm_call 1 args | cut -d' ' -f2)"
check "release: env files for the stack and the tools" test "$(files_in "$SERVER/env")" = \
  "api.env app.env cloudflared.env migrate.env portal.env trigger.env"
check "release: migrate.env holds only DATABASE_URL (the migration URL)" \
  test "$(names_of "$SERVER/env/migrate.env")" = DATABASE_URL
check "release: migrate.env is the secret's DATABASE_MIGRATION_URL" \
  test "$(value_of "$SERVER/env/migrate.env" DATABASE_URL)" = "$MIGRATION_URL"
check "release: logs directory 0700" test "$(mode_of "$SERVER/logs")" = 700
check "release: env files stay 0600" bash -c "for f in '$SERVER'/env/*.env; do [[ \$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' \$f) == 0o600 ]] || exit 1; done"
MIGRATION_DIR="$SERVER/src/packages/db/prisma/migrations/20261001000000_add_widget"
check "release: a file new in the checkout is world-readable" test "$(mode_of "$MIGRATION_DIR/migration.sql")" = 644
check "release: a directory new in the checkout is world-readable" test "$(mode_of "$MIGRATION_DIR")" = 755
check "release: a tracked file left 0600 by an older run is readable again" \
  test "$(mode_of "$SERVER/src/deploy/server/README.md")" = 644
check "release: a directory left 0700 is readable again" test "$(mode_of "$SERVER/src/deploy/server/env")" = 755
check "release: a symlink's target outside the tree is left alone" test "$(mode_of "$TMP/root-only")" = 600
check "release: one log per step, 0600, named <utc>-<step>-<sha12>.log" bash -c "
  cd '$SERVER/logs' && [[ \$(ls | wc -l) -eq 2 ]] && for f in *; do
    [[ \$f =~ ^$LOG_NAME_RE\$ ]] && [[ \$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' \$f) == 0o600 ]] || exit 1
  done"
check "release: prints the server's log path" grep -qE "log: $SERVER/logs/$LOG_NAME_RE" "$TMP/ok.out"
check "release: says what it did" grep -qF "Released $TAG_B" "$TMP/ok.out"
no_secret "release" "$TMP/ok.out"

: >"$FAKE_DOCKER_LOG"
release_sh "$TMP/again.out" release "$SHA_B"
check "release again: exits zero" test "$?" -eq 0
check "release again: builds nothing already built" bash -c "! grep -q 'buildx bake' '$FAKE_DOCKER_LOG'"
check "release again: a new run id (random suffix)" test "$(ssm_call 3 args | cut -d' ' -f2)" != "$run_one"

# ---------------------------------------------------------------- the migration gate
for state in pending failed ahead unreachable; do
  reset_server
  released "$TAG_A"
  docker_state "s['migrations'] = '$state'"
  release_sh "$TMP/gate-$state.out" release "$SHA_B"
  status=$?
  check "gate $state: refused" test "$status" -ne 0
  check "gate $state: no container changed" test -z "$(container_changes)"
  check "gate $state: still serving the previous tag" test "$(serving)" = "comp-api:$TAG_A"
  check "gate $state: recorded as failed" test "$(last_record)" = "release $TAG_B failed"
  check "gate $state: one SSM command" test "$(ssm_sends)" -eq 1
  check "gate $state: no smoke check" test ! -s "$FAKE_CURL_LOG"
  check "gate $state: says no container changed" grep -qF "before any container changed" "$TMP/gate-$state.out"
done
check "gate pending: lists the pending migration" grep -qF 20261001000000_add_widget "$TMP/gate-pending.out"
check "gate pending: prints the migrate command" grep -qF "deploy/server/release.sh migrate $TAG_B" "$TMP/gate-pending.out"
check "gate failed: says a migration failed" grep -qiF "failed migration" "$TMP/gate-failed.out"
check "gate unreachable: says the status is unknown" grep -qF "could not read the migration status" "$TMP/gate-unreachable.out"
check "gate ahead: says the database has migrations this commit lacks" grep -qF \
  "the database has migrations this commit lacks; release a commit that includes them" "$TMP/gate-ahead.out"
check "gate ahead: never suggests migrate" bash -c "! grep -qF 'release.sh migrate' '$TMP/gate-ahead.out'"
check "gate ahead: never calls it pending" bash -c "! grep -qF 'the database lacks migrations' '$TMP/gate-ahead.out'"
no_secret "gate" "$TMP/gate-pending.out" "$TMP/gate-failed.out" "$TMP/gate-ahead.out" "$TMP/gate-unreachable.out"

reset_server
released "$TAG_A"
FAKE_DOCKER_FAIL_BUILD=app release_sh "$TMP/build.out" release "$SHA_B"
check "failed build: refused" test "$?" -ne 0
check "failed build: no container changed" test -z "$(container_changes)"
check "failed build: stops at the failed target" bash -c "! grep -q -- '--load portal' '$FAKE_DOCKER_LOG'"
check "failed build: recorded as failed" test "$(last_record)" = "release $TAG_B failed"
check "failed build: says no container changed" grep -qF "before any container changed" "$TMP/build.out"

reset_server
released "$TAG_A"
write_fixture "$TMP/secret.json" --set DATABASE_MIGRATION_URL "postgresql://postgres.ref:fakesecret#pw@pooler:5432/postgres"
release_sh "$TMP/badurl.out" release "$SHA_B"
check "malformed migration URL: refused at the gate" test "$(last_record)" = "release $TAG_B failed"
check "malformed migration URL: says so without the URL" \
  grep -qF "DATABASE_URL in migrate.env is not a valid URL" "$SERVER"/logs/*-release-"$TAG_B".log
no_secret "malformed migration URL" "$TMP/badurl.out"

# ---------------------------------------------------------------- the up step ends abnormally
for ending in "TimedOut:ExecutionTimedOut:-1" "Cancelled:Cancelled:-1" "Failed:Undeliverable:-1" \
  "Failed:Terminated:-1" "Failed:Failed:9"; do
  reset_server
  released "$TAG_A"
  FAKE_SSM_END="0:$ending" release_sh "$TMP/ending.out" release "$SHA_B"
  check "up ends $ending: exits non-zero" test "$?" -ne 0
  check "up ends $ending: the serving state is unknown" grep -qF "serving state is unknown" "$TMP/ending.out"
  check "up ends $ending: prints the status command" grep -qF "deploy/server/release.sh status" "$TMP/ending.out"
  check "up ends $ending: never claims no container changed" bash -c "! grep -qF 'before any container changed' '$TMP/ending.out'"
  check "up ends $ending: no smoke check, no finish" test "$(ssm_sends):$(wc -c <"$FAKE_CURL_LOG" | tr -d ' ')" = "1:0"
done
reset_server
released "$TAG_A"
FAKE_SSM_TRUNCATE=40 FAKE_DOCKER_FAIL_BUILD=api release_sh "$TMP/cut-fail.out" release "$SHA_B"
check "cut output of a failed up: the serving state is unknown" grep -qF "serving state is unknown" "$TMP/cut-fail.out"
check "cut output of a failed up: never claims no container changed" \
  bash -c "! grep -qF 'before any container changed' '$TMP/cut-fail.out'"

reset_server
released "$TAG_A"
FAKE_GIT_DIRTY=" M deploy/server/compose.yaml" release_sh "$TMP/dirty.out" release "$SHA_B"
check "dirty checkout: refused" test "$?" -ne 0
check "dirty checkout: names the change" grep -qF "local changes" "$TMP/dirty.out"
check "dirty checkout: never checks out" bash -c "! grep -q 'checkout' '$FAKE_GIT_LOG'"
check "dirty checkout: no docker call" test ! -s "$FAKE_DOCKER_LOG"

# ---------------------------------------------------------------- failures after the containers changed
reset_server
released "$TAG_D" "$TAG_A"
FAKE_DOCKER_FAIL_UP="$TAG_B" release_sh "$TMP/health.out" release "$SHA_B"
check "failed health: exits non-zero" test "$?" -ne 0
check "failed health: brings the previous tag back up" test "$(container_changes)" = "$(printf '%s\n' \
  "TAG=$TAG_B $COMPOSE_ARGV up -d --no-build --wait --wait-timeout 600" \
  "TAG=$TAG_A $COMPOSE_ARGV up -d --no-build --wait --wait-timeout 600")"
check "failed health: serving the previous tag" test "$(serving)" = "comp-api:$TAG_A"
check "failed health: recorded as rolled back" test "$(last_record)" = "release $TAG_B rolled-back"
check "failed health: says which tag serves" grep -qF "Now serving $TAG_A" "$TMP/health.out"
check "failed health: smoke-checks the restored tag" test -s "$FAKE_CURL_LOG"
check "failed health: no lease left" test ! -e "$SERVER/release.lease"

reset_server
released "$TAG_A"
FAKE_CURL_BAD_TAG="$TAG_B" release_sh "$TMP/smoke.out" release "$SHA_B"
check "failed smoke: exits non-zero" test "$?" -ne 0
check "failed smoke: second SSM command reverts under the same run" grep -qE \
  "^$LOG_NAME_RE [0-9]{8}T[0-9]{6}Z-release-$TAG_B-[0-9a-f]{8} own - release revert release $TAG_B\$" <<<"$(ssm_call 2 args)"
check "failed smoke: the new tag went up, then the previous one" test "$(container_changes)" = "$(printf '%s\n' \
  "TAG=$TAG_B $COMPOSE_ARGV up -d --no-build --wait --wait-timeout 600" \
  "TAG=$TAG_A $COMPOSE_ARGV up -d --no-build --wait --wait-timeout 600")"
check "failed smoke: serving the previous tag" test "$(serving)" = "comp-api:$TAG_A"
check "failed smoke: recorded as rolled back" test "$(last_record)" = "release $TAG_B rolled-back"
check "failed smoke: names the failing URL" grep -qF "https://api.comp.revola.ai/v1/health/ready" "$TMP/smoke.out"
check "failed smoke: says which tag serves and that it passes" grep -qF "Now serving $TAG_A" "$TMP/smoke.out"
check "failed smoke: retries a check 24 times, 5 seconds apart" \
  test "$(grep -c '^https://api.comp.revola.ai/v1/health/ready$' "$FAKE_CURL_LOG")" -ge 25
check "failed smoke: no lease left" test ! -e "$SERVER/release.lease"
no_secret "failed smoke" "$TMP/smoke.out"

reset_server
released "$TAG_A"
FAKE_CURL_NO_ACCESS=1 release_sh "$TMP/access.out" release "$SHA_B"
check "Access off: the release is rolled back" test "$(last_record)" = "release $TAG_B rolled-back"
check "Access off: says the app is not behind Access" grep -qF "cloudflareaccess.com" "$TMP/access.out"

reset_server
released "$TAG_A"
FAKE_CURL_BAD_TAG="$TAG_A" release_sh "$TMP/same.out" release "$SHA_A"
check "re-release of the serving tag fails smoke: exits non-zero" test "$?" -ne 0
check "re-release of the serving tag fails smoke: no 'X is serving again; X is not'" \
  bash -c "! grep -qF '$TAG_A is serving again; $TAG_A is not' '$TMP/same.out' && ! grep -qF '$TAG_A is not released' '$TMP/same.out'"
check "re-release of the serving tag fails smoke: blames the re-rendered env files (the secret)" \
  grep -qF "only the env files changed, re-rendered from comp/production/config: a change in the secret is the likely cause" "$TMP/same.out"

reset_server
FAKE_DOCKER_FAIL_UP="$TAG_B" release_sh "$TMP/first.out" release "$SHA_B"
check "first release fails: exits non-zero" test "$?" -ne 0
check "first release fails: stops the failed stack" \
  has_line "$FAKE_DOCKER_LOG" "TAG=$TAG_B $COMPOSE_ARGV stop"
check "first release fails: nothing runs" test "$(serving)" = none
check "first release fails: recorded as failed" test "$(last_record)" = "release $TAG_B failed"
check "first release fails: says the site is down" grep -qF "THE SITE IS DOWN" "$TMP/first.out"

reset_server
FAKE_CURL_BAD_TAG="$TAG_B" release_sh "$TMP/first-smoke.out" release "$SHA_B"
check "first release smoke fails: stops the stack, site down" grep -qF "THE SITE IS DOWN" "$TMP/first-smoke.out"
check "first release smoke fails: nothing runs" test "$(serving)" = none

# ---------------------------------------------------------------- SSM keeps 24,000 characters
reset_server
released "$TAG_A"
FAKE_SSM_TRUNCATE=40 release_sh "$TMP/cut.out" release "$SHA_B"
check "cut output: the release still completes" test "$(last_record)" = "release $TAG_B ok"
check "cut output: says the output was cut short" grep -qF "cut short" "$TMP/cut.out"
check "cut output: prints where the full log is" grep -qE "/opt/comp/logs/$LOG_NAME_RE" "$TMP/cut.out"
check "cut output: prints the command that fetches it" grep -qF "deploy/server/release.sh logs --release" "$TMP/cut.out"

check "shellcheck -x: release.sh and its libraries" \
  bash -c "cd '$ROOT' && shellcheck -x deploy/server/release.sh deploy/server/on-server/*.sh"
finish

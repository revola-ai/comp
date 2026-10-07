#!/usr/bin/env bash
# Tests for an interrupted deploy/server/release.sh (INT, TERM, HUP) and `release.sh unlock`.
# Run: bash deploy/server/tests/interrupt.test.sh
# Laptop and server share one sandbox (tests/release-lib.sh). The fake aws and curl deliver the
# signal to release.sh's process group at a chosen point (FAKE_AWS_INTERRUPT,
# FAKE_CURL_INTERRUPT), as a Ctrl-C or a closed terminal would; nothing reaches AWS or a server.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/server/tests/release-lib.sh
source "$SERVER_DIR/tests/release-lib.sh"
install_release_fakes
UP="up -d --no-build --wait --wait-timeout 600"
TAG_E=eeeeeeeeeeee TAG_F=ffffffffffff
LOG_RE='[0-9]{8}T[0-9]{6}Z-[a-z-]+-[0-9a-f]{12}\.log'
RUN_RE="[0-9]{8}T[0-9]{6}Z-release-$TAG_B-[0-9a-f]{8}"
cancels() { grep -c '^aws ssm cancel-command ' "$FAKE_AWS_LOG"; }
said() { grep -qF -- "$2" "$1"; } # said <output> <text>

# ---------------------------------------------------------------- once the up step was sent: revert
reset_server
released "$TAG_A"
FAKE_AWS_INTERRUPT="INT@fake-command-0" release_sh "$TMP/up.out" release "$SHA_B"
check "Ctrl-C during up: exits non-zero" test "$?" -ne 0
check "Ctrl-C during up: says so" said "$TMP/up.out" "interrupted (INT)"
check "Ctrl-C during up: never cancels the up step" test "$(cancels)" -eq 0
check "Ctrl-C during up: waits for it, then reverts under the same run" grep -qE \
  "^$LOG_RE $RUN_RE own - release revert release $TAG_B\$" <<<"$(ssm_call 2 args)"
check "Ctrl-C during up: no finish (up, then revert)" test "$(ssm_sends)" -eq 2
check "Ctrl-C during up: the new tag came up, then the previous one" test "$(container_changes)" = \
  "$(printf '%s\n' "TAG=$TAG_B $COMPOSE_ARGV $UP" "TAG=$TAG_A $COMPOSE_ARGV $UP")"
check "Ctrl-C during up: serving the previous tag" test "$(serving)" = "comp-api:$TAG_A"
check "Ctrl-C during up: recorded as rolled back" test "$(last_record)" = "release $TAG_B rolled-back"
check "Ctrl-C during up: no lease left" test ! -e "$SERVER/release.lease"
check "Ctrl-C during up: smoke-checks and reports what serves" said "$TMP/up.out" "Now serving $TAG_A (it passes the smoke checks)"

reset_server
released "$TAG_A"
FAKE_CURL_INTERRUPT=TERM release_sh "$TMP/smoke.out" release "$SHA_B"
check "SIGTERM during the smoke checks: exits non-zero" test "$?" -ne 0
check "SIGTERM during the smoke checks: says so" said "$TMP/smoke.out" "interrupted (TERM)"
check "SIGTERM during the smoke checks: reverts" grep -qE " own - release revert release $TAG_B\$" <<<"$(ssm_call 2 args)"
check "SIGTERM during the smoke checks: serving the previous tag" test "$(serving)" = "comp-api:$TAG_A"
check "SIGTERM during the smoke checks: recorded as rolled back" test "$(last_record)" = "release $TAG_B rolled-back"

reset_server
FAKE_AWS_INTERRUPT="HUP@fake-command-0" release_sh "$TMP/first.out" release "$SHA_B"
check "closed terminal during a first release: exits non-zero" test "$?" -ne 0
check "closed terminal during a first release: reverts" grep -qE " own - release revert release $TAG_B\$" <<<"$(ssm_call 2 args)"
check "closed terminal during a first release: stops the stack" test "$(serving)" = none
check "closed terminal during a first release: says the site is down" said "$TMP/first.out" "THE SITE IS DOWN"
check "closed terminal during a first release: recorded as failed" test "$(last_record)" = "release $TAG_B failed"

reset_server
released "$TAG_A"
docker_state "s['migrations'] = 'pending'"
FAKE_AWS_INTERRUPT="INT@fake-command-0" release_sh "$TMP/gate.out" release "$SHA_B"
check "Ctrl-C while up is refused at the gate: exits non-zero" test "$?" -ne 0
check "Ctrl-C while up is refused at the gate: nothing to revert (one SSM command)" test "$(ssm_sends)" -eq 1
check "Ctrl-C while up is refused at the gate: says no container changed" said "$TMP/gate.out" "before any container changed"
check "Ctrl-C while up is refused at the gate: still serving" test "$(serving)" = "comp-api:$TAG_A"

reset_server
released "$TAG_A"
FAKE_AWS_INTERRUPT="INT@fake-command-1" release_sh "$TMP/finish.out" release "$SHA_B"
check "Ctrl-C while finish runs: exits non-zero" test "$?" -ne 0
check "Ctrl-C while finish runs: waits for it, no revert" test "$(ssm_sends)" -eq 2
check "Ctrl-C while finish runs: it was recorded" test "$(last_record)" = "release $TAG_B ok"
check "Ctrl-C while finish runs: says it is released and how to undo it" \
  bash -c "grep -qF 'released' '$TMP/finish.out' && grep -qF 'deploy/server/release.sh rollback' '$TMP/finish.out'"

reset_server
released "$TAG_A"
FAKE_CURL_BAD_TAG="$TAG_B" FAKE_AWS_INTERRUPT="INT@fake-command-1" release_sh "$TMP/revert.out" release "$SHA_B"
check "Ctrl-C while revert runs: waits for it, no second revert" test "$(ssm_sends)" -eq 2
check "Ctrl-C while revert runs: reports what serves" said "$TMP/revert.out" "Now serving $TAG_A"

reset_server
released "$TAG_A"
FAKE_AWS_INTERRUPT="INT@fake-command-0,INT@fake-command-1" release_sh "$TMP/twice.out" release "$SHA_B"
check "Ctrl-C twice: exits non-zero" test "$?" -ne 0
check "Ctrl-C twice: the second one leaves" said "$TMP/twice.out" "Interrupted again"
check "Ctrl-C twice: points at status and unlock" \
  bash -c "grep -qF 'deploy/server/release.sh status' '$TMP/twice.out' && grep -qF 'deploy/server/release.sh unlock' '$TMP/twice.out'"

reset_server
released "$TAG_A"
FAKE_AWS_INTERRUPT="INT@fake-command-0,TERM@fake-command-0" release_sh "$TMP/leave-up.out" release "$SHA_B"
check "leaving while up runs: says the server brings the tag up unverified under the lease" \
  said "$TMP/leave-up.out" "$TAG_B serves unverified under a 20-minute lease"
check "leaving while up runs: next steps are status, unlock, then release or roll back" \
  said "$TMP/leave-up.out" "Next: deploy/server/release.sh status, then deploy/server/release.sh unlock, then release (or roll back to) the SHA that should serve."

# A signal while release.sh prints a step's output (the step has ended; tests/release-lib.sh awk)
reset_server
released "$TAG_A"
FAKE_AWK_INTERRUPT="INT@1" release_sh "$TMP/print-up.out" release "$SHA_B"
check "Ctrl-C while printing the up step: never says it was not sent" bash -c "! grep -qF 'was not sent' '$TMP/print-up.out'"
check "Ctrl-C while printing the up step: reverts it (up, revert)" test "$(ssm_sends)" -eq 2
check "Ctrl-C while printing the up step: serving the previous tag" test "$(serving)" = "comp-api:$TAG_A"
check "Ctrl-C while printing the up step: recorded as rolled back" test "$(last_record)" = "release $TAG_B rolled-back"
reset_server
released "$TAG_A"
FAKE_AWK_INTERRUPT="INT@2" release_sh "$TMP/print-finish.out" release "$SHA_B"
check "Ctrl-C while printing finish: no revert of the recorded release" test "$(ssm_sends)" -eq 2
check "Ctrl-C while printing finish: still released" test "$(last_record):$(serving)" = "release $TAG_B ok:comp-api:$TAG_B"
check "Ctrl-C while printing finish: says it is released" said "$TMP/print-finish.out" "it is released"
reset_server
released "$TAG_A"
FAKE_CURL_BAD_TAG="$TAG_B" FAKE_AWK_INTERRUPT="INT@2" release_sh "$TMP/print-revert.out" release "$SHA_B"
check "Ctrl-C while printing revert: no second revert" test "$(ssm_sends)" -eq 2
check "Ctrl-C while printing revert: reports what serves" said "$TMP/print-revert.out" "Now serving $TAG_A"

reset_server
released "$TAG_A"
FAKE_AWS_INTERRUPT="INT@ssm send-command" release_sh "$TMP/sending.out" release "$SHA_B"
check "Ctrl-C while the up step is sent: exits non-zero" test "$?" -ne 0
check "Ctrl-C while the up step is sent: the state is unknown" said "$TMP/sending.out" "serving state is unknown"
check "Ctrl-C while the up step is sent: points at unlock" said "$TMP/sending.out" "deploy/server/release.sh unlock"
check "Ctrl-C while the up step is sent: never claims nothing changed" bash -c "! grep -qiF 'nothing changed' '$TMP/sending.out'"
check "Ctrl-C while the up step is sent: sends nothing else" test "$(ssm_sends)" -eq 1
# The up step went through on the server and holds the lease; the operator unlocks it.
check "an orphaned up leaves the lease" test -s "$SERVER/release.lease"
release_typed "unlock" "$TMP/orphan-unlock.out" unlock
check "unlock after an orphaned up: exits zero" test "$?" -eq 0
check "unlock after an orphaned up: the lease is gone" test ! -e "$SERVER/release.lease"
check "unlock after an orphaned up: recorded" test "$(last_record)" = "release $TAG_B unlocked"

# ---------------------------------------------------------------- before the up step: cancel
reset_server
released "$TAG_A"
FAKE_AWS_INTERRUPT="INT@sts get-caller-identity" release_sh "$TMP/early.out" release "$SHA_B"
check "Ctrl-C before anything was sent: exits 130" test "$?" -eq 130
check "Ctrl-C before anything was sent: says nothing was sent" said "$TMP/early.out" "Nothing was sent to the server"
check "Ctrl-C before anything was sent: no SSM command" test "$(ssm_sends)" -eq 0

cancelled() { grep -c "^aws ssm cancel-command --command-id $1 --instance-ids $INSTANCE --region us-east-2\$" "$FAKE_AWS_LOG"; }
reset_server
released "$TAG_A"
FAKE_AWS_INTERRUPT="INT@fake-command-0" release_typed "prune" "$TMP/prune.out" prune
check "Ctrl-C during prune's plan (read-only): exits non-zero" test "$?" -ne 0
check "Ctrl-C during prune's plan (read-only): cancels it" test "$(cancelled fake-command-0)" -eq 1
check "Ctrl-C during prune's plan (read-only): says it only reads" said "$TMP/prune.out" "it only reads"
check "Ctrl-C during prune's plan (read-only): never asks, never applies" test "$(ssm_sends)" -eq 1

reset_server
released "$TAG_A"
docker_state "s['migrations'] = 'pending'"
FAKE_AWS_INTERRUPT="INT@fake-command-0" release_typed "migrate" "$TMP/mstatus.out" migrate "$SHA_B"
check "Ctrl-C during migrate's status (read-only): cancels it" test "$(cancelled fake-command-0)" -eq 1
check "Ctrl-C during migrate's status (read-only): never applies" test "$(ssm_sends)" -eq 1

reset_server
released "$TAG_A"
docker_state "s['migrations'] = 'pending'"
FAKE_AWS_INTERRUPT="INT@fake-command-1" release_typed "migrate" "$TMP/mdeploy.out" migrate "$SHA_B"
check "Ctrl-C during migrate deploy: exits non-zero" test "$?" -ne 0
check "Ctrl-C during migrate deploy: never cancels it" test "$(cancels)" -eq 0
check "Ctrl-C during migrate deploy: waits, so it ends applied" grep -qF '"migrations": "up-to-date"' "$FAKE_DOCKER_STATE"
check "Ctrl-C during migrate deploy: says it waits, then that it finished" \
  bash -c "grep -qF 'never cut short' '$TMP/mdeploy.out' && grep -qF 'The migrate step finished' '$TMP/mdeploy.out'"
check "Ctrl-C during migrate deploy: recorded" test "$(last_record)" = "migrate $TAG_B ok"

reset_server
released "$TAG_A"
docker_state "s['migrations'] = 'pending'"
FAKE_AWS_INTERRUPT="INT@fake-command-1,TERM@fake-command-1" release_typed "migrate" "$TMP/mleave.out" migrate "$SHA_B"
check "Ctrl-C twice during migrate deploy: leaves at once" said "$TMP/mleave.out" "Interrupted again"
check "Ctrl-C twice during migrate deploy: says it still runs, with its log" grep -qE \
  "The migrate step is still running on the server; check it with deploy/server/release.sh status and deploy/server/release.sh logs --release [0-9]{8}T[0-9]{6}Z-migrate-$TAG_B\.log" "$TMP/mleave.out"
check "Ctrl-C twice during migrate deploy: never cancels it" test "$(cancels)" -eq 0

reset_server
released "$TAG_A"
FAKE_AWS_INTERRUPT="INT@fake-command-0" release_typed "trigger" "$TMP/trigger.out" trigger "$SHA_B"
check "Ctrl-C during a Trigger.dev deploy: never cancels it" test "$(cancels)" -eq 0
check "Ctrl-C during a Trigger.dev deploy: waits for both projects" test "$(grep -c ' trigger sh -c ' "$FAKE_DOCKER_LOG")" -eq 2
check "Ctrl-C during a Trigger.dev deploy: says it finished" said "$TMP/trigger.out" "The trigger step finished"

reset_server
released "$TAG_F" "$TAG_E" "$TAG_D" "$TAG_C" "$TAG_A" "$TAG_B"
FAKE_AWS_INTERRUPT="INT@fake-command-1" release_typed "prune" "$TMP/papply.out" prune
check "Ctrl-C during prune's removal: never cancels it" test "$(cancels)" -eq 0
check "Ctrl-C during prune's removal: waits until it removed the images" grep -qF "removed comp-api:$TAG_F" "$TMP/papply.out"

reset_server
released "$TAG_A"
exec 8>>"$SERVER/release.lock"
flock -n 8
FAKE_AWS_INTERRUPT="INT@fake-command-0" release_typed "trigger" "$TMP/confirmed.out" trigger "$SHA_B"
check "Ctrl-C during a refused step: exits non-zero" test "$?" -ne 0
check "Ctrl-C during a refused step: the server confirms nothing changed" said "$TMP/confirmed.out" "The server confirms the step changed nothing"
exec 8>&-

reset_server
released "$TAG_A" "$TAG_B"
FAKE_AWS_INTERRUPT="INT@fake-command-0" release_sh "$TMP/tags.out" rollback
check "Ctrl-C while rollback reads the tags: cancelled, it only reads" said "$TMP/tags.out" "it only reads"
check "Ctrl-C while rollback reads the tags: nothing else sent" test "$(ssm_sends)" -eq 1

reset_server
released "$TAG_A" "$TAG_B"
FAKE_AWS_INTERRUPT="INT@fake-command-1" release_sh "$TMP/rollback.out" rollback
check "Ctrl-C during a rollback's up: reverts" grep -qE " own - release revert rollback $TAG_A\$" <<<"$(ssm_call 3 args)"
check "Ctrl-C during a rollback's up: serving the tag from before" test "$(serving)" = "comp-api:$TAG_B"
check "Ctrl-C during a rollback's up: recorded as rolled back" test "$(last_record)" = "rollback $TAG_A rolled-back"

# ---------------------------------------------------------------- unlock
lease() { # lease <seconds left> <what>: a lease of a run that stopped between its steps
  printf '20261007T120000Z-release-%s-0123abcd %s %s\n' "$TAG_C" "$(($(date +%s) + $1))" "$2" >"$SERVER/release.lease"
}
reset_server
released "$TAG_A"
lease 600 "release $TAG_C"
harness --no-tty --stdin unlock --cwd "$TMP/cwd" --out "$TMP/u-notty.out" -- bash "$SERVER_DIR/release.sh" unlock
check "unlock without a terminal: refused" test "$?" -ne 0
check "unlock without a terminal: no AWS call" test ! -s "$FAKE_AWS_LOG"

release_typed "no" "$TMP/u-no.out" unlock
check "unlock declined: exits non-zero" test "$?" -ne 0
check "unlock declined: shows the holder and its age" \
  grep -qE "release $TAG_C \(run 20261007T120000Z-release-$TAG_C-0123abcd\), taken 60[0-2] seconds ago" "$TMP/u-no.out"
check "unlock declined: the lease stays" test -s "$SERVER/release.lease"
check "unlock declined: one read-only SSM command" test "$(ssm_sends)" -eq 1

: >"$FAKE_AWS_LOG"
release_typed "unlock" "$TMP/u-yes.out" unlock
check "unlock: exits zero" test "$?" -eq 0
check "unlock: asks for the word unlock" said "$TMP/u-yes.out" "Type unlock"
check "unlock: removes the lease under that run" grep -qE \
  "^[0-9]{8}T[0-9]{6}Z-unlock-$TAG_C\.log 20261007T120000Z-release-$TAG_C-0123abcd own - release unlock release $TAG_C\$" <<<"$(ssm_call 2 args)"
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
no_secret "interrupts and unlock" "$TMP"/*.out
finish

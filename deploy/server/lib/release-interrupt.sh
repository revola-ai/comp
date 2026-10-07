# shellcheck shell=bash
# What deploy/server/release.sh does when it is interrupted: Ctrl-C (INT), SIGTERM, or a closed
# terminal (HUP). Sourced after the other lib/release-*.sh files, never run on its own.
#
# It cancels (aws ssm cancel-command) only a step that only reads: status, logs, migrate-status
# and prune-plan. Any other step is never cut short (a migration could stay half applied):
# it waits for the step to end and reports its result, saying nothing changed only when the
# server confirms it (comp-result: changed=no). Once a release or rollback sent its up step,
# it then runs the revert step, which brings the previous tag back (or stops the stack after
# a first release), and reports what serves. A second interrupt leaves at once and says what
# keeps running; a lease left behind on the server is removed with `release.sh unlock`.

STAGE=""               # up: the up step may be in flight; verify: it succeeded; done: reporting
UP_RUN="" UP_ACTION="" # the run and the action (release or rollback) of that up step
READ_ONLY_STEPS='^(status|migrate-status|prune-plan)$' # what an interrupt may cancel
TOOLS_POLLS=$(((TOOLS_SECONDS + DELIVERY_SECONDS + 300) / POLL_SECONDS)) # migrate, trigger, prune

trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP

on_signal() { # on_signal <signal> <exit status>
  set +e
  IFS=$' \t\n' # the signal may arrive inside `IFS= read` (capture), whose IFS would apply here
  # shellcheck disable=SC2064 # the exit status is fixed now
  trap "leave_now $2" INT TERM HUP
  echo
  echo "release.sh: interrupted ($1)."
  case "$STAGE" in
    up) interrupted_up ;;
    verify) interrupted_verify ;;
    done) echo "The outcome above stands; check what serves with: deploy/server/release.sh status" ;;
    *) interrupted_before_up ;;
  esac
  exit "$2"
}

leave_now() { # leave_now <exit status>: the second interrupt
  echo
  echo "Interrupted again: leaving now."
  if [[ "$STAGE" == up ]]; then
    echo "The server finishes the $UP_ACTION step of $TAG on its own; if it succeeds, $TAG serves unverified under a 20-minute lease."
    echo "Next: deploy/server/release.sh status, then deploy/server/release.sh unlock, then release (or roll back to) the SHA that should serve."
  elif [[ -n "$INFLIGHT_ID" && "$INFLIGHT_KIND" == entry ]]; then
    echo "The $INFLIGHT_STEP step is still running on the server; check it with deploy/server/release.sh status and deploy/server/release.sh logs --release $INFLIGHT_LOG."
    [[ -z "$STAGE" ]] || echo "If a lease stays behind, free it with deploy/server/release.sh unlock."
  else
    echo "Check the server with deploy/server/release.sh status; free a lease left behind with deploy/server/release.sh unlock."
  fi
  exit "$1"
}

interrupted_before_up() {
  if [[ -n "$INFLIGHT_ID" && ( "$INFLIGHT_KIND" == status || "$INFLIGHT_STEP" =~ $READ_ONLY_STEPS ) ]]; then
    cancel_read_only
  elif [[ -n "$INFLIGHT_ID" ]]; then
    wait_for_step
  elif [[ -n "$SENDING" ]]; then
    echo "An SSM command was being sent; it may have reached the server, so the state is unknown."
    echo "Check it with: deploy/server/release.sh status"
  elif [[ -z "$SENT_ANY" ]]; then
    echo "Nothing was sent to the server; nothing changed."
  else
    echo "No step was running on the server; the steps above ended as shown."
  fi
}

cancel_read_only() { # cancels the read-only SSM command in flight
  local id="$INFLIGHT_ID"
  capture aws ssm cancel-command --command-id "$id" --instance-ids "$INSTANCE_ID" --region "$REGION" ||
    echo "Could not cancel SSM command $id: $ERR"
  INFLIGHT_ID=""
  echo "Cancelled the $INFLIGHT_STEP step (SSM command $id); it only reads: it changes no container, migration or release."
}

wait_for_step() { # waits for a step that changes something (migrate, trigger, prune) and reports it
  echo "The $INFLIGHT_STEP step is running on the server and is never cut short (it may be applying a"
  echo "migration, deploying or removing images): waiting for it to end. Interrupt again to leave it running."
  await_command "$INFLIGHT_ID" "$TOOLS_POLLS"
  if unchanged; then
    echo "The server confirms the step changed nothing."
  elif [[ "$REMOTE_CODE" -eq 0 ]]; then
    echo "The $LAST_STEP step finished (above); this command stops here."
  else
    echo "The $LAST_STEP step ended with status $REMOTE_CODE (above); check it with deploy/server/release.sh status."
  fi
}

interrupted_up() {
  if [[ -n "$INFLIGHT_ID" ]]; then
    echo "The $UP_ACTION step of $TAG is running on the server and is never cut short (it may be"
    echo "replacing containers): waiting for it to end, then bringing the previous release back."
    echo "Interrupt again to leave: the server then finishes it, and $TAG may serve unverified under a 20-minute lease."
    await_command "$INFLIGHT_ID" $(((RELEASE_SECONDS + DELIVERY_SECONDS + 300) / POLL_SECONDS))
  elif [[ -n "$SENDING" ]]; then
    unknown_state "The $UP_ACTION of $TAG was interrupted while its up step was being sent"
    echo "If it went through, the server stays held for up to 20 minutes; free it with deploy/server/release.sh unlock."
    return
  elif [[ "$LAST_STEP" != "$UP_ACTION" ]]; then
    echo "The up step of $TAG was not sent; no container changed."
    return
  fi
  after_up_ended
}

after_up_ended() { # the up step ended (REMOTE_*): revert it, or say why there is nothing to revert
  if [[ "$REMOTE_STATUS" == Success && "$REMOTE_CODE" -eq 0 ]]; then
    revert_now
  elif unchanged; then
    echo "The $UP_ACTION of $TAG stopped before any container changed (above); still serving the earlier release."
  elif [[ "$REMOTE_STATUS:$REMOTE_CODE:$REMOTE_ENDED" =~ ^Failed:[456]:1$ ]]; then
    after_restore
  else
    unknown_state "The $UP_ACTION step of $TAG did not end normally"
  fi
}

revert_now() { # brings the previous release back under the run's lease; never returns
  STAGE=done
  echo "Bringing the previous release back (the revert step)."
  step revert "$UP_SECONDS" "$UP_RUN" own - release revert "$UP_ACTION" "$TAG"
  after_restore "$TAG was interrupted"
}

interrupted_verify() {
  if [[ -n "$INFLIGHT_ID" ]]; then
    echo "Waiting for the $INFLIGHT_STEP step of $TAG to end on the server (interrupt again to leave it)."
    await_command "$INFLIGHT_ID" $(((UP_SECONDS + DELIVERY_SECONDS + 300) / POLL_SECONDS))
  elif [[ -n "$SENDING" ]]; then
    unknown_state "$TAG was interrupted while its $INFLIGHT_STEP step was being sent"
    echo "If the server stays held, free it with deploy/server/release.sh unlock."
    return
  fi
  case "$LAST_STEP" in
    finish)
      if [[ "$(result_of recorded)" == ok ]]; then
        echo "$TAG passed the smoke checks and was recorded before the interrupt: it is released."
        echo "To undo it: deploy/server/release.sh rollback"
        after_prune
      else
        echo "$TAG is up and passed the smoke checks, but recording it failed (above)."
        echo "Check what serves with: deploy/server/release.sh status"
      fi
      ;;
    revert) after_restore ;;
    *) revert_now ;;
  esac
}

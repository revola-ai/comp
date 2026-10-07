# shellcheck shell=bash
# What deploy/server/release.sh does when it is interrupted: Ctrl-C (INT), SIGTERM, or a closed
# terminal (HUP). Sourced after lib/release-remote.sh and lib/release-flow.sh, never run alone.
#
# Before a release or rollback has sent its up step, it cancels the SSM command in flight
# (aws ssm cancel-command) and says nothing changed only when the server confirms it (the
# step ended normally with comp-result: changed=no); otherwise the state is unknown and it
# points at `status`. Once the up step was sent it never cancels a step (the up step may be
# halfway through compose up): it waits for the step in flight to end, then runs the revert
# step, which brings the previous tag back (or stops the stack after a first release), and
# reports what serves. A second interrupt leaves at once; a lease left behind on the server is
# removed with `release.sh unlock`.

STAGE=""               # up: the up step may be in flight; verify: it succeeded; done: reporting
UP_RUN="" UP_ACTION="" # the run and the action (release or rollback) of that up step
CANCEL_POLLS=24        # how long to wait for a cancelled command to stop (about 2 minutes)

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
  echo "Interrupted again: leaving now. A step already sent keeps running on the server; check it"
  echo "with deploy/server/release.sh status, and free a lease left behind with deploy/server/release.sh unlock."
  exit "$1"
}

interrupted_before_up() {
  if [[ -n "$INFLIGHT_ID" ]]; then
    cancel_inflight
  elif [[ -n "$SENDING" ]]; then
    echo "An SSM command was being sent; it may have reached the server, so the state is unknown."
    echo "Check it with: deploy/server/release.sh status"
  elif [[ -z "$SENT_ANY" ]]; then
    echo "Nothing was sent to the server; nothing changed."
  else
    echo "No step was running on the server; the steps above ended as shown."
  fi
}

# cancel_inflight: cancels the SSM command in flight and reports what the server confirms.
cancel_inflight() {
  local id="$INFLIGHT_ID"
  capture aws ssm cancel-command --command-id "$id" --instance-ids "$INSTANCE_ID" --region "$REGION" ||
    echo "Could not cancel SSM command $id: $ERR"
  if [[ "$INFLIGHT_KIND" == status ]]; then
    INFLIGHT_ID=""
    echo "Cancelled SSM command $id, a read-only step: nothing changed on the server."
    return
  fi
  echo "Cancelled SSM command $id (the $INFLIGHT_STEP step); waiting for the server to stop it."
  await_command "$id" "$CANCEL_POLLS"
  if unchanged; then
    echo "The server confirms the step changed nothing."
  else
    echo "The server did not confirm that the $INFLIGHT_STEP step changed nothing: the state is unknown."
    echo "Check it with: deploy/server/release.sh status"
  fi
}

interrupted_up() {
  if [[ -n "$INFLIGHT_ID" ]]; then
    echo "The $UP_ACTION step of $TAG is running on the server and is never cut short (it may be"
    echo "replacing containers): waiting for it to end, then bringing the previous release back."
    echo "Interrupt again to leave it running."
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
    LAST_STEP="$INFLIGHT_STEP"
  elif [[ -n "$SENDING" ]]; then
    unknown_state "$TAG was interrupted while its $INFLIGHT_STEP step was being sent"
    echo "If the server stays held, free it with deploy/server/release.sh unlock."
    return
  fi
  case "$LAST_STEP" in
    finish)
      if [[ "$REMOTE_CODE" -eq 0 ]]; then
        echo "$TAG passed the smoke checks and was recorded before the interrupt: it is released."
        echo "To undo it: deploy/server/release.sh rollback"
      else
        echo "$TAG is up and passed the smoke checks, but recording it failed (above)."
        echo "Check what serves with: deploy/server/release.sh status"
      fi
      ;;
    revert) after_restore ;;
    *) revert_now ;;
  esac
}

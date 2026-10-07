#!/usr/bin/env bash
# Tests for the systemd units and helper scripts deploy/server/user-data.sh installs: the
# unhealthy-container restarter, the reboot check and the update window.
# Run: bash deploy/server/tests/user-data-units.test.sh
# Installs into a temporary directory and runs the scripts against stubbed docker, date,
# needs-restarting and systemctl; nothing touches this machine's services.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=deploy/server/user-data.sh
source "$SERVER_DIR/user-data.sh"

# Stubs log their argv to $STUB_LOG. docker lists $DOCKER_UNHEALTHY and answers inspect from
# $DOCKER_STARTED ("name=time ..."); date knows "now" as $DATE_NOW and parses RFC 3339 like
# GNU date -d; needs-restarting prints $NR_OUTPUT and exits $NR_STATUS.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_LOG"
case "$1" in
  ps) [[ -z "${DOCKER_PS_FAIL:-}" ]] || exit 1; printf '%b' "${DOCKER_UNHEALTHY:-}" ;;
  inspect)
    for pair in ${DOCKER_STARTED:-}; do [[ "${pair%%=*}" == "${*: -1}" ]] && { echo "${pair#*=}"; exit 0; }; done
    exit 1 ;;
  restart) [[ "$2" != "${DOCKER_RESTART_FAIL:-}" ]] || exit 1; echo "$2" ;;
esac
SH
cat >"$TMP/bin/date" <<'SH'
#!/usr/bin/env bash
[[ "$1" == +%s ]] && { python3 -c 'import sys, datetime as d; print(int(d.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=d.timezone.utc).timestamp()))' "$DATE_NOW"; exit; }
[[ "$1" == -d && "$3" == +%s ]] || exit 1
python3 -c 'import sys, datetime as d; print(int(d.datetime.strptime(sys.argv[1][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=d.timezone.utc).timestamp()))' "$2" 2>/dev/null
SH
cat >"$TMP/bin/needs-restarting" <<'SH'
#!/usr/bin/env bash
echo "needs-restarting $*" >>"$STUB_LOG"
printf '%s\n' "$NR_OUTPUT"
exit "$NR_STATUS"
SH
# shellcheck disable=SC2016 # expanded by the stub when it runs
printf '#!/usr/bin/env bash\necho "systemctl $*" >>"$STUB_LOG"\n' >"$TMP/bin/systemctl"
chmod 755 "$TMP"/bin/*
export PATH="$TMP/bin:$PATH" STUB_LOG="$TMP/stub.log" DATE_NOW=2026-10-07T10:00:00Z
SBIN="$TMP/sbin"
UNITS="$TMP/units"

# ---------------------------------------------------------------- unhealthy restarter
(install_restarter "$SBIN" "$UNITS") >"$TMP/restarter.out" 2>&1
RESTARTER="$SBIN/comp-restart-unhealthy"
check "restarter: installed executable" test "$(mode_of "$RESTARTER")" = 755
check "restarter: the service runs it" grep -qxF "ExecStart=$RESTARTER" "$UNITS/comp-restart-unhealthy.service"
check "restarter: the service needs docker" grep -qxF "Requires=docker.service" "$UNITS/comp-restart-unhealthy.service"
check "restarter: runs every minute" grep -qxF "OnUnitActiveSec=1min" "$UNITS/comp-restart-unhealthy.timer"
check "restarter: starts with the machine" grep -qxF "WantedBy=timers.target" "$UNITS/comp-restart-unhealthy.timer"
check "restarter: is shellcheck clean" shellcheck "$RESTARTER"

export DOCKER_STARTED="comp-api-1=2026-10-07T09:58:30.123456789Z comp-app-1=2026-10-07T09:40:00.5Z"
: >"$STUB_LOG"
DOCKER_UNHEALTHY='comp-api-1\ncomp-app-1\ncomp-portal-1\n' "$RESTARTER" >"$TMP/r.out" 2>&1
check "restarter: exits zero" test "$?" -eq 0
check "restarter: lists unhealthy comp containers, not one-off runs" test "$(head -n 1 "$STUB_LOG")" = \
  "docker ps --filter label=com.docker.compose.project=comp --filter label=com.docker.compose.oneoff=False --filter health=unhealthy --format {{.Names}}"
check "restarter: reads each start time" grep -qxF "docker inspect --format {{.State.StartedAt}} comp-api-1" "$STUB_LOG"
check "restarter: leaves a container started under 5 minutes ago" bash -c "! grep -q 'restart comp-api-1' '$STUB_LOG'"
check "restarter: says why it left it" grep -qxF "leaving unhealthy container comp-api-1 alone: started 90s ago (under 300s)" "$TMP/r.out"
check "restarter: restarts an older one" grep -qxF "docker restart comp-app-1" "$STUB_LOG"
check "restarter: restarts one whose start time is unreadable" grep -qxF "docker restart comp-portal-1" "$STUB_LOG"
check "restarter: logs each restart" test "$(grep '^restarting' "$TMP/r.out")" = \
  $'restarting unhealthy container comp-app-1\nrestarting unhealthy container comp-portal-1'

: >"$STUB_LOG"
"$RESTARTER" >"$TMP/r-none.out" 2>&1
check "restarter: nothing unhealthy exits zero" test "$?" -eq 0
check "restarter: nothing unhealthy restarts nothing" bash -c "! grep -q restart '$STUB_LOG'"
check "restarter: nothing unhealthy is quiet" test ! -s "$TMP/r-none.out"

DOCKER_UNHEALTHY='comp-portal-1\ncomp-app-1\n' DOCKER_RESTART_FAIL=comp-portal-1 "$RESTARTER" >"$TMP/r-fail.out" 2>&1
check "restarter: a failed restart exits non-zero" test "$?" -ne 0
check "restarter: a failed restart says which" grep -qF "could not restart comp-portal-1" "$TMP/r-fail.out"
check "restarter: a failed restart still tries the rest" grep -qF "restarting unhealthy container comp-app-1" "$TMP/r-fail.out"
DOCKER_PS_FAIL=1 "$RESTARTER" >"$TMP/r-ps.out" 2>&1
check "restarter: docker ps failure exits non-zero" test "$?" -ne 0

# ---------------------------------------------------------------- reboot check
(install_reboot_check "$SBIN" "$UNITS") >"$TMP/reboot.out" 2>&1
REBOOTER="$SBIN/comp-reboot-if-needed"
check "reboot check: installed executable" test "$(mode_of "$REBOOTER")" = 755
check "reboot check: is shellcheck clean" shellcheck "$REBOOTER"
check "reboot check: the service runs it" grep -qxF "ExecStart=$REBOOTER" "$UNITS/comp-reboot-if-needed.service"
check "reboot check: oneshot" grep -qxF "Type=oneshot" "$UNITS/comp-reboot-if-needed.service"
check "reboot check: Sundays 09:30 UTC" grep -qxF "OnCalendar=Sun *-*-* 09:30:00 UTC" "$UNITS/comp-reboot-if-needed.timer"
check "reboot check: never catches up after downtime" grep -qxF "Persistent=false" "$UNITS/comp-reboot-if-needed.timer"
check "reboot check: starts with the machine" grep -qxF "WantedBy=timers.target" "$UNITS/comp-reboot-if-needed.timer"

reboot_run() { # reboot_run <status> <output text> <log>: runs the check against the stubs
  : >"$STUB_LOG"
  NR_STATUS="$1" NR_OUTPUT="$2" "$REBOOTER" >"$3" 2>&1
}
reboot_run 0 $'No core libraries or services have been updated since boot-up.\nReboot should not be necessary.' "$TMP/nr-no.out"
check "reboot check: nothing new exits zero" test "$?" -eq 0
check "reboot check: asks needs-restarting -r" grep -qxF "needs-restarting -r" "$STUB_LOG"
check "reboot check: nothing new does not reboot" bash -c "! grep -q 'systemctl reboot' '$STUB_LOG'"
check "reboot check: nothing new is logged" grep -qxF "no reboot needed" "$TMP/nr-no.out"
reboot_run 1 $'Core libraries or services have been updated since boot-up:\n  * kernel\n\nReboot is required to fully utilize these updates.' "$TMP/nr-yes.out"
check "reboot check: a new kernel reboots" grep -qxF "systemctl reboot" "$STUB_LOG"
check "reboot check: a reboot is logged" grep -qxF "rebooting to finish installing updates" "$TMP/nr-yes.out"
reboot_run 1 "Error: unknown command" "$TMP/nr-err.out"
check "reboot check: an error exits non-zero" test "$?" -ne 0
check "reboot check: an error does not reboot" bash -c "! grep -q 'systemctl reboot' '$STUB_LOG'"
check "reboot check: an error says so" grep -qF "needs-restarting failed (exit 1); not rebooting" "$TMP/nr-err.out"

# ---------------------------------------------------------------- update window
(install_update_window "$UNITS") >"$TMP/window.out" 2>&1
WINDOW="$UNITS/dnf-automatic.timer.d/comp-window.conf"
check "update window: clears the packaged schedule" grep -qxF "OnCalendar=" "$WINDOW"
check "update window: daily 09:00 UTC" grep -qxF "OnCalendar=*-*-* 09:00:00 UTC" "$WINDOW"
check "update window: no random delay" grep -qxF "RandomizedDelaySec=0" "$WINDOW"
check "update window: a timer section" test "$(head -n 1 "$WINDOW")" = "[Timer]"

finish

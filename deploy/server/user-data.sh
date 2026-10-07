#!/bin/bash
# First-boot setup of the comp tunnel server (Amazon Linux 2023, arm64). deploy/server/provision.sh
# passes this file to run-instances; cloud-init runs it once, as root, and its output lands in
# /var/log/cloud-init-output.log (`sudo cloud-init status --long` shows whether it failed).
#
# It installs Docker from the AL2023 repository, the compose and buildx plugins from their
# GitHub releases (pinned versions, pinned sha256; a mismatch stops the run), git, python3,
# dnf-automatic (security updates daily at 09:00 UTC) and dnf-utils (a reboot check Sundays at
# 09:30 UTC, only when updates need it; both wait for the release lock); adds 8 GiB swap; installs a
# timer that restarts unhealthy comp containers every minute; clones revola-ai/comp into
# /opt/comp/src; and last checks Docker Engine >= 25 and Compose >= 2.30 (compose.yaml needs both).
# On success it writes /opt/comp/provisioned. EC2 caps user data at 16 KB.
#
# Sourcing the file (deploy/server/tests/user-data.test.sh does) defines everything and runs
# nothing.

# Checksums from each release's checksums.txt, cross-checked with the per-asset digest GitHub
# reports (2026-10-07). To bump: change the version and the checksum together.
COMPOSE_VERSION=v5.5.1
COMPOSE_SHA256=732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7
COMPOSE_URL="https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-aarch64"
BUILDX_VERSION=v0.37.2
BUILDX_SHA256=efa38cb7aa7db2dbb9ad049b00b0a9737f66f033626177b5a4e845184ad7ab29
BUILDX_URL="https://github.com/docker/buildx/releases/download/$BUILDX_VERSION/buildx-$BUILDX_VERSION.linux-arm64"
# Searched before the distribution's plugin directories, so these win over any packaged copy.
PLUGIN_DIR=/usr/local/lib/docker/cli-plugins

MIN_ENGINE=25.0.0  # healthcheck start_interval
MIN_COMPOSE=2.30.0 # env_file format: raw

REPO_URL=https://github.com/revola-ai/comp
SRC_DIR=/opt/comp/src
SWAP_FILE=/swapfile
SWAP_MIB=8192
# The lock release.sh steps take (lib/server-common.sh; tests/user-data-units.test.sh checks it):
# security updates and the reboot check wait for it, so neither restarts Docker mid-release.
LOCKED="/usr/bin/flock -w 3600 /opt/comp/release.lock"

fail() {
  echo "user-data: FAILED: $*" >&2
  exit 1
}

# version_at_least <actual> <minimum>: true when the leading dotted number of <actual> (a "v"
# prefix and any suffix such as "-1.amzn2023" ignored) is at least <minimum>.
version_at_least() {
  local actual="${1#v}" i
  local -a have want
  [[ "$actual" =~ ^[0-9]+(\.[0-9]+)* ]] || return 1
  IFS=. read -ra have <<<"${BASH_REMATCH[0]}"
  IFS=. read -ra want <<<"$2"
  for i in 0 1 2; do
    if ((10#${have[i]:-0} != 10#${want[i]:-0})); then
      ((10#${have[i]:-0} > 10#${want[i]:-0}))
      return
    fi
  done
}

require_version() { # require_version <what> <actual> <minimum>
  version_at_least "$2" "$3" || fail "$1 ${2:-(unreadable)} is older than $3"
}

# install_plugin <url> <sha256> <destination>: downloads next to the destination, checks the
# checksum and only then moves it into place, so a bad download never replaces a good binary.
install_plugin() {
  local url="$1" expected="$2" dest="$3" tmp actual
  mkdir -p "$(dirname "$dest")"
  tmp="$(mktemp "$(dirname "$dest")/.download.XXXXXX")"
  if ! curl -fsSL --retry 5 --retry-delay 2 -o "$tmp" "$url"; then
    rm -f "$tmp"
    fail "could not download $url"
  fi
  actual="$(sha256sum "$tmp" | cut -d' ' -f1)"
  if [[ "$actual" != "$expected" ]]; then
    rm -f "$tmp"
    fail "checksum mismatch for $url: expected $expected, got $actual"
  fi
  chmod 755 "$tmp"
  mv -f "$tmp" "$dest"
}

require_docker_versions() {
  local buildx
  require_version "Docker Engine" "$(docker version --format '{{.Server.Version}}' 2>/dev/null)" "$MIN_ENGINE"
  require_version "Docker Compose" "$(docker compose version --short 2>/dev/null)" "$MIN_COMPOSE"
  buildx="$(docker buildx version 2>/dev/null)" || true
  [[ "$buildx" == *" $BUILDX_VERSION "* ]] || fail "docker buildx is not $BUILDX_VERSION (got: ${buildx:-nothing})"
}

# configure_updates <automatic.conf> <releasever file>: dnf-automatic applies security updates,
# Docker and containerd included (a short container restart beats an unpatched runtime), with
# no random delay: install_update_window sets when. AL2023 pins dnf to the AMI's release, so
# releasever "latest" is what lets it find new ones.
configure_updates() {
  local conf="$1" releasever="$2"
  [[ -f "$conf" ]] || fail "$conf is missing (is dnf-automatic installed?)"
  sed -E -e 's/^upgrade_type[[:space:]]*=.*/upgrade_type = security/' \
    -e 's/^apply_updates[[:space:]]*=.*/apply_updates = yes/' \
    -e 's/^random_sleep[[:space:]]*=.*/random_sleep = 0/' "$conf" >"$conf.new"
  mv -f "$conf.new" "$conf"
  if ! grep -qx 'upgrade_type = security' "$conf" || ! grep -qx 'apply_updates = yes' "$conf"; then
    fail "could not configure $conf (expected upgrade_type and apply_updates lines)"
  fi
  mkdir -p "$(dirname "$releasever")"
  echo latest >"$releasever"
}

# install_restarter <sbin dir> <unit dir>: Docker restarts a container that exits
# (restart: unless-stopped) but not one whose healthcheck fails; this timer does.
install_restarter() {
  local script="$1/comp-restart-unhealthy"
  mkdir -p "$1" "$2"
  cat >"$script" <<'SCRIPT'
#!/bin/bash
# Restarts every comp container whose healthcheck reports unhealthy. One-off `compose run`
# containers (a migration) are left alone, and so is a container started under 5 minutes ago
# (still in its start period, or one a release is waiting on). Runs every minute from
# comp-restart-unhealthy.timer; its output is in `journalctl -u comp-restart-unhealthy`.
set -uo pipefail
MIN_AGE=300
names="$(docker ps --filter label=com.docker.compose.project=comp \
  --filter label=com.docker.compose.oneoff=False --filter health=unhealthy \
  --format '{{.Names}}')" || { echo "docker ps failed" >&2; exit 1; }
now="$(date +%s)"
status=0
while read -r name; do
  [[ -n "$name" ]] || continue
  started=0 # an unreadable start time counts as long ago
  if since="$(docker inspect --format '{{.State.StartedAt}}' "$name" 2>/dev/null)"; then
    started="$(date -d "$since" +%s 2>/dev/null)" || started=0
  fi
  if ((now - started < MIN_AGE)); then
    echo "leaving unhealthy container $name alone: started $((now - started))s ago (under ${MIN_AGE}s)"
    continue
  fi
  echo "restarting unhealthy container $name"
  docker restart "$name" >/dev/null || { echo "could not restart $name" >&2; status=1; }
done <<<"$names"
exit "$status"
SCRIPT
  chmod 755 "$script"
  cat >"$2/comp-restart-unhealthy.service" <<UNIT
[Unit]
Description=Restart comp containers whose healthcheck reports unhealthy
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$script
UNIT
  cat >"$2/comp-restart-unhealthy.timer" <<'UNIT'
[Unit]
Description=Check comp container health every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
}

# install_reboot_check <sbin dir> <unit dir>: dnf-automatic installs updates but never reboots;
# this reboots on Sundays at 09:30 UTC, only when `needs-restarting -r` says installed updates (a
# kernel, glibc, systemd) need it. Docker is enabled and every container is restart:
# unless-stopped, so the stack comes back by itself.
install_reboot_check() {
  local script="$1/comp-reboot-if-needed"
  mkdir -p "$1" "$2"
  cat >"$script" <<'SCRIPT'
#!/bin/bash
# Reboots when installed updates need it (needs-restarting -r exits 1 and says so), unless a
# release holds the server between its steps (an unexpired /opt/comp/release.lease); otherwise
# does nothing. Run by comp-reboot-if-needed.timer under the release lock; output in
# `journalctl -u comp-reboot-if-needed`.
set -uo pipefail
LEASE="${COMP_LEASE_FILE:-/opt/comp/release.lease}"
report="$(needs-restarting -r 2>&1)"
status=$?
echo "$report"
if [[ "$status" -eq 0 ]]; then
  echo "no reboot needed"
  exit 0
fi
if [[ "$status" -eq 1 && "$report" == *"Reboot is required"* ]]; then
  holder="" expires=0 what=""
  [[ ! -s "$LEASE" ]] || read -r holder expires what <"$LEASE" || true
  [[ "$expires" =~ ^[0-9]+$ ]] || expires=0
  left=$((expires - $(date +%s)))
  if [[ -n "$holder" ]] && ((left > 0)); then
    echo "reboot needed, but not rebooting: $what (run $holder) holds the server for $left more seconds"
    exit 0
  fi
  echo "rebooting to finish installing updates"
  systemctl reboot
  exit
fi
echo "needs-restarting failed (exit $status); not rebooting" >&2
exit 1
SCRIPT
  chmod 755 "$script"
  cat >"$2/comp-reboot-if-needed.service" <<UNIT
[Unit]
Description=Reboot when installed updates need it
# Ordered after the update run, so a reboot never cuts a dnf transaction short.
After=dnf-automatic.service

[Service]
Type=oneshot
ExecStart=$LOCKED $script
UNIT
  cat >"$2/comp-reboot-if-needed.timer" <<'UNIT'
[Unit]
Description=Weekly reboot check, Sundays 09:30 UTC

[Timer]
OnCalendar=Sun *-*-* 09:30:00 UTC
Persistent=false

[Install]
WantedBy=timers.target
UNIT
}

# install_update_window <unit dir>: dnf-automatic daily at 09:00 UTC and only then; after
# downtime the next 09:00 run catches up instead of a run at boot (the packaged timer is
# Persistent=true).
install_update_window() {
  mkdir -p "$1/dnf-automatic.timer.d"
  cat >"$1/dnf-automatic.timer.d/comp-window.conf" <<'UNIT'
[Timer]
OnCalendar=
OnCalendar=*-*-* 09:00:00 UTC
RandomizedDelaySec=0
Persistent=false
UNIT
}

# install_update_lock <unit dir> <packaged dnf-automatic.service>: runs the packaged update
# command under the release lock (a drop-in resets ExecStart and wraps it), so updates never
# restart Docker while a release step runs. Upstream dnf 4.14 ships
# "/usr/bin/dnf-automatic /etc/dnf/automatic.conf --timer"; any other shape stops the run.
install_update_lock() {
  local command
  [[ -f "$2" ]] || fail "$2 is missing (is dnf-automatic installed?)"
  command="$(sed -n 's/^ExecStart=//p' "$2")"
  [[ -n "$command" && "$command" != *$'\n'* ]] || fail "expected one ExecStart line in $2, got: ${command:-none}"
  mkdir -p "$1/dnf-automatic.service.d"
  printf '[Service]\nExecStart=\nExecStart=%s %s\n' "$LOCKED" "$command" >"$1/dnf-automatic.service.d/comp-release-lock.conf"
}

make_swap() {
  if [[ ! -f "$SWAP_FILE" ]]; then
    dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_MIB" status=none
    chmod 600 "$SWAP_FILE"
    mkswap "$SWAP_FILE" >/dev/null
  fi
  [[ "$(swapon --show=NAME --noheadings)" == *"$SWAP_FILE"* ]] || swapon "$SWAP_FILE"
  grep -q "^$SWAP_FILE " /etc/fstab || echo "$SWAP_FILE none swap defaults 0 0" >>/etc/fstab
}

main() {
  [[ "$(uname -m)" == aarch64 ]] || fail "expected an arm64 (aarch64) instance, got $(uname -m)"
  echo "user-data: installing packages"
  dnf install -y docker git python3 dnf-automatic dnf-utils
  install_plugin "$COMPOSE_URL" "$COMPOSE_SHA256" "$PLUGIN_DIR/docker-compose"
  install_plugin "$BUILDX_URL" "$BUILDX_SHA256" "$PLUGIN_DIR/docker-buildx"
  systemctl enable --now docker

  echo "user-data: security updates, reboot check, swap, unhealthy-container timer"
  configure_updates /etc/dnf/automatic.conf /etc/dnf/vars/releasever
  install_update_window /etc/systemd/system
  install_update_lock /etc/systemd/system /usr/lib/systemd/system/dnf-automatic.service
  install_reboot_check /usr/local/sbin /etc/systemd/system
  install_restarter /usr/local/sbin /etc/systemd/system
  systemctl daemon-reload
  systemctl enable --now dnf-automatic.timer
  systemctl enable --now comp-reboot-if-needed.timer
  systemctl enable --now comp-restart-unhealthy.timer
  make_swap

  echo "user-data: cloning $REPO_URL into $SRC_DIR"
  mkdir -p "$(dirname "$SRC_DIR")"
  [[ -d "$SRC_DIR/.git" ]] || git clone --quiet "$REPO_URL" "$SRC_DIR"

  require_docker_versions
  docker version --format 'docker {{.Server.Version}}' >/opt/comp/provisioned
  docker compose version >>/opt/comp/provisioned
  echo "user-data: done"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  main "$@"
fi

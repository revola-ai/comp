#!/usr/bin/env bash
# Tests for deploy/server/user-data.sh. Run: bash deploy/server/tests/user-data.test.sh
# Sources the script (which then defines its functions and runs nothing) and drives each
# function with stubbed curl, docker and friends; nothing is installed and nothing is fetched.
set -uo pipefail
# shellcheck source=deploy/server/tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
USER_DATA="$SERVER_DIR/user-data.sh"

# Stubs log their argv to $STUB_LOG; curl writes $CURL_BODY to its -o file (or fails when
# CURL_FAIL is set); docker answers from DOCKER_* variables.
mkdir -p "$TMP/bin"
for tool in dnf systemctl git dd mkswap swapon; do
  # shellcheck disable=SC2016 # expanded by the stub when it runs
  printf '#!/usr/bin/env bash\necho "%s $*" >>"$STUB_LOG"\n' "$tool" >"$TMP/bin/$tool"
done
cat >"$TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
echo "curl $*" >>"$STUB_LOG"
[[ -z "${CURL_FAIL:-}" ]] || exit 22
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o ]]; then printf '%s' "$CURL_BODY" >"$2"; fi
  shift
done
SH
cat >"$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_LOG"
case "$1 ${2:-}" in
  "version --format") [[ -n "${DOCKER_ENGINE:-}" ]] && echo "$DOCKER_ENGINE" || exit 1 ;;
  "compose version") echo "${DOCKER_COMPOSE:-}" ;;
  "buildx version") [[ -z "${DOCKER_BUILDX_FAIL:-}" ]] || exit 1
    echo "github.com/docker/buildx ${DOCKER_BUILDX:-} 0123456789abcdef" ;;
  "ps --filter") [[ -z "${DOCKER_PS_FAIL:-}" ]] || exit 1; printf '%b' "${DOCKER_UNHEALTHY:-}" ;;
  "restart "*) [[ "$2" != "${DOCKER_RESTART_FAIL:-}" ]] || exit 1; echo "$2" ;;
esac
SH
chmod 755 "$TMP"/bin/*
export PATH="$TMP/bin:$PATH" STUB_LOG="$TMP/stub.log"
: >"$STUB_LOG"

# ---------------------------------------------------------------- the file
check "has a bash shebang (cloud-init runs it as a script)" test "$(head -n 1 "$USER_DATA")" = "#!/bin/bash"
check "is under the 16 KB EC2 user-data limit" test "$(wc -c <"$USER_DATA")" -lt 16384
check "parses" bash -n "$USER_DATA"
check "is shellcheck clean" shellcheck "$USER_DATA"
# shellcheck source=deploy/server/user-data.sh
source "$USER_DATA"
check "sourcing runs nothing" test ! -s "$STUB_LOG"
check "sourcing leaves errexit off" test "${-//[^e]/}" = ""

check "compose is pinned to a release" bash -c "[[ '$COMPOSE_VERSION' =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]"
check "buildx is pinned to a release" bash -c "[[ '$BUILDX_VERSION' =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]"
check "compose checksum is a sha256" bash -c "[[ '$COMPOSE_SHA256' =~ ^[0-9a-f]{64}$ ]]"
check "buildx checksum is a sha256" bash -c "[[ '$BUILDX_SHA256' =~ ^[0-9a-f]{64}$ ]]"
check "compose URL is the linux-aarch64 release asset" test "$COMPOSE_URL" = \
  "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-aarch64"
check "buildx URL is the linux-arm64 release asset" test "$BUILDX_URL" = \
  "https://github.com/docker/buildx/releases/download/$BUILDX_VERSION/buildx-$BUILDX_VERSION.linux-arm64"
check "pinned compose is at least 2.30" version_at_least "$COMPOSE_VERSION" 2.30.0
check "requires Docker Engine 25" test "$MIN_ENGINE" = 25.0.0
check "requires Compose 2.30" test "$MIN_COMPOSE" = 2.30.0
check "clones revola-ai/comp into /opt/comp/src" \
  test "$REPO_URL $SRC_DIR" = "https://github.com/revola-ai/comp /opt/comp/src"
check "clones the fork release.sh checks and the server fetches (COMP_REPO_URL)" \
  test "$REPO_URL" = "$(bash -c 'source "$1" && printf %s "${COMP_REPO_URL:-unset}"' _ "$SERVER_DIR/lib/server-common.sh")"
check "swap is 8 GiB" test "$SWAP_MIB" = 8192
check "installs docker, git, python3, dnf-automatic and dnf-utils" \
  grep -qxF "  dnf install -y docker git python3 dnf-automatic dnf-utils" "$USER_DATA"
for unit in docker dnf-automatic.timer comp-restart-unhealthy.timer comp-reboot-if-needed.timer; do
  check "enables $unit" grep -qxF "  systemctl enable --now $unit" "$USER_DATA"
done
check "checks Docker versions last, right before the done marker" test \
  "$(grep -B 1 -m 1 '>/opt/comp/provisioned' "$USER_DATA" | head -n 1)" = "  require_docker_versions"

# ---------------------------------------------------------------- version_at_least
for pair in "25.0.0 25.0.0" "25.0.8 25" "28.1.1 25.0.0" "v5.5.1 2.30.0" "2.30.0 2.30" "2.31.0-desktop.1 2.30.0" "10.0 9.9.9"; do
  read -r actual minimum <<<"$pair"
  check "$actual >= $minimum" version_at_least "$actual" "$minimum"
done
not() { ! "$@"; }
for pair in "24.0.9 25.0.0" "2.29.7 2.30.0" "v1.29.2 2.30.0" "garbage 25.0.0" "v 25.0.0"; do
  read -r actual minimum <<<"$pair"
  check "'$actual' is not >= $minimum" not version_at_least "$actual" "$minimum"
done
check "'' is not >= 25.0.0" not version_at_least "" 25.0.0

# ---------------------------------------------------------------- install_plugin
export CURL_BODY="plugin-binary-bytes"
GOOD_SHA="$(printf '%s' "$CURL_BODY" | sha256sum | cut -d' ' -f1)"
PLUGINS="$TMP/plugins"
(install_plugin "https://example.test/compose" "$GOOD_SHA" "$PLUGINS/docker-compose") >"$TMP/good.out" 2>&1
check "plugin: installs on a matching checksum" test "$(cat "$PLUGINS/docker-compose" 2>/dev/null)" = "$CURL_BODY"
check "plugin: installed executable" test "$(mode_of "$PLUGINS/docker-compose")" = 755
check "plugin: downloads with retries and fails on HTTP errors" \
  grep -qF -- "curl -fsSL --retry 5 --retry-delay 2 -o " "$STUB_LOG"
check "plugin: leaves no temporary file" test "$(files_in "$PLUGINS")" = docker-compose

BAD_SHA="$(printf '0%.0s' {1..64})"
(install_plugin "https://example.test/buildx" "$BAD_SHA" "$PLUGINS/docker-buildx") >"$TMP/bad.out" 2>&1
status=$?
check "plugin mismatch: fails" test "$status" -ne 0
check "plugin mismatch: says so with both checksums" \
  grep -qF "checksum mismatch for https://example.test/buildx: expected $BAD_SHA, got $GOOD_SHA" "$TMP/bad.out"
check "plugin mismatch: installs nothing" test "$(files_in "$PLUGINS")" = docker-compose

(install_plugin "https://example.test/compose" "$BAD_SHA" "$PLUGINS/docker-compose") >"$TMP/keep.out" 2>&1
check "plugin mismatch: keeps the installed binary" test "$(cat "$PLUGINS/docker-compose")" = "$CURL_BODY"

(CURL_FAIL=1 install_plugin "https://example.test/gone" "$GOOD_SHA" "$PLUGINS/docker-gone") >"$TMP/gone.out" 2>&1
status=$?
check "plugin download failure: fails" test "$status" -ne 0
check "plugin download failure: says so" grep -qF "could not download https://example.test/gone" "$TMP/gone.out"
check "plugin download failure: installs nothing" test "$(files_in "$PLUGINS")" = docker-compose

# ---------------------------------------------------------------- require_docker_versions
versions() { # versions <engine> <compose> <buildx> <output>: runs the check as main does (errexit)
  (set -e; DOCKER_ENGINE="$1" DOCKER_COMPOSE="$2" DOCKER_BUILDX="$3" require_docker_versions) >"$4" 2>&1
}
versions 25.0.8 5.5.1 "$BUILDX_VERSION" "$TMP/v-ok.out"
check "versions: Engine 25 with the pinned plugins passes" test "$?" -eq 0
versions 24.0.9 5.5.1 "$BUILDX_VERSION" "$TMP/v-old.out"
check "versions: Engine 24 fails" test "$?" -ne 0
check "versions: Engine 24 says why" grep -qF "Docker Engine 24.0.9 is older than 25.0.0" "$TMP/v-old.out"
versions "" 5.5.1 "$BUILDX_VERSION" "$TMP/v-down.out"
check "versions: no daemon fails" test "$?" -ne 0
check "versions: no daemon says why" grep -qF "Docker Engine (unreadable) is older than 25.0.0" "$TMP/v-down.out"
versions 25.0.8 2.29.7 "$BUILDX_VERSION" "$TMP/v-compose.out"
check "versions: Compose 2.29 fails" test "$?" -ne 0
check "versions: Compose 2.29 says why" grep -qF "Docker Compose 2.29.7 is older than 2.30.0" "$TMP/v-compose.out"
versions 25.0.8 5.5.1 v0.12.1 "$TMP/v-buildx.out"
check "versions: another buildx fails" test "$?" -ne 0
check "versions: another buildx says why" grep -qF "docker buildx is not $BUILDX_VERSION" "$TMP/v-buildx.out"
DOCKER_BUILDX_FAIL=1 versions 25.0.8 5.5.1 "$BUILDX_VERSION" "$TMP/v-no-buildx.out"
check "versions: a failing buildx fails" test "$?" -ne 0
check "versions: a failing buildx says why (not a silent errexit)" \
  grep -qF "user-data: FAILED: docker buildx is not $BUILDX_VERSION (got: nothing)" "$TMP/v-no-buildx.out"

# ---------------------------------------------------------------- configure_updates
DNF_CONF="$TMP/automatic.conf"
cat >"$DNF_CONF" <<'CONF'
[commands]
#  What kind of upgrade to perform:
# default                            = all available upgrades
# security                           = only the security upgrades
upgrade_type = default
random_sleep = 300

# Whether updates should be applied when they are available, by
# dnf-automatic.timer. notify-only.timer will not apply updates.
apply_updates = no
CONF
(configure_updates "$DNF_CONF" "$TMP/releasever") >"$TMP/updates.out" 2>&1
check "updates: configured" test "$?" -eq 0
check "updates: security only" grep -qx "upgrade_type = security" "$DNF_CONF"
check "updates: applied" grep -qx "apply_updates = yes" "$DNF_CONF"
check "updates: no random delay (the timer sets the window)" grep -qx "random_sleep = 0" "$DNF_CONF"
check "updates: comments kept" grep -qxF "# security                           = only the security upgrades" "$DNF_CONF"
check "updates: follow the latest AL2023 release" test "$(cat "$TMP/releasever")" = latest
printf '[commands]\nupgrade_type = default\n' >"$DNF_CONF"
(configure_updates "$DNF_CONF" "$TMP/releasever") >"$TMP/updates-bad.out" 2>&1
check "updates: an unexpected config fails" test "$?" -ne 0
check "updates: says which file" grep -qF "could not configure $DNF_CONF" "$TMP/updates-bad.out"
(configure_updates "$TMP/missing.conf" "$TMP/releasever") >"$TMP/updates-missing.out" 2>&1
check "updates: a missing config fails" test "$?" -ne 0

finish

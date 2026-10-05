#!/usr/bin/env bash
# Run Comp locally from compiled output instead of dev-mode watchers.
#
# Dev mode (`bun run dev`) keeps Turbopack and tsc --watch resident and needs
# ~16 GB; this uses `next start` and `node dist/...` and needs ~4 GB. The two
# Trigger.dev workers still run as `trigger dev` so tasks run on this machine.
#
# Local containers (Postgres, MinIO, Redis) are started and stopped only when
# packages/db/.env points DATABASE_URL at localhost. With shared state (Supabase,
# Upstash) they are left alone; see docs/self-hosting-local.md, "Shared state".
#
#   scripts/local-run.sh build     # workspace libraries, then api + app (rerun after code changes)
#   scripts/local-run.sh start     # start containers, api, app, trigger workers
#   scripts/local-run.sh stop
#   scripts/local-run.sh status
#   scripts/local-run.sh logs <api|app|trigger-api|trigger-app>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.local/run"
LOG_DIR="$ROOT/.local/logs"
API_URL="http://localhost:3333"
APP_URL="http://localhost:3000"
SERVICES=(api app trigger-api trigger-app)

# Oldest Node the toolchain accepts: Prisma 7.6 requires ^20.19 || ^22.12 || >=24.0.
# Its major must equal .nvmrc's; change both together (the runner's tests check this).
NODE_MIN="22.12"
# 4 GB heap for the API compile: its tsc run exceeds Node's default heap on 8 GB machines.
BUILD_HEAP_MB=4096
# Where nvm may be installed: $NVM_DIR or the standard ~/.nvm, the installer's XDG location,
# then Homebrew on Apple silicon and Intel.
NVM_SCRIPTS=("${NVM_DIR:-$HOME/.nvm}/nvm.sh")
[[ -n "${XDG_CONFIG_HOME:-}" ]] && NVM_SCRIPTS+=("$XDG_CONFIG_HOME/nvm/nvm.sh")
NVM_SCRIPTS+=(/opt/homebrew/opt/nvm/nvm.sh /usr/local/opt/nvm/nvm.sh)

# True when dotted version $1 (no leading v) is at least $2, comparing major.minor.
version_at_least() {
  local found_major found_minor min_major min_minor
  IFS=. read -r found_major found_minor _ <<<"$1"
  IFS=. read -r min_major min_minor _ <<<"$2"
  (( found_major > min_major || (found_major == min_major && ${found_minor:-0} >= ${min_minor:-0}) ))
}

# True when the node on PATH has major $1 and is at least NODE_MIN.
node_qualifies() {
  local version
  command -v node >/dev/null 2>&1 || return 1
  version="$(node -v)"
  version="${version#v}"
  [[ "${version%%.*}" == "$1" ]] && version_at_least "$version" "$NODE_MIN"
}

# Use the node on PATH when it qualifies (any installer: nvm, Homebrew, fnm, volta, mise).
# Otherwise ask nvm, when installed, for the .nvmrc major; fail with a message, never silently.
use_node() {
  local want nvm_sh
  want="$(tr -d '[:space:]' <"$ROOT/.nvmrc")"
  want="${want#v}"
  want="${want%%.*}"
  node_qualifies "$want" && return 0
  for nvm_sh in ${NVM_SCRIPTS[@]+"${NVM_SCRIPTS[@]}"}; do
    [[ -s "$nvm_sh" ]] || continue
    # Without the shell profile (IDE tasks, launchd) NVM_DIR is unset. A standard or XDG
    # install keeps its versions next to nvm.sh; Homebrew's nvm.sh lives in the brew prefix
    # and would otherwise look there, missing ~/.nvm/versions.
    if [[ -z "${NVM_DIR:-}" ]]; then
      case "$nvm_sh" in
        */opt/nvm/nvm.sh) NVM_DIR="$HOME/.nvm" ;;
        *) NVM_DIR="$(dirname "$nvm_sh")" ;;
      esac
    fi
    export NVM_DIR
    # --no-use: on load nvm.sh runs its own `nvm use` for .nvmrc, and when that fails
    # set -e ends this script with no message (exit 3).
    # shellcheck disable=SC1090
    source "$nvm_sh" --no-use
    if ! nvm use "$want" >/dev/null; then
      echo "ERROR: nvm could not switch to Node $want; run: nvm install $want" >&2
      exit 1
    fi
    break
  done
  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: Node $want ($NODE_MIN or newer) is required and no node is on PATH; install Node $want (for example: nvm install $want)" >&2
    exit 1
  fi
  if ! node_qualifies "$want"; then
    echo "ERROR: Node $want ($NODE_MIN or newer) is required, found $(node -v); install Node $want (for example: nvm install $want && nvm use $want)" >&2
    exit 1
  fi
}

# NODE_OPTIONS for the API compile: appends the build heap unless the caller already set
# one, as a size or a percentage (Node accepts dashes or underscores; a percentage
# overrides a size, so appending would do nothing).
build_node_options() {
  case " ${NODE_OPTIONS:-} " in
    *" --max-old-space-size="*|*" --max_old_space_size="*|*" --max-old-space-size-percentage="*|*" --max_old_space_size_percentage="*)
      printf '%s' "$NODE_OPTIONS" ;;
    *) printf '%s' "${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$BUILD_HEAP_MB" ;;
  esac
}

pid_of() { [[ -f "$RUN_DIR/$1.pid" ]] && cat "$RUN_DIR/$1.pid" || true; }

# True when packages/db/.env points DATABASE_URL at a local Postgres.
uses_local_db() {
  local host
  host="$(
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/packages/db/.env" 2>/dev/null
    set +a
    printf '%s' "${DATABASE_URL:-}" | sed -E 's#^[a-z]+://([^@]*@)?([^/:?]+).*#\2#'
  )"
  case "$host" in localhost|127.0.0.1|::1|"[::1]") return 0 ;; *) return 1 ;; esac
}

start_containers() {
  if ! uses_local_db; then
    echo "== containers: skipped (DATABASE_URL is not local; shared state mode)"
    return 0
  fi
  echo "== containers"
  ( cd "$ROOT/packages/db" && docker compose up -d 2>&1 | grep -v 'obsolete' || true )
  ( cd "$ROOT" && docker compose -f docker-compose.local.yml up -d 2>&1 | grep -v 'obsolete' || true )
}

stop_containers() {
  if ! uses_local_db; then
    echo "== containers: left running (shared state mode)"
    return 0
  fi
  echo "== containers"
  ( cd "$ROOT/packages/db" && docker compose stop 2>&1 | grep -v 'obsolete' || true )
  ( cd "$ROOT" && docker compose -f docker-compose.local.yml stop 2>&1 | grep -v 'obsolete' || true )
}

is_running() {
  local pid; pid="$(pid_of "$1")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

spawn() {
  local name="$1" dir="$2"; shift 2
  if is_running "$name"; then
    echo "already running  $name (pid $(pid_of "$name"))"
    return
  fi
  ( cd "$dir" && nohup "$@" >"$LOG_DIR/$name.log" 2>&1 </dev/null & echo $! >"$RUN_DIR/$name.pid" )
  echo "started          $name (pid $(pid_of "$name")) -> .local/logs/$name.log"
}

wait_for_url() {
  local url="$1" name="$2" tries="${3:-60}"
  for _ in $(seq 1 "$tries"); do
    curl -fs -o /dev/null --max-time 5 "$url" && return 0
    if ! is_running "$name"; then
      echo "ERROR: $name exited during startup; see .local/logs/$name.log" >&2
      return 1
    fi
    sleep 2
  done
  echo "ERROR: $name did not answer at $url; see .local/logs/$name.log" >&2
  return 1
}

cmd_build() {
  use_node
  # The api and app import workspace libraries from their dist folders; the ^... filters
  # build every workspace package the two apps depend on, and not the apps themselves.
  echo "== building workspace libraries"
  if [[ ! -x "$ROOT/node_modules/.bin/turbo" ]]; then
    echo "ERROR: turbo is not installed; run: bun install" >&2
    exit 1
  fi
  # --ui=stream: turbo.json's full-screen UI would clear a failing build's output.
  ( cd "$ROOT" && node_modules/.bin/turbo run build --ui=stream \
      --filter='@trycompai/api^...' --filter='@trycompai/app^...' )
  echo "== building api"
  ( cd "$ROOT/apps/api" && NODE_OPTIONS="$(build_node_options)" bun run build )
  echo "== building app"
  ( cd "$ROOT/apps/app" && bun run build )
  echo "build complete"
}

cmd_start() {
  mkdir -p "$RUN_DIR" "$LOG_DIR"
  use_node
  if [[ ! -f "$ROOT/apps/api/dist/src/main.js" || ! -d "$ROOT/apps/app/.next" ]]; then
    echo "no build output found; run: scripts/local-run.sh build" >&2
    exit 1
  fi

  start_containers

  echo "== api"
  spawn api "$ROOT/apps/api" node --enable-source-maps dist/src/main.js
  wait_for_url "$API_URL/api/auth/ok" api

  echo "== app"
  spawn app "$ROOT/apps/app" bunx next start -p 3000
  wait_for_url "$APP_URL/auth" app

  echo "== trigger workers"
  spawn trigger-api "$ROOT/apps/api" bunx trigger dev
  spawn trigger-app "$ROOT/apps/app" bunx trigger dev

  echo
  echo "dashboard: $APP_URL"
  echo "api docs:  $API_URL/api/docs"
}

cmd_stop() {
  local name pid
  for name in trigger-app trigger-api app api; do
    pid="$(pid_of "$name")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      # Kill the whole process group so bunx/next child processes go too.
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
      echo "stopped          $name (pid $pid)"
    fi
    rm -f "$RUN_DIR/$name.pid"
  done
  sleep 2
  pkill -TERM -f "$ROOT/node_modules/.bin/trigger dev" 2>/dev/null || true
  pkill -TERM -f "next-server" 2>/dev/null || true
  stop_containers
}

cmd_status() {
  local name
  for name in "${SERVICES[@]}"; do
    if is_running "$name"; then
      echo "running   $name (pid $(pid_of "$name"))"
    else
      echo "stopped   $name"
    fi
  done
  curl -fs -o /dev/null --max-time 3 "$API_URL/api/auth/ok" && echo "api       answering at $API_URL" || echo "api       not answering"
  curl -fs -o /dev/null --max-time 3 "$APP_URL/auth" && echo "app       answering at $APP_URL" || echo "app       not answering"
}

cmd_logs() {
  local name="${1:-}"
  if [[ -z "$name" || ! -f "$LOG_DIR/$name.log" ]]; then
    echo "usage: scripts/local-run.sh logs <${SERVICES[*]// /|}>" >&2
    exit 1
  fi
  tail -n 100 -f "$LOG_DIR/$name.log"
}

main() {
  # Version managers that pick node per directory (asdf, mise, volta) must see the repo,
  # so the version check matches the node the builds use.
  cd "$ROOT"
  case "${1:-}" in
    build)  cmd_build ;;
    start)  cmd_start ;;
    stop)   cmd_stop ;;
    status) cmd_status ;;
    logs)   cmd_logs "${2:-}" ;;
    *)
      echo "usage: scripts/local-run.sh <build|start|stop|status|logs <service>>" >&2
      exit 1
      ;;
  esac
}

# Run only when executed, so the tests can source the helpers.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

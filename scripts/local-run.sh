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
#   scripts/local-run.sh build     # compile api + app (rerun after code changes)
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

mkdir -p "$RUN_DIR" "$LOG_DIR"

use_node() {
  # shellcheck disable=SC1090
  [[ -s "$HOME/.nvm/nvm.sh" ]] && source "$HOME/.nvm/nvm.sh" && nvm use >/dev/null
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
  echo "== building api"
  ( cd "$ROOT/apps/api" && bun run build )
  echo "== building app"
  ( cd "$ROOT/apps/app" && bun run build )
  echo "build complete"
}

cmd_start() {
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

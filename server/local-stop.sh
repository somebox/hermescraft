#!/usr/bin/env bash
# Stop the local HermesCraft Paper server gracefully (rcon `stop`, save worlds),
# falling back to the PID file. Usage: server/local-stop.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local-common.sh"

echo "── stopping local Paper server ──"

stopped=0
if server_is_up; then
  log "sending graceful 'stop' via rcon…"
  rcon_cmd "stop" >/dev/null 2>&1 || true
  stopped=1
fi

if [ -f "$PID_FILE" ]; then
  pid="$(cat "$PID_FILE")"
  if [ "$stopped" = 1 ]; then
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  fi
  if kill -0 "$pid" 2>/dev/null; then
    log "process still up — SIGTERM pid $pid"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  log "stopped."
else
  [ "$stopped" = 1 ] && log "stop sent (no pid file)." || log "server not running."
fi

#!/usr/bin/env bash
# Start the local HermesCraft Paper server (headless, backgrounded).
# Waits until rcon answers, so on return the server is ready for bots/tests.
# Usage: server/local-start.sh [--no-banner]
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local-common.sh"

[ "${1:-}" = "--no-banner" ] || echo "── starting local Paper server ──"

[ -f "$PAPER_JAR" ] || die "paper.jar missing — run server/local-setup.sh first"

# Already up?
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null && server_is_up; then
  log "server already running (pid $(cat "$PID_FILE"))"
  exit 0
fi
rm -f "$PID_FILE"

mkdir -p "$(dirname "$LOG_FILE")"
cd "$SERVER_DIR"
# Aikar-style G1GC flags.
nohup java -Xms"$JAVA_XMS" -Xmx"$JAVA_XMX" \
  -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 \
  -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC \
  -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M \
  -jar "$PAPER_JAR" --nogui > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
log "pid $(cat "$PID_FILE") — log: $LOG_FILE"

log "waiting for rcon on :$RCON_PORT…"
for i in $(seq 1 90); do
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    die "server process exited during startup — see $LOG_FILE"
  fi
  if server_is_up; then
    log "server up (rcon responding) after ${i}s"
    exit 0
  fi
  sleep 1
done
die "timed out waiting for rcon — see $LOG_FILE"

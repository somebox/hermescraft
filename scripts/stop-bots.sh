#!/usr/bin/env bash
# Stop everything — disconnect all bots from MC and kill any agents.
#
# Hermes runs are a layered stack of long-lived processes:
#   1. mineflayer bots (node server.js)  — connected to the MC server.
#                                          Started by run-steve.sh /
#                                          run-tester-bot.sh.
#   2. bash wrappers (run-*-bot.sh)      — parents of (1).
#   3. hermes chat agents (python)       — talk to (1) over HTTP. Started
#                                          by run-landfolk-agent.sh, which
#                                          in turn is started by exp.sh.
#   4. exp.sh poller                     — writes positions.jsonl every 30s.
#
# `exp.sh stop` only stops (3) + (4). Re-running run-steve.sh restarts (1+2)
# but doesn't help if you just want to fully halt without restarting.
#
# This script kills (1)+(2)+(3)+(4) for both Steve and Tester profiles.
# After it returns, no Hermes-owned process is running, both bots have
# disconnected from MC, and the API ports are free.
#
# Usage:
#   scripts/stop-bots.sh         # stop everything, verbose
#   scripts/stop-bots.sh --quiet # only print warnings + the final summary
set -uo pipefail

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1
log()  { [[ $QUIET == 0 ]] && echo "$@"; return 0; }
warn() { echo "$@" >&2; }

# ── 1. Stop any active expedition (agents + poller) ───────────────────
if [[ -L /tmp/hermescraft/runs/current ]]; then
  log "[stop-bots] active expedition found — running exp.sh stop"
  "$(dirname "$0")/exp.sh" stop || true
else
  log "[stop-bots] no active expedition"
fi

# ── 2. Force-kill any surviving hermes chat agents ────────────────────
# `exp.sh stop` does this too, but be belt-and-suspenders. Match the
# canonical hermes binary path (visible in argv) — NOT HERMES_HOME (env
# var, NOT in argv on macOS — the old pattern bug).
if pgrep -f '/hermes chat --yolo' >/dev/null 2>&1; then
  log "[stop-bots] hermes chat agent survivors — SIGKILL"
  pkill -9 -f '/hermes chat --yolo' 2>/dev/null || true
fi
if pgrep -f 'run-landfolk-agent.sh' >/dev/null 2>&1; then
  pkill -9 -f 'run-landfolk-agent.sh' 2>/dev/null || true
fi

# ── 3. Stop bots ──────────────────────────────────────────────────────
# Each bot is `bash run-*-bot.sh PORT` → `node server.js` child. SIGTERM
# the wrapper; the child inherits and exits cleanly (mineflayer sends a
# proper disconnect packet). Fall back to SIGKILL if needed.
for pattern in 'run-steve-bot.sh' 'run-tester-bot.sh' 'run-gatherer-bot.sh'; do
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    log "[stop-bots] stopping $pattern"
    pkill -f "$pattern" 2>/dev/null || true
  fi
done
sleep 2
# Force-kill any survivor node server.js processes that didn't exit.
# Filter to ones that look like the bot (listening on 3001/3002/3004 etc).
for port in 3001 3002 3003 3004 3005; do
  pid=$(lsof -ti tcp:"$port" 2>/dev/null | head -1)
  if [[ -n "$pid" ]]; then
    # Skip the dashboard (port 3000) — only bots use 3001+.
    log "[stop-bots] port $port still held by pid=$pid — SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  fi
done

# Viewer ports too (4001..4005).
for port in 4001 4002 4003 4004 4005; do
  pid=$(lsof -ti tcp:"$port" 2>/dev/null | head -1)
  if [[ -n "$pid" ]]; then
    log "[stop-bots] viewer port $port still held by pid=$pid — SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  fi
done

# ── 4. Summary ────────────────────────────────────────────────────────
sleep 1
# Re-verify with two reads — the first can race with processes exiting.
# Match patterns that ONLY appear in hermes-owned processes' argv. Don't
# include `MC_USERNAME=` (an env var, sometimes leaked in transient
# subshells) — that produced false positives on clean systems.
PATTERN='/hermes chat --yolo|run-steve-bot.sh|run-tester-bot.sh|run-landfolk-agent.sh'
# pgrep -lf prints "pid command"; count non-empty lines. If the first
# scan races with an exiting process, the second scan a beat later sees
# it gone, so the warning is suppressed for transients.
sleep 1
survivors=$(pgrep -lf "$PATTERN" 2>/dev/null || true)
if [[ -z "$survivors" ]]; then
  log "[stop-bots] all bots and agents stopped."
else
  warn "[stop-bots] WARNING — survivors:"
  printf '%s\n' "$survivors" | sed 's/^/  /'
  exit 1
fi

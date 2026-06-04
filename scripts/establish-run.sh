#!/usr/bin/env bash
# Full establish operator path: preflight → cleanup → optional fresh disc → bootstrap → verify.
#
# Usage:
#   scripts/establish-run.sh
#   scripts/establish-run.sh --fresh-disc 1001
#   scripts/establish-run.sh --skip-preflight --skip-verify
#   RUN_ID=phase12 scripts/establish-run.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -x /opt/homebrew/bin/bash ]]; then
  export PATH="/opt/homebrew/bin:$PATH"
fi

BASH5="${BASH:-}"
if [[ "${BASH_VERSINFO[0]:-0}" -lt 5 ]] && [[ -x /opt/homebrew/bin/bash ]]; then
  BASH5=/opt/homebrew/bin/bash
fi
[[ -n "$BASH5" ]] || BASH5=bash

SKIP_PREFLIGHT=0
SKIP_VERIFY=0
SKIP_DASHBOARD="${SKIP_DASHBOARD:-0}"
FRESH_DISC=""
ARCHIVE_LOGS=0
MIN_CREDITS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-preflight) SKIP_PREFLIGHT=1; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --no-dashboard) SKIP_DASHBOARD=1; shift ;;
    --fresh-disc) FRESH_DISC="${2:?seed}"; shift 2 ;;
    --archive-logs) ARCHIVE_LOGS=1; shift ;;
    --min-credits-usd) MIN_CREDITS="${2:-5}"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
establish-run.sh — one command establish bootstrap

  --fresh-disc SEED     reset-proc-lab.py before bootstrap
  --archive-logs        mv /tmp/hermescraft aside before run
  --min-credits-usd N   fail preflight if OpenRouter balance low
  --skip-preflight      skip tests/deploy/diagnostics
  --skip-verify         skip post-bootstrap launch gate
  --no-dashboard        skip auto-starting the dashboard
                        (SKIP_DASHBOARD=1 also works)

Env: RUN_ID, VARIANT, WORKERS, AUTO_REUSE, MATERIALIZE (passed to establish-scenario.sh)
     DASHBOARD_PORT (default 3000), DASHBOARD_WORLD (default proc-lab)
EOF
      exit 0
      ;;
    *) echo "unknown: $1" >&2; exit 1 ;;
  esac
done

PY="${ROOT}/.venv/bin/python3"
[[ -x "$PY" ]] || PY=python3

if [[ "$SKIP_PREFLIGHT" -eq 0 ]]; then
  args=()
  [[ -n "$MIN_CREDITS" ]] && args+=(--min-credits-usd "$MIN_CREDITS")
  bash scripts/establish-preflight.sh "${args[@]}"
fi

if [[ "$ARCHIVE_LOGS" -eq 1 ]]; then
  rid="${RUN_ID:-establish-$(date +%Y%m%d-%H%M%S)}"
  dest="/tmp/hermescraft-pre-$rid"
  if [[ -d /tmp/hermescraft ]]; then
    echo "== archive logs → $dest =="
    mv /tmp/hermescraft "$dest"
  fi
  mkdir -p /tmp/hermescraft
fi

bash scripts/establish-fleet-cleanup.sh

if [[ -n "$FRESH_DISC" ]]; then
  echo "== fresh proc-lab disc seed=$FRESH_DISC =="
  "$PY" scripts/reset-proc-lab.py --seed "$FRESH_DISC"
  export AUTO_REUSE=1
  export MATERIALIZE=0
fi

export FULL_RUNTIME_WIPE="${FULL_RUNTIME_WIPE:-1}"
"$BASH5" scripts/establish-scenario.sh

if [[ "$SKIP_VERIFY" -eq 0 ]]; then
  bash scripts/establish-launch-verify.sh
fi

# Dashboard auto-start (Phase A4.1+). PID + log live under LOG_DIR so the
# cleanup script can stop it without guessing, and so the operator can tail
# the dashboard alongside fleet logs. Skip with --no-dashboard or
# SKIP_DASHBOARD=1 (e.g. when the operator already started it manually).
if [[ "$SKIP_DASHBOARD" -eq 0 ]]; then
  LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
  mkdir -p "$LOG_DIR"
  DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
  DASHBOARD_WORLD="${DASHBOARD_WORLD:-proc-lab}"
  DASH_PID_FILE="$LOG_DIR/dashboard.pid"
  DASH_LOG="$LOG_DIR/dashboard.log"

  # If a dashboard is already running on the target port, leave it alone —
  # an operator may have started it manually and we don't want to fight.
  if curl -sf -m 1 "http://127.0.0.1:$DASHBOARD_PORT/" >/dev/null 2>&1; then
    echo "== dashboard already running on :$DASHBOARD_PORT (skipping auto-start) =="
  else
    echo "== start dashboard (world=$DASHBOARD_WORLD, port=$DASHBOARD_PORT) =="
    # Background; redirect both streams to the log so the dashboard
    # process detaches cleanly from this script's TTY.
    DASHBOARD_PORT="$DASHBOARD_PORT" \
      nohup bash "$ROOT/start-dashboard.sh" --world "$DASHBOARD_WORLD" \
        >"$DASH_LOG" 2>&1 &
    echo "$!" > "$DASH_PID_FILE"
    sleep 1
    if curl -sf -m 2 "http://127.0.0.1:$DASHBOARD_PORT/" >/dev/null 2>&1; then
      echo "  dashboard up: http://127.0.0.1:$DASHBOARD_PORT (pid $(cat "$DASH_PID_FILE"))"
    else
      echo "  WARN: dashboard not responding yet on :$DASHBOARD_PORT — check $DASH_LOG" >&2
    fi
  fi
fi

echo ""
echo "Next: scripts/kanban board"
echo "      scripts/landfolk logs agents --profiles steward,flint,mason -q --tail 20 --no-follow"
if [[ "$SKIP_DASHBOARD" -eq 0 ]]; then
  echo "      open http://127.0.0.1:${DASHBOARD_PORT:-3000}  # dashboard (Ops tab)"
fi
echo "Stop:  scripts/establish-fleet-cleanup.sh   # stops fleet + dashboard"
echo "       scripts/snapshot-fleet-logs.sh data/postmortems/<dir>"

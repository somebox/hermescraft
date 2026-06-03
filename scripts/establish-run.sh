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
FRESH_DISC=""
ARCHIVE_LOGS=0
MIN_CREDITS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-preflight) SKIP_PREFLIGHT=1; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
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

Env: RUN_ID, VARIANT, WORKERS, AUTO_REUSE, MATERIALIZE (passed to establish-scenario.sh)
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

echo ""
echo "Next: scripts/kanban board"
echo "      scripts/landfolk logs agents --profiles steward,flint,mason -q --tail 20 --no-follow"
echo "Stop:  scripts/landfolk stop && scripts/snapshot-fleet-logs.sh data/postmortems/<dir>"

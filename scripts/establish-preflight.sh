#!/usr/bin/env bash
# Hermetic tests, deploy, diagnostics, toolchain, optional OpenRouter balance.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_TESTS=0
SKIP_DEPLOY=0
# Diagnostics need a live gateway + bots; establish-run calls preflight *before* bootstrap.
SKIP_DIAG=1
MIN_CREDITS_USD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests) SKIP_TESTS=1; shift ;;
    --skip-deploy) SKIP_DEPLOY=1; shift ;;
    --skip-diagnostics) SKIP_DIAG=1; shift ;;
    --with-diagnostics) SKIP_DIAG=0; shift ;;
    --min-credits-usd) MIN_CREDITS_USD="${2:-5}"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: establish-preflight.sh [options]

  --skip-tests / --skip-deploy / --skip-diagnostics
  --with-diagnostics   run landfolk diagnostics (advisory; does not fail preflight)
  --min-credits-usd N

Default skips diagnostics (fleet is usually down). Use --with-diagnostics after
bootstrap, or run: scripts/landfolk diagnostics
EOF
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== toolchain =="
BASH_BIN="${BASH:-}"
if [[ -z "$BASH_BIN" ]] || [[ "${BASH_VERSINFO[0]:-0}" -lt 5 ]]; then
  if [[ -x /opt/homebrew/bin/bash ]]; then
    export BASH=/opt/homebrew/bin/bash
    echo "  bash: $("$BASH" --version | head -1)"
  else
    fail "bash 5+ required (brew install bash)"
  fi
else
  echo "  bash: $(bash --version | head -1)"
fi

PY="${ROOT}/.venv/bin/python3"
if [[ ! -x "$PY" ]]; then
  PY="$(command -v python3 || true)"
fi
[[ -n "$PY" ]] || fail "python3 not found"
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || fail "python 3.11+ required ($("$PY" --version))"
echo "  python: $("$PY" --version)"

if [[ -n "$MIN_CREDITS_USD" ]]; then
  echo "== openrouter credits =="
  OPENROUTER_MIN_USD="$MIN_CREDITS_USD" "$PY" - <<'PY'
import json, os, re, sys, urllib.request
from pathlib import Path

min_usd = float(os.environ.get("OPENROUTER_MIN_USD", "0"))
key = os.environ.get("OPENROUTER_API_KEY")
if not key:
    p = Path("secrets.yaml")
    if p.is_file():
        m = re.search(r"^openrouter_api_key:\s*(\S+)", p.read_text(), re.M)
        if m:
            key = m.group(1).strip("\"'")
if not key:
    print("WARN: no OPENROUTER_API_KEY / secrets.yaml — skip credit check")
    sys.exit(0)

req = urllib.request.Request(
    "https://openrouter.ai/api/v1/credits",
    headers={"Authorization": f"Bearer {key}"},
)
with urllib.request.urlopen(req, timeout=15) as resp:
    data = json.loads(resp.read().decode())
d = data.get("data") or {}
total = float(d.get("total_credits") or 0)
usage = float(d.get("total_usage") or 0)
remaining = total - usage
print(f"  credits remaining ~${remaining:.2f} (total={total:.2f} usage={usage:.2f})")
if remaining < min_usd:
    sys.exit(f"remaining ${remaining:.2f} < --min-credits-usd {min_usd}")
PY
fi

if [[ "$SKIP_TESTS" -eq 0 ]]; then
  echo "== hermetic tests (bot) =="
  (cd bot && HERMES_VALIDATE=1 npm test -- \
    test/runtime/nav-brief-render.test.js \
    test/cli/output.test.js \
    test/runtime/observation-status-shape.test.js \
    test/actions/goto-near-timeout-contract.test.js \
    test/scene-canopy-window.test.js \
    test/server/orchestrator-mc-gate.test.js \
    test/server/orchestrator-mc-gate-http.test.js)

  echo "== hermetic tests (python) =="
  "$PY" -m unittest \
    scripts.tests.test_auto_stuck_check \
    scripts.tests.test_watchdog_progress_emit \
    scripts.tests.test_watchdog_progress_e2e \
    scripts.tests.test_wb_stash_side_effect \
    scripts.tests.test_orchestrator_allowlist_sync \
    scripts.tests.test_kanban_worker_wb_context \
    scripts.tests.test_card_body_linter \
    scripts.tests.test_kanban_retry_policy \
    scripts.tests.test_establish_rcon_prep \
    scripts.tests.test_reset_proc_lab \
    scripts.tests.test_patch_landfolk_compression_config

  bash scripts/tests/test_orchestrator_deny_hook.sh
  bash scripts/tests/test_worker_kanban_deny_hook.sh
fi

if [[ "$SKIP_DEPLOY" -eq 0 ]]; then
  echo "== landfolk deploy =="
  scripts/landfolk deploy
fi

if [[ "$SKIP_DIAG" -eq 0 ]]; then
  echo "== landfolk diagnostics (advisory) =="
  if scripts/landfolk diagnostics; then
    echo "  diagnostics: ok (0 failures)"
  else
    ec=$?
    echo "WARN: landfolk diagnostics exit=$ec (expected if gateway/bots are not up yet)" >&2
  fi
fi

echo "== establish preflight OK =="

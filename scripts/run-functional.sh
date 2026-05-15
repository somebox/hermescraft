#!/usr/bin/env bash
# Run all functional (live-MC, no-LLM) tests under scripts/test-*.py.
#
# Each test resolves its bot URL via scripts/_test_lib.default_bot_url(),
# which reads config/hermescraft.yaml (or honors $HERMESCRAFT_BOT_URL).
# By default this is Flint at localhost:3001; tests that need Tester at
# localhost:3004 declare that via default_bot_url("tester").
#
# Usage:
#   scripts/run-functional.sh                       # run all
#   scripts/run-functional.sh --filter mine         # only tests with "mine" in name
#   scripts/run-functional.sh --exclude door        # skip tests with "door"
#   scripts/run-functional.sh --role flint          # only tests that use Flint
#   scripts/run-functional.sh --bail                # stop on first failure
#
# Override the resolved URL (e.g. test against a remote bot) by exporting
# HERMESCRAFT_BOT_URL before invoking — the helper picks it up.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FILTER=""
EXCLUDE=""
ROLE=""
BAIL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --filter) FILTER="$2"; shift 2 ;;
    --exclude) EXCLUDE="$2"; shift 2 ;;
    --role) ROLE="$2"; shift 2 ;;
    --bail) BAIL=1; shift ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# //;s/^#//'
      exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Pre-flight: bot reachable?
DEFAULT_URL=$(python3 -c "
import sys
sys.path.insert(0, 'scripts')
from _test_lib import default_bot_url
print(default_bot_url('${ROLE:-flint}'))
" 2>/dev/null || echo "http://localhost:3001")

echo "──────────────────────────────────────────────────────────"
echo "Functional test runner"
echo "  default URL : $DEFAULT_URL"
[[ -n "$FILTER" ]]  && echo "  filter      : *$FILTER*"
[[ -n "$EXCLUDE" ]] && echo "  exclude     : *$EXCLUDE*"
[[ -n "$ROLE" ]]    && echo "  role        : $ROLE"
[[ "$BAIL" == "1" ]] && echo "  bail        : on first failure"
echo "──────────────────────────────────────────────────────────"

if ! curl -sS -m 3 "$DEFAULT_URL/health" > /dev/null 2>&1; then
  echo "ERROR: bot not reachable at $DEFAULT_URL" >&2
  echo "  Start the bot first (e.g. ./hermescraft.sh --bot-only) or set HERMESCRAFT_BOT_URL." >&2
  exit 2
fi

# Collect test files
mapfile -t ALL_TESTS < <(ls scripts/test-*.py 2>/dev/null | sort)

# Filter
TESTS=()
for f in "${ALL_TESTS[@]}"; do
  base="$(basename "$f")"
  [[ -n "$FILTER" ]]  && [[ "$base" != *"$FILTER"*  ]] && continue
  [[ -n "$EXCLUDE" ]] && [[ "$base" == *"$EXCLUDE"* ]] && continue
  if [[ -n "$ROLE" ]]; then
    # Skip tests whose default_bot_url() role doesn't match the requested role
    file_role=$(grep -oE 'default_bot_url\("[a-z]+"\)' "$f" | head -1 | grep -oE '"[a-z]+"' | tr -d '"')
    [[ "${file_role:-flint}" != "$ROLE" ]] && continue
  fi
  TESTS+=("$f")
done

if [[ ${#TESTS[@]} -eq 0 ]]; then
  echo "(no tests matched filters)"; exit 0
fi

# Per-run log dir under the configured LOG_DIR
LOG_DIR_BASE=$(python3 -c "
import sys; sys.path.insert(0, 'scripts')
try:
    from _test_lib import _cfg
    print((_cfg().get('logging') or {}).get('dir') or '/tmp/hermescraft')
except Exception:
    print('/tmp/hermescraft')
")
RUN_ID=$(date -u +%Y-%m-%dT%H-%M-%S)
LOG_DIR="$LOG_DIR_BASE/functional/$RUN_ID"
mkdir -p "$LOG_DIR"
echo "Logs: $LOG_DIR"
echo

PASS=0
FAIL=0
ERR=0
declare -a FAILED=()
declare -a ERRORED=()

START_ALL=$(date +%s)
for f in "${TESTS[@]}"; do
  base="$(basename "$f" .py)"
  log="$LOG_DIR/$base.log"
  printf "  %-50s ... " "$base"
  start=$(date +%s)
  if python3 "$f" > "$log" 2>&1; then
    rc=0
  else
    rc=$?
  fi
  elapsed=$(($(date +%s) - start))

  case "$rc" in
    0) PASS=$((PASS+1)); printf "\033[32mPASS\033[0m (%ds)\n" "$elapsed" ;;
    1) FAIL=$((FAIL+1)); FAILED+=("$base"); printf "\033[31mFAIL\033[0m (%ds)  → %s\n" "$elapsed" "$log" ;;
    2) ERR=$((ERR+1));  ERRORED+=("$base"); printf "\033[33mSKIP/SETUP\033[0m (%ds)  → %s\n" "$elapsed" "$log" ;;
    *) FAIL=$((FAIL+1)); FAILED+=("$base"); printf "\033[31mFAIL rc=%d\033[0m (%ds)  → %s\n" "$rc" "$elapsed" "$log" ;;
  esac

  if [[ "$BAIL" == "1" && "$rc" != "0" && "$rc" != "2" ]]; then
    echo
    echo "Bailing after first failure (--bail)."
    break
  fi
done
TOTAL_ELAPSED=$(($(date +%s) - START_ALL))

echo
echo "──────────────────────────────────────────────────────────"
echo "Summary: PASS=$PASS  FAIL=$FAIL  SKIP/SETUP=$ERR  total=${TOTAL_ELAPSED}s"
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "Failed tests:"
  for n in "${FAILED[@]}"; do echo "  ✗ $n"; done
fi
if [[ ${#ERRORED[@]} -gt 0 ]]; then
  echo "Setup-errored / skipped:"
  for n in "${ERRORED[@]}"; do echo "  ⚠ $n"; done
fi
echo "Logs: $LOG_DIR"

[[ $FAIL -gt 0 ]] && exit 1 || exit 0

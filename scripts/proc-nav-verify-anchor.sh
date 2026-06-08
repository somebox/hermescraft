#!/usr/bin/env bash
# End-to-end verifier for promoted anchor helper scripts.
#
# Two modes:
#   --shape (default) — execute the candidate, parse the first xyz triple from
#       stdout, compare against the `overlook` anchor in the live fixture.
#       Cheap, but coord-match-only: a script that prints the right numbers via
#       any fallback (incl. stale canonical.yaml) passes.
#   --runtime-test  — execute the candidate against an isolated, frozen golden
#       fixture for EACH supported anchor (overlook, return_post, muster). Also
#       runs once with no MC_API_URL set to confirm the script doesn't error
#       on bot-unreachable. Asserts JSON-shape output {anchor, coords, near?}
#       when the script supports `--anchor`. Catches the W2 trial-3 class of
#       bugs (script ran, returned right shape, but read from the wrong source).
#
# Usage:
#   proc-nav-verify-anchor.sh [--runtime-test] [--fixture PATH] <script>
#
# Env:
#   PROC_NAV_ANCHOR_FIXTURE — override fixture path
#   PROC_NAV_GOLDEN_FIXTURE — override golden fixture for runtime-test
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="shape"
FIXTURE="${PROC_NAV_ANCHOR_FIXTURE:-data/runtime/last-scenario-map.json}"
GOLDEN_FIXTURE="${PROC_NAV_GOLDEN_FIXTURE:-data/workspace/production/data/proc_nav_golden_fixture.json}"
SCRIPT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-test) MODE="runtime"; shift ;;
    --shape)        MODE="shape"; shift ;;
    --fixture)      FIXTURE="$2"; shift 2 ;;
    --golden)       GOLDEN_FIXTURE="$2"; shift 2 ;;
    -h|--help)      sed -n '2,25p' "$0"; exit 0 ;;
    *)              SCRIPT_PATH="$1"; shift ;;
  esac
done

if [[ -z "$SCRIPT_PATH" || ! -f "$SCRIPT_PATH" ]]; then
  echo "usage: proc-nav-verify-anchor.sh [--runtime-test] [--fixture PATH] <script>" >&2
  exit 2
fi

log() { printf '[verify-anchor] %s\n' "$*" >&2; }

# ── Shape mode (legacy, fast) ──────────────────────────────────────────
if [[ "$MODE" == "shape" ]]; then
  if [[ ! -f "$FIXTURE" ]]; then
    echo "missing fixture $FIXTURE" >&2; exit 1
  fi
  golden="$(python3 -c "
import json, sys
card = json.load(open(sys.argv[1]))
p = (card.get('placements') or {}).get('overlook') or card.get('overlook')
if not p: sys.exit(3)
print(int(p[0]), int(p[1]), int(p[2]))
" "$FIXTURE")" || { echo "no overlook anchor in $FIXTURE" >&2; exit 1; }

  out="$(bash "$SCRIPT_PATH" 2>/dev/null || true)"
  parsed="$(printf '%s' "$out" | python3 -c "
import re, sys
text = sys.stdin.read()
m = re.search(r'(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)', text)
if not m: sys.exit(4)
print(m.group(1), m.group(2), m.group(3))
" 2>/dev/null)" || true

  if [[ -z "$parsed" ]]; then
    echo "FAIL: script output had no parseable xyz triple" >&2; exit 1
  fi
  if [[ "$parsed" == "$golden" ]]; then
    echo "OK anchor coords match golden overlook: $golden"
    exit 0
  fi
  echo "FAIL parsed=$parsed golden=$golden" >&2
  exit 1
fi

# ── Runtime mode (the W2 trial-3 lesson fix) ───────────────────────────
# Frozen golden — committed alongside the verifier so the artifact under
# test cannot drift the source of truth from under us. If the file doesn't
# exist yet, write the minimal known-good fixture below.
if [[ ! -f "$GOLDEN_FIXTURE" ]]; then
  log "writing default golden fixture at $GOLDEN_FIXTURE"
  mkdir -p "$(dirname "$GOLDEN_FIXTURE")"
  cat > "$GOLDEN_FIXTURE" <<'JSON'
{
  "_comment": "Golden fixture for proc-nav-verify-anchor.sh --runtime-test. Frozen. Do not edit casually — the verifier asserts against these exact coords.",
  "seed": 0,
  "placements": {
    "spawn":       [0, 65, 0],
    "muster":      [6, 65, 0],
    "overlook":    [12, 70, 8],
    "return_post": [-4, 65, -4]
  }
}
JSON
fi

GOLDEN_JSON="$(cat "$GOLDEN_FIXTURE")"
fail=0
pass=0

# Helper: extract expected coords for an anchor from the golden fixture.
expected_for() {
  python3 -c "
import json, sys
g = json.loads(sys.argv[1])['placements'][sys.argv[2]]
print(int(g[0]), int(g[1]), int(g[2]))
" "$GOLDEN_JSON" "$1"
}

# Helper: extract observed coords from script stdout — prefer JSON
# {anchor, coords:{x,y,z}} shape, fall back to first xyz regex match.
observe_coords() {
  python3 -c "
import json, re, sys
text = sys.stdin.read()
# Try JSON first.
for line in reversed(text.strip().splitlines()):
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    try:
        obj = json.loads(line)
    except ValueError:
        continue
    coords = obj.get('coords') or obj.get('plot') or {}
    if all(k in coords for k in ('x','y','z')):
        print(int(coords['x']), int(coords['y']), int(coords['z']))
        sys.exit(0)
# Fall back: first regex triple.
m = re.search(r'(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)', text)
if not m: sys.exit(4)
print(m.group(1), m.group(2), m.group(3))
"
}

run_anchor() {
  local anchor="$1"
  local expected
  expected="$(expected_for "$anchor")"
  # Run with the golden fixture as canonical source. We point
  # PROC_NAV_ANCHOR_FIXTURE at the golden so any "last-scenario-map.json"
  # fallback inside the candidate script reads the same data we measure
  # against — bug repro path from W2 trial 3.
  local out rc obs
  out="$(env -u MC_API_URL -u MC_USERNAME \
    HERMESCRAFT_REPO="$REPO_ROOT" \
    PROC_NAV_ANCHOR_FIXTURE="$GOLDEN_FIXTURE" \
    ANCHOR="$anchor" \
    bash "$SCRIPT_PATH" --anchor "$anchor" 2>/dev/null)"
  rc=$?
  # Some scripts don't yet take --anchor; retry positional.
  if [[ $rc -ne 0 || -z "$out" ]]; then
    out="$(env -u MC_API_URL -u MC_USERNAME \
      HERMESCRAFT_REPO="$REPO_ROOT" \
      PROC_NAV_ANCHOR_FIXTURE="$GOLDEN_FIXTURE" \
      ANCHOR="$anchor" \
      bash "$SCRIPT_PATH" "$anchor" 2>/dev/null)"
    rc=$?
  fi
  if [[ $rc -ne 0 ]]; then
    echo "FAIL [$anchor] exit $rc" >&2
    fail=$((fail + 1)); return
  fi
  obs="$(printf '%s' "$out" | observe_coords 2>/dev/null)" || obs=""
  if [[ -z "$obs" ]]; then
    echo "FAIL [$anchor] no parseable output: $(printf '%s' "$out" | head -c 200)" >&2
    fail=$((fail + 1)); return
  fi
  if [[ "$obs" == "$expected" ]]; then
    log "PASS [$anchor] $obs"
    pass=$((pass + 1))
  else
    echo "FAIL [$anchor] observed=$obs expected=$expected" >&2
    fail=$((fail + 1))
  fi
}

# Smoke: bot-unreachable (no MC_API_URL). Script must not crash; it may
# fall back to the fixture. We accept any exit code, just no SIGABRT/etc.
no_bot_smoke() {
  env -u MC_API_URL -u MC_USERNAME \
    HERMESCRAFT_REPO="$REPO_ROOT" \
    PROC_NAV_ANCHOR_FIXTURE="$GOLDEN_FIXTURE" \
    bash "$SCRIPT_PATH" --anchor overlook >/dev/null 2>&1
  rc=$?
  # Accept 0 (worked off fixture) or 1 (graceful failure). Reject >1.
  if [[ $rc -gt 1 ]]; then
    echo "FAIL [no-bot smoke] script exit $rc (expected 0 or 1)" >&2
    fail=$((fail + 1))
  else
    log "PASS [no-bot smoke] rc=$rc"
    pass=$((pass + 1))
  fi
}

log "runtime-test mode: golden=$GOLDEN_FIXTURE"
no_bot_smoke
for anchor in overlook return_post muster; do
  run_anchor "$anchor"
done

if [[ $fail -eq 0 ]]; then
  echo "OK runtime-test: $pass/$((pass + fail)) anchors + smoke passed"
  exit 0
fi
echo "FAIL runtime-test: $fail failed, $pass passed" >&2
exit 1

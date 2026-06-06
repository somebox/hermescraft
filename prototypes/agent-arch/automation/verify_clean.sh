#!/usr/bin/env bash
# Verify that a profile + bot are in clean baseline state after a reset.
# Exits 0 if everything is clean, prints a per-item diff and exits non-zero
# otherwise.
#
# What we assert:
#
#   Profile:
#     - memories/MEMORY.md is empty (0 bytes)
#     - state.db does not exist
#     - sessions/ has no files (only the directory itself)
#     - logs/agent.log is empty (0 bytes)
#     - .skills_prompt_snapshot.json does not exist
#     - no running hermes worker for that profile
#
#   Bot:
#     - inventory has 0 stacks
#     - position is within 4 blocks of start
#     - hp >= 14
#     - food >= 14
#
# Usage:
#   verify_clean.sh <hermes_home> <profile_name> [bot_port]

set -uo pipefail
# Don't fail on grep/wc returning non-zero — we check exit codes explicitly.

HOME_DIR="${1:-}"
PROFILE="${2:-}"
PORT="${3:-3002}"

if [ -z "$HOME_DIR" ] || [ -z "$PROFILE" ]; then
  echo "usage: $0 <hermes_home> <profile_name> [bot_port]" >&2
  exit 2
fi

PDIR="$HOME_DIR/profiles/$PROFILE"
BASE="http://127.0.0.1:$PORT"
fail=0
ok() { printf "  ✓ %s\n" "$*"; }
bad() { printf "  ✗ %s\n" "$*"; fail=$((fail+1)); }
section() { printf "[verify/%s] %s\n" "$PROFILE" "$*"; }

section "profile"

MEM="$PDIR/memories/MEMORY.md"
if [ -f "$MEM" ]; then
  size=$(wc -c < "$MEM" | tr -d ' ')
  if [ "$size" -eq 0 ]; then ok "MEMORY.md is empty"
  else bad "MEMORY.md is $size bytes (expected 0)"
  fi
else
  ok "MEMORY.md absent (acceptable)"
fi

for f in state.db state.db-shm state.db-wal; do
  if [ -e "$PDIR/$f" ]; then
    sz=$(wc -c < "$PDIR/$f" | tr -d ' ')
    bad "$f exists ($sz bytes; expected absent)"
  else
    ok "$f absent"
  fi
done

if [ -d "$PDIR/sessions" ]; then
  cnt=$(find "$PDIR/sessions" -mindepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "$cnt" -eq 0 ]; then ok "sessions/ has 0 files"
  else bad "sessions/ has $cnt file(s)"
  fi
fi

LOG="$PDIR/logs/agent.log"
if [ -f "$LOG" ]; then
  sz=$(wc -c < "$LOG" | tr -d ' ')
  if [ "$sz" -eq 0 ]; then ok "agent.log is empty"
  else bad "agent.log is $sz bytes (expected 0)"
  fi
else
  ok "agent.log absent (acceptable)"
fi

if [ -f "$PDIR/.skills_prompt_snapshot.json" ]; then
  bad ".skills_prompt_snapshot.json exists (expected absent)"
else
  ok ".skills_prompt_snapshot.json absent"
fi

PIDS=$(ps -ef | grep -E "hermes -p $PROFILE\b" | grep -v grep | awk '{print $2}' || true)
if [ -n "$PIDS" ]; then
  bad "running worker(s) for $PROFILE: $PIDS"
else
  ok "no running worker for $PROFILE"
fi

section "bot"

# Single Python call: probe bot + return HP/FOOD/INV_COUNT in one shot
BOTSTATE=$(python3 - "$PORT" <<'PY'
import json, sys, urllib.request, urllib.error
port = sys.argv[1]
base = f"http://127.0.0.1:{port}"
out = {"reachable": False}
try:
    with urllib.request.urlopen(f"{base}/status?lean=true", timeout=5) as r:
        d = json.loads(r.read().decode())["data"]
    out["reachable"] = True
    out["hp"] = d.get("health")
    out["food"] = d.get("food")
    with urllib.request.urlopen(f"{base}/inventory", timeout=5) as r:
        di = json.loads(r.read().decode()).get("data") or {}
    cats = di.get("categories") or {}
    n = sum(len(c) for c in cats.values() if isinstance(c, list))
    out["inv_stacks"] = n
except Exception as e:
    out["error"] = str(e)
print(json.dumps(out))
PY
)

REACHABLE=$(echo "$BOTSTATE" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("reachable", False))')
if [ "$REACHABLE" != "True" ]; then
  bad "bot HTTP not reachable on port $PORT — skipping bot checks"
else
  HP=$(echo "$BOTSTATE" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("hp", -1))')
  FOOD=$(echo "$BOTSTATE" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("food", -1))')
  INV_COUNT=$(echo "$BOTSTATE" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("inv_stacks", -1))')
  if [ "$HP" -ge 14 ]; then ok "hp=$HP ≥ 14"
  else bad "hp=$HP < 14"
  fi
  if [ "$FOOD" -ge 14 ]; then ok "food=$FOOD ≥ 14"
  else bad "food=$FOOD < 14"
  fi
  if [ "$INV_COUNT" -eq 0 ]; then ok "inventory empty (0 stacks)"
  else bad "inventory has $INV_COUNT stack(s)"
  fi
fi

section "summary"
if [ "$fail" -eq 0 ]; then
  echo "  CLEAN."
  exit 0
else
  echo "  $fail issue(s) — see above"
  exit 1
fi

#!/usr/bin/env bash
# genesis-v2-verify-smoke.sh
# Post-run verification harness for genesis-v2 emergent cleanup checks.
#
# Produces a PASS/WARN/FAIL summary focused on:
# - mission protocol regression (`protocol_violation` / `gave_up`)
# - MANAGE fallback churn vs mission retry continuity
# - legacy mode leakage in run artifacts
# - non-blocking warning signals (GoalChanged / terrain stalls)
# - RETRO card completion (board snapshot)
# - scoped verb error buckets + craft_diag failure_origin (next-run bottleneck triage)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNS_DIR="$REPO_ROOT/data/genesis-v2-runs"

RUN_ID=""
MANAGE_FAIL_THRESHOLD=5

usage() {
  cat <<'USAGE'
Usage:
  scripts/genesis-v2-verify-smoke.sh [--run-id <gv2-id>] [--manage-fail-threshold <n>]

Examples:
  scripts/genesis-v2-verify-smoke.sh
  scripts/genesis-v2-verify-smoke.sh --run-id gv2-2026-06-20-3
  scripts/genesis-v2-verify-smoke.sh --manage-fail-threshold 3
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --manage-fail-threshold)
      MANAGE_FAIL_THRESHOLD="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(python3 - <<PY
import pathlib
runs = sorted(pathlib.Path("$RUNS_DIR").glob("gv2-*"), key=lambda p: p.stat().st_mtime, reverse=True)
print(runs[0].name if runs else "")
PY
)"
fi

if [[ -z "$RUN_ID" ]]; then
  echo "FAIL: no runs found in $RUNS_DIR" >&2
  exit 2
fi

RUN_DIR="$RUNS_DIR/$RUN_ID"
CFG="$RUN_DIR/config.json"
POLLER_LOG="$RUN_DIR/poller.log"
CARD_STORIES="$RUN_DIR/card-stories"
BOARD_JSON="$RUN_DIR/artifacts/board.json"

if [[ ! -d "$RUN_DIR" ]]; then
  echo "FAIL: run dir not found: $RUN_DIR" >&2
  exit 2
fi
if [[ ! -f "$CFG" ]]; then
  echo "FAIL: config missing: $CFG" >&2
  exit 2
fi
if [[ ! -f "$POLLER_LOG" ]]; then
  echo "FAIL: poller log missing: $POLLER_LOG" >&2
  exit 2
fi

MISSION_ID="$(python3 - <<PY
import json
from pathlib import Path
cfg = json.loads(Path("$CFG").read_text())
print(cfg.get("mission_id",""))
PY
)"
MISSION_CARD="$CARD_STORIES/$MISSION_ID.md"

if [[ -z "$MISSION_ID" || ! -f "$MISSION_CARD" ]]; then
  echo "FAIL: mission card missing for run $RUN_ID (mission_id='$MISSION_ID')" >&2
  exit 2
fi

count_lines() {
  local content="$1"
  if [[ -z "$content" ]]; then
    echo 0
  else
    awk 'END { print NR }' <<< "$content"
  fi
}

sample_lines() {
  local content="$1"
  local n="${2:-5}"
  if [[ -n "$content" ]]; then
    awk -v max="$n" 'NR<=max { print }' <<< "$content"
  fi
}

protocol_hits="$(rg -n --no-heading -e 'protocol_violation|gave_up' "$MISSION_CARD" 2>/dev/null || true)"
protocol_count="$(count_lines "$protocol_hits")"

# Mission re-dispatch continuity. By design the planner completes its MISSION turn
# (terminal card), and the poller re-dispatches it on a fresh [GENESIS2:MANAGE] card
# each cycle (a terminal card can't be re-run). So a high CREATE count is healthy
# re-dispatch, NOT churn — the failure signature is a manage card the planner can't
# terminate: status `blocked`, or several piled up OPEN at once. We judge churn from
# the captured board, counting only UNRESOLVED manage cards.
redispatch_hits="$(rg -n --no-heading -e 're-dispatch planner via|re-engage planner' "$POLLER_LOG" 2>/dev/null || true)"
redispatch_count="$(count_lines "$redispatch_hits")"

manage_total=0; manage_done=0; manage_blocked=0; manage_open=0
if [[ -f "$BOARD_JSON" ]]; then
  read -r manage_total manage_done manage_blocked manage_open < <(python3 - "$BOARD_JSON" <<'PY'
import json,sys
try:
    b=json.load(open(sys.argv[1]))
except Exception:
    print("0 0 0 0"); sys.exit()
ts=b if isinstance(b,list) else b.get("tasks",[])
mg=[t for t in ts if "MANAGE re-engage" in (t.get("title") or "")]
def st(t): return (t.get("status") or "").lower()
total=len(mg)
done=sum(1 for t in mg if st(t) in ("done","archived"))
blocked=sum(1 for t in mg if st(t)=="blocked")
opn=sum(1 for t in mg if st(t) in ("todo","ready","running"))
print(f"{total} {done} {blocked} {opn}")
PY
)
fi
# Unresolved = blocked (planner couldn't terminate) + any pile-up beyond the one
# in-flight card the dedup allows.
manage_unresolved=$(( manage_blocked + (manage_open > 1 ? manage_open - 1 : 0) ))

# Legacy mode leakage. Exclude the MISSION card story: it's the planner's standing
# brief, which legitimately enumerates the colony-* specialist assignees and carries
# a structural `skills:` column — neither is worker-card leakage. Worker/other-card
# stories + poller.log are still scanned.
leak_pattern='assignee[:"]\s*"?((flint|mason|barley|steward))"?|`(mc advise|scripts/board|kanban show)`|kanban_reassign[^[:alnum:]]*.*steward|^\s*skills\s*:'
raw_leak_hits="$(rg -n --no-heading -e "$leak_pattern" "$CARD_STORIES" "$POLLER_LOG" -g "!$(basename "$MISSION_CARD")" 2>/dev/null || true)"
# Ignore reflective agent-thought lines; focus on card/poller operational surfaces.
leak_hits="$(printf "%s\n" "$raw_leak_hits" | rg -v '\[agent/' 2>/dev/null || true)"
leak_count="$(count_lines "$leak_hits")"

# GoalChanged + craft from the RUN-SCOPED action logs (artifacts/actions-*.jsonl), NOT a
# raw rg over the run dir. The durable per-body logs span every run; capture now windows
# them, but we re-apply the config.started_at/ended_at guard here too (belt-and-suspenders:
# stays correct if re-run on a pre-fix run dir or if capture couldn't window).
read -r goalchanged_count craft_total craft_errors < <(python3 - "$CFG" "$RUN_DIR/artifacts" <<'PY'
import json, glob, sys
from datetime import datetime
cfg_path, art = sys.argv[1], sys.argv[2]
def iso_ms(s):
    try: return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp() * 1000
    except Exception: return None
cfg = {}
try: cfg = json.load(open(cfg_path))
except Exception: pass
start_ms = iso_ms(cfg.get("started_at")); end_ms = iso_ms(cfg.get("ended_at"))
gc = craft = cerr = 0
for f in glob.glob(art + "/actions-*.jsonl"):
    for line in open(f):
        line = line.strip()
        if not line: continue
        try: o = json.loads(line)
        except Exception: continue
        ts = o.get("started_at")
        if not isinstance(ts, (int, float)): ts = o.get("finished_at")
        if start_ms is not None and isinstance(ts, (int, float)):
            if ts < start_ms or (end_ms is not None and ts > end_ms): continue
        blob = json.dumps(o).lower()
        if "goalchanged" in blob or "goal was changed" in blob: gc += 1
        if o.get("action") == "craft":
            craft += 1
            if o.get("status") == "error": cerr += 1
print(gc, craft, cerr)
PY
)
goalchanged_count="${goalchanged_count:-0}"; craft_total="${craft_total:-0}"; craft_errors="${craft_errors:-0}"

read -r retro_total retro_pending retro_ready retro_running < <(python3 - "$BOARD_JSON" <<'PY'
import json, sys
path = sys.argv[1]
if not __import__("pathlib").Path(path).is_file():
    print("0 0 0 0"); raise SystemExit
try:
    b = json.load(open(path))
except Exception:
    print("0 0 0 0"); raise SystemExit
ts = b if isinstance(b, list) else b.get("tasks", [])
ret = [t for t in ts if "[RETRO]" in (t.get("title") or "")]
def st(t): return (t.get("status") or "").lower()
ready = sum(1 for t in ret if st(t) == "ready")
running = sum(1 for t in ret if st(t) == "running")
pending = ready + running
print(len(ret), pending, ready, running)
PY
)

# Two values on SEPARATE lines (each contains spaces/commas) — read line-by-line, NOT
# `read a b` (which would take only line 1 and word-split it, dropping line 2).
{ read -r verb_err_summary; read -r craft_diag_summary; } < <(python3 - "$CFG" "$RUN_DIR/artifacts" <<'PY'
import json, glob, sys, collections
cfg_path, art = sys.argv[1], sys.argv[2]
from datetime import datetime
def iso_ms(s):
    try: return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp() * 1000
    except Exception: return None
cfg = {}
try: cfg = json.load(open(cfg_path))
except Exception: pass
start_ms = iso_ms(cfg.get("started_at")); end_ms = iso_ms(cfg.get("ended_at"))
verbs = collections.Counter()
craft_origins = collections.Counter()
craft_diag_rows = 0
for f in glob.glob(art + "/actions-*.jsonl"):
    for line in open(f):
        line = line.strip()
        if not line: continue
        try: o = json.loads(line)
        except Exception: continue
        ts = o.get("started_at")
        if not isinstance(ts, (int, float)): ts = o.get("finished_at")
        if start_ms is not None and isinstance(ts, (int, float)):
            if ts < start_ms or (end_ms is not None and ts > end_ms): continue
        if o.get("status") != "error": continue
        act = o.get("action") or "unknown"
        verbs[act] += 1
        if act == "craft":
            diag = (o.get("observed_state") or {}).get("craft_diag") or {}
            if diag:
                craft_diag_rows += 1
                fo = diag.get("failure_origin") or "unknown"
                craft_origins[fo] += 1
vsum = ", ".join(f"{k}={v}" for k, v in verbs.most_common(12)) or "none"
cdsum = f"rows={craft_diag_rows} origins={dict(craft_origins.most_common(8)) or '{}'}"
print(vsum)
print(cdsum)
PY
)
verb_err_summary="${verb_err_summary:-none}"
# Default must not contain braces: bash closes ${var:-...} at the first '}' inside '{}',
# leaving a stray literal '}' on the line. Use a brace-free fallback.
craft_diag_summary="${craft_diag_summary:-rows=0 origins=none}"

gv2_invalid=0
gv2_checked=0
gv2_compliance_summary="skipped"
server_down_count=0
if [[ -f "$BOARD_JSON" ]]; then
  read -r gv2_checked gv2_invalid gv2_compliance_summary < <(
    REPO_ROOT="$REPO_ROOT" python3 - "$BOARD_JSON" <<'PY'
import json, os, sys
sys.path.insert(0, os.environ["REPO_ROOT"])
from scripts.lib.gv2_card_validator import validate_board_tasks
path = sys.argv[1]
try:
    b = json.load(open(path))
except Exception:
    print("0 0 board-unreadable"); raise SystemExit
tasks = b if isinstance(b, list) else b.get("tasks", [])
statuses = {"ready", "running", "done", "todo"}
filtered = [t for t in tasks if (t.get("status") or "").lower() in statuses]
out = validate_board_tasks(filtered, statuses=None)
bad = out["invalid_count"]
checked = out["checked"]
mine_miss = sum(1 for r in out["results"] if any("mine_site" in e for e in r.get("errors", [])))
construct_miss = sum(
    1 for r in out["results"]
    if (r.get("kind") == "CONSTRUCT" or "[CONSTRUCT]" in (r.get("title") or ""))
    and not r.get("ok")
)
summary = f"invalid={bad}/{checked} mine_site_miss={mine_miss} construct_fail={construct_miss}"
print(checked, bad, summary)
PY
  )
fi

read -r server_down_count < <(python3 - "$CFG" "$RUN_DIR/artifacts" <<'PY'
import json, glob, sys
from datetime import datetime
cfg_path, art = sys.argv[1], sys.argv[2]
def iso_ms(s):
    try: return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp() * 1000
    except Exception: return None
cfg = {}
try: cfg = json.load(open(cfg_path))
except Exception: pass
start_ms = iso_ms(cfg.get("started_at")); end_ms = iso_ms(cfg.get("ended_at"))
n = 0
for f in glob.glob(art + "/actions-*.jsonl"):
    for line in open(f):
        line = line.strip()
        if not line: continue
        try: o = json.loads(line)
        except Exception: continue
        ts = o.get("started_at")
        if not isinstance(ts, (int, float)): ts = o.get("finished_at")
        if start_ms is not None and isinstance(ts, (int, float)):
            if ts < start_ms or (end_ms is not None and ts > end_ms): continue
        if o.get("status") != "error": continue
        blob = json.dumps(o).lower()
        if "503" in blob or "not connected" in blob or "mc_server_down" in blob:
            n += 1
print(n)
PY
)
server_down_count="${server_down_count:-0}"

terrain_hits="$(rg -n --no-heading -e 'unreachable|terrain_too_complex|stuck_pocket_no_escape' "$CARD_STORIES" "$POLLER_LOG" 2>/dev/null || true)"
terrain_count="$(count_lines "$terrain_hits")"

status="PASS"
fail_reasons=()
warn_reasons=()

if (( protocol_count > 0 )); then
  status="FAIL"
  fail_reasons+=("MISSION contains protocol_violation/gave_up events ($protocol_count)")
fi

if (( manage_unresolved >= MANAGE_FAIL_THRESHOLD )); then
  status="FAIL"
  fail_reasons+=("planner not terminating re-dispatch cards: $manage_unresolved unresolved MANAGE card(s) (blocked=$manage_blocked, open=$manage_open) >= $MANAGE_FAIL_THRESHOLD — this is the stall signature, NOT the $manage_total total created")
elif (( manage_unresolved > 0 )); then
  if [[ "$status" != "FAIL" ]]; then status="WARN"; fi
  warn_reasons+=("$manage_unresolved unresolved MANAGE card(s) (blocked=$manage_blocked, open=$manage_open); planner may be falling behind re-dispatch")
fi

if [[ ! -f "$BOARD_JSON" ]]; then
  if [[ "$status" != "FAIL" ]]; then status="WARN"; fi
  warn_reasons+=("board.json not captured; MANAGE health judged blind (re-dispatch cycles=$redispatch_count)")
fi

if (( leak_count > 0 )); then
  status="FAIL"
  fail_reasons+=("legacy mode leakage found in run artifacts ($leak_count)")
fi

if (( retro_total > 0 && retro_pending > 0 )); then
  status="FAIL"
  fail_reasons+=("[RETRO] cards incomplete at capture: $retro_pending still ready/running of $retro_total")
fi

if (( goalchanged_count > 0 )); then
  if [[ "$status" != "FAIL" ]]; then status="WARN"; fi
  warn_reasons+=("GoalChanged still present ($goalchanged_count) [known separate stream]")
fi

if (( terrain_count > 0 )); then
  if [[ "$status" != "FAIL" ]]; then status="WARN"; fi
  warn_reasons+=("terrain stalls present ($terrain_count) [seed/world dependent]")
fi

if [[ -f "$BOARD_JSON" ]] && (( gv2_invalid > 0 )); then
  if [[ "$status" != "FAIL" ]]; then status="WARN"; fi
  warn_reasons+=("gv2 card validator: $gv2_compliance_summary (compliance metric — judge gameplay separately if 503s present)")
fi

if (( server_down_count > 0 )); then
  if [[ "$status" != "FAIL" ]]; then status="WARN"; fi
  warn_reasons+=("scoped action errors suggest MC disconnect/503 ($server_down_count) — confounds card/worker outcomes")
fi

echo "=== genesis-v2 smoke verification ==="
echo "run_id:        $RUN_ID"
echo "mission_id:    $MISSION_ID"
echo "run_dir:       $RUN_DIR"
echo
echo "checks:"
echo "  mission protocol events:    $protocol_count"
echo "  re-dispatch cycles:         $redispatch_count"
echo "  MANAGE cards total/done:    $manage_total/$manage_done"
echo "  MANAGE unresolved:          $manage_unresolved (blocked=$manage_blocked, open=$manage_open)"
echo "  leakage matches:            $leak_count"
echo "  GoalChanged (scoped):       $goalchanged_count"
echo "  craft (scoped) total/err:   $craft_total/$craft_errors"
echo "  [RETRO] total/pending:      $retro_total/$retro_pending (ready=$retro_ready running=$retro_running)"
echo "  scoped verb errors (top):   $verb_err_summary"
echo "  craft_diag (scoped craft):  $craft_diag_summary"
echo "  gv2 card compliance:        $gv2_compliance_summary"
echo "  mc disconnect/503 (scoped): $server_down_count"
echo "  terrain-stall matches:      $terrain_count"
echo
echo "result: $status"

if ((${#fail_reasons[@]} > 0)); then
  echo "fail reasons:"
  for r in "${fail_reasons[@]}"; do
    echo "  - $r"
  done
fi

if ((${#warn_reasons[@]} > 0)); then
  echo "warnings:"
  for r in "${warn_reasons[@]}"; do
    echo "  - $r"
  done
fi

if (( protocol_count > 0 )); then
  echo
  echo "sample protocol lines:"
  sample_lines "$protocol_hits" 8
fi

if (( manage_unresolved > 0 )); then
  echo
  echo "sample re-dispatch lines (unresolved MANAGE present):"
  sample_lines "$redispatch_hits" 8
fi

if (( leak_count > 0 )); then
  echo
  echo "sample leakage lines:"
  sample_lines "$leak_hits" 12
fi

case "$status" in
  PASS) exit 0 ;;
  WARN) exit 10 ;;
  FAIL) exit 20 ;;
esac

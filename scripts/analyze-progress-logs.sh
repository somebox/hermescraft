#!/usr/bin/env bash
# Summarize landfolk-control progress JSONL (B: stuck / idle / reported errors across agents).
#
# Reads last N lines per progress-*.log in LOG_DIR (default /tmp/hermescraft) and prints
# counts plus sample lines for recurring issues.
#
# Usage:
#   ./scripts/analyze-progress-logs.sh [LOG_DIR]

set -euo pipefail

LOG_DIR="${1:-${LOG_DIR:-/tmp/hermescraft}}"
LINES_PER_FILE="${PROGRESS_TAIL_LINES:-500}"

summarize_python() {
  python3 "$1"
}

_summarize_here() {
  cat <<'PY'
import collections, json, os, sys

log_dir = os.environ["LOG_DIR"]
lines_max = int(os.environ["LINES_MAX"])
patterns = collections.Counter()
idle_n = collections.Counter()
goals_u = collections.Counter()
last_errors = []

for fname in sorted(os.listdir(log_dir)):
    if not fname.startswith("progress-") or not fname.endswith(".log"):
        continue
    path = os.path.join(log_dir, fname)
    try:
        raw = open(path, "rb").read().splitlines()
    except OSError:
        continue
    tail = raw[-lines_max:] if lines_max > 0 else raw
    agent = fname.replace("progress-", "").replace(".log", "")
    rows = []
    for line in tail:
        try:
            s = line.decode("utf-8", "replace").strip()
            if not s:
                continue
            rows.append(json.loads(s))
        except Exception:
            continue
    if not rows:
        continue
    print(f"=== {fname} (~{len(rows)} rows) agent={agent} ===")
    for r in rows:
        g = r.get("goal")
        goals_u[g] += 1
        ir = str(r.get("idle_reason") or "")
        idle_n[ir] += 1
        errs = []
        top = r.get("top_errors")
        if isinstance(top, list):
            errs.extend([str(e) for e in top if e])
        le = r.get("last_error")
        if isinstance(le, str) and le.strip():
            errs.append(le.strip())
            if len(last_errors) < 120:
                last_errors.append((agent, r.get("round"), le[:220]))
        for e in errs:
            patterns[e[:140]] += 1
    idle_top = idle_n.most_common(8)
    if idle_top:
        print("idle_reason:")
        for k, v in idle_top:
            print(f"   {v:4d}  {k or '(empty)'}")
    idle_n.clear()

    tg = goals_u.most_common(6)
    if tg:
        print("top_goal id (sampled ticks):")
        for k, v in tg:
            print(f"   {v:4d}  {k}")
    goals_u.clear()

    err_top = patterns.most_common(12)
    if err_top:
        print("error strings (truncated @140):")
        for k, v in err_top:
            print(f"   {v:4d}  {k}")
    patterns.clear()

    print("")
if last_errors:
    print("recent last_error snippets (up to 10):")
    for agent, rnd, txt in last_errors[-10:]:
        print(f"  [{agent}] round={rnd} {txt}")
PY
}

export LOG_DIR="$LOG_DIR"
export LINES_MAX="$LINES_PER_FILE"

if [[ ! -d "$LOG_DIR" ]]; then
  echo "Directory not found: $LOG_DIR" >&2
  exit 2
fi

tmp_py="$(mktemp)"
_summarize_here >"$tmp_py"
summarize_python "$tmp_py"
rm -f "$tmp_py"

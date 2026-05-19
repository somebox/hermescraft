#!/usr/bin/env bash
# /tmp/hermescraft/runs/<RUN_ID>/ — reliable test-run logging convention.
# See docs/experiments/run-logging.md.
#
# Subcommands:
#   exp.sh start <slug> [prompt_file]   — start a new run
#   exp.sh midcheck [<label>]            — snapshot current state
#   exp.sh stop                          — kill agent, write summary, clear current
#   exp.sh status                        — print live state of active run
#   exp.sh watch                         — tail events.jsonl + position deltas (live)
#   exp.sh analyze [<run-id>]            — post-mortem stats
#   exp.sh poll-daemon <run-id>          — internal: position poller (used by start)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNS_ROOT="/tmp/hermescraft/runs"
CURRENT="$RUNS_ROOT/current"
POLL_INTERVAL_S=30
EXP_LIB="$SCRIPT_DIR/scripts/exp_lib.py"

mkdir -p "$RUNS_ROOT"

usage() {
  cat <<EOF
usage: scripts/exp.sh <subcommand> [...]

subcommands:
  start <slug> [prompt_file]   start a new test run (creates /tmp/hermescraft/runs/<YYYYMMDD-HHMMSS-slug>/)
  midcheck [<label>]            snapshot the current run into midchecks/T+<elapsed>m.log
  stop                          kill agent + position poller, write summary, clear 'current' symlink
  status                        print live state of the current run
  watch                         live-tail events.jsonl with position deltas (Ctrl-C to exit)
  analyze [<run-id>]            compute distance / events / pace stats

defaults:
  - the 'current' symlink (/tmp/hermescraft/runs/current) always points at the active run
  - all monitoring scripts work off the symlink — never hardcode run IDs
EOF
}

cmd_start() {
  local slug="${1:-}"
  local prompt_file="${2:-/tmp/hermescraft/steve-expedition-prompt.md}"
  if [[ -z "$slug" ]]; then
    echo "ERROR: usage: exp.sh start <slug> [prompt_file]" >&2
    return 2
  fi
  if [[ ! -f "$prompt_file" ]]; then
    echo "ERROR: prompt file not found: $prompt_file" >&2
    return 2
  fi
  local run_id="$(date +%Y%m%d-%H%M%S)-${slug}"
  local run_dir="$RUNS_ROOT/$run_id"
  mkdir -p "$run_dir/midchecks"

  # Capture meta BEFORE launching anything.
  cat > "$run_dir/meta.json" <<JSON
{
  "run_id": "$run_id",
  "slug": "$slug",
  "start_ts": $(date +%s),
  "start_iso": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "prompt_path": "$prompt_file",
  "host": "$(hostname)",
  "git_head": "$(cd "$SCRIPT_DIR" && git rev-parse HEAD 2>/dev/null || echo unknown)"
}
JSON

  # Update the 'current' symlink.
  ln -sfn "$run_dir" "$CURRENT"
  echo "[exp] RUN_ID=$run_id"
  echo "[exp] dir=$run_dir"
  echo "[exp] current -> $run_id"

  # Launch agent. We point its stdout at run_dir/agent.log AND keep a
  # back-compat copy at /tmp/hermescraft/steve-agent.log for watch-steve.py.
  cd "$SCRIPT_DIR"
  nohup ./scripts/run-landfolk-agent.sh \
    Steve 3001 "$prompt_file" /Users/foz/.hermes-landfolk-steve \
    > "$run_dir/agent.log" 2>&1 &
  local agent_pid=$!
  echo "[exp] agent_pid=$agent_pid"

  # Mirror for watch-steve.py compatibility.
  ln -sf "$run_dir/agent.log" /tmp/hermescraft/steve-agent.log

  # Position poller (background loop calling exp_lib.py poll-once every 30s).
  (
    while ps -p "$agent_pid" >/dev/null 2>&1; do
      "$EXP_LIB" poll-once "$run_id" >/dev/null 2>&1 || true
      sleep "$POLL_INTERVAL_S"
    done
    echo "[poller] agent gone, stopping" >> "$run_dir/events.jsonl"
  ) &
  local poller_pid=$!
  echo "[exp] poller_pid=$poller_pid"

  # Stash pids back into meta.
  python3 -c "
import json, pathlib
p = pathlib.Path('$run_dir/meta.json')
d = json.loads(p.read_text())
d['agent_pid'] = $agent_pid
d['poller_pid'] = $poller_pid
p.write_text(json.dumps(d, indent=2) + '\n')
"
  echo "[exp] started. watch with: scripts/exp.sh status   |   scripts/watch-steve.py"
}

cmd_midcheck() {
  "$EXP_LIB" midcheck "${1:-}"
}

cmd_status() {
  "$EXP_LIB" status "${1:-}"
}

cmd_analyze() {
  "$EXP_LIB" analyze "${1:-}"
}

cmd_watch() {
  if [[ ! -L "$CURRENT" ]]; then
    echo "[exp] no active run — start one with: exp.sh start <slug>" >&2
    return 1
  fi
  local run_dir
  run_dir="$(readlink "$CURRENT")"
  echo "[exp] watching $(basename "$run_dir") — Ctrl-C to exit"
  echo "[exp] events: $run_dir/events.jsonl"
  echo "[exp] positions: $run_dir/positions.jsonl"
  echo "──────────────────────────────────────────────────────────────"
  # Tail both files with file-name prefix.
  tail -F -n 0 \
    "$run_dir/events.jsonl" \
    "$run_dir/positions.jsonl" 2>/dev/null | python3 -c "
import sys, json
prev_pos = None
for line in sys.stdin:
  line = line.strip()
  if not line or line.startswith('==>'):
    if line.startswith('==>'):
      # tail's file-marker
      kind = 'events' if 'events' in line else 'positions'
    continue
  try:
    d = json.loads(line)
  except: continue
  if 'kind' in d:
    # event
    ts = d.get('ts','?')[11:19]
    print(f'\033[33m{ts} EVENT [{d[\"kind\"]}]\033[0m {dict((k,v) for k,v in d.items() if k not in (\"ts\",\"kind\"))}', flush=True)
  elif 'x' in d:
    # position
    ts = d.get('ts','?')[11:19]
    dx = (d['x'] - prev_pos['x']) if prev_pos else 0
    dz = (d['z'] - prev_pos['z']) if prev_pos else 0
    delta = (dx*dx + dz*dz) ** 0.5 if prev_pos else 0
    task = d.get('task_action') or '-'
    s = d.get('task_status') or '-'
    print(f'\033[2m{ts} POS  ({d[\"x\"]:.0f},{d[\"y\"]},{d[\"z\"]:.0f}) hp={d[\"hp\"]} food={d[\"food\"]} task={task}/{s} Δ={delta:.0f}b\033[0m', flush=True)
    prev_pos = d
"
}

cmd_stop() {
  if [[ ! -L "$CURRENT" ]]; then
    echo "[exp] no active run (symlink missing)" >&2
    return 1
  fi
  local run_dir
  run_dir="$(readlink "$CURRENT")"
  echo "[exp] stopping run: $(basename "$run_dir")"
  # Read pids from meta and kill.
  local agent_pid poller_pid
  agent_pid="$(python3 -c "import json; print(json.load(open('$run_dir/meta.json')).get('agent_pid',''))")"
  poller_pid="$(python3 -c "import json; print(json.load(open('$run_dir/meta.json')).get('poller_pid',''))")"
  if [[ -n "$agent_pid" ]]; then kill "$agent_pid" 2>/dev/null || true; fi
  if [[ -n "$poller_pid" ]]; then kill "$poller_pid" 2>/dev/null || true; fi
  pkill -f 'hermes chat.*hermes-landfolk-steve' 2>/dev/null || true
  pkill -f 'run-landfolk-agent.sh Steve' 2>/dev/null || true
  sleep 1
  # Write a summary.
  "$EXP_LIB" analyze "$(basename "$run_dir")" > "$run_dir/summary.md" 2>&1 || true
  echo "[exp] summary at $run_dir/summary.md"
  rm -f "$CURRENT"
  echo "[exp] cleared 'current' symlink"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  midcheck) shift; cmd_midcheck "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  status) shift; cmd_status "$@" ;;
  watch) shift; cmd_watch "$@" ;;
  analyze) shift; cmd_analyze "$@" ;;
  -h|--help|help|"") usage ;;
  *) echo "unknown subcommand: $1" >&2; usage; exit 2 ;;
esac

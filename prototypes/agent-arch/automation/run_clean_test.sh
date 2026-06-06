#!/usr/bin/env bash
# Run one isolated test:
#   1. Reset the bot.
#   2. Reset the profile.
#   3. Verify clean.
#   4. Create card + dispatch.
#   5. Wait for terminal status.
#   6. Capture metrics → /tmp/clean-<tag>.json
#
# Usage:
#   run_clean_test.sh <profile> <hermes_home> <tag> <body> <skills>
#   e.g.
#   run_clean_test.sh pilot-navigator /Users/foz/.hermes-proto-agent-arch n1 \
#       "Navigate to mark :island_tree: (within 2 blocks)." \
#       "agent-navigator,minecraft-navigation,minecraft-survival"
#
#   run_clean_test.sh flint /Users/foz/.hermes f1 \
#       "Navigate to mark :island_tree: (within 2 blocks)." \
#       ""    # no extra skills — flint uses its installed catalog
#
# Env overrides:
#   PROTO_TENANT     proto-agent-arch (for pilot-* HOMEs)
#   PROTO_BOT_PORT   3002
#   PROTO_START_X    -29 (default)
#   PROTO_START_Y    64
#   PROTO_START_Z    -28

set -euo pipefail

PROFILE="${1:?profile}"
HOME_DIR="${2:?hermes_home}"
TAG="${3:?tag}"
BODY="${4:?body}"
SKILL_CSV="${5:-}"

AUTO_DIR="/Users/foz/hermescraft/prototypes/agent-arch/automation"
TENANT="${PROTO_TENANT:-proto-agent-arch}"
PORT="${PROTO_BOT_PORT:-3002}"
START_X="${PROTO_START_X:--29}"
START_Y="${PROTO_START_Y:-64}"
START_Z="${PROTO_START_Z:--28}"

log() { printf '[run_clean/%s] %s\n' "$TAG" "$*"; }

# 1. Reset profile (and any others that may have lingered from previous runs)
log "resetting profile $PROFILE"
"$AUTO_DIR/reset_profile.sh" "$HOME_DIR" "$PROFILE" >/dev/null

# 2. Reset bot
log "resetting bot to ($START_X,$START_Y,$START_Z)"
"$AUTO_DIR/reset_bot.py" --port "$PORT" \
    --start-x "$START_X" --start-y "$START_Y" --start-z "$START_Z" \
    > /tmp/run-clean-$TAG.reset.log 2>&1

# 3. Verify
log "verifying clean baseline"
if ! "$AUTO_DIR/verify_clean.sh" "$HOME_DIR" "$PROFILE" "$PORT" > /tmp/run-clean-$TAG.verify.log 2>&1; then
  log "VERIFY FAILED — see /tmp/run-clean-$TAG.verify.log"
  cat /tmp/run-clean-$TAG.verify.log
  exit 1
fi

# 4. Create card
# For pilot-* HOMEs the tenant matters; for flint we omit --tenant.
extra_args=()
if [[ "$HOME_DIR" == *proto-agent-arch* ]]; then
  extra_args+=(--tenant "$TENANT")
fi
# Skills
if [ -n "$SKILL_CSV" ]; then
  IFS=',' read -r -a skills <<< "$SKILL_CSV"
  for s in "${skills[@]}"; do extra_args+=(--skill "$s"); done
fi

log "creating card on $PROFILE"
START_TS=$(date +%s)
CARD=$(HERMES_HOME="$HOME_DIR" hermes kanban create \
    "${extra_args[@]}" \
    --assignee "$PROFILE" \
    --body "$BODY" \
    --max-runtime 10m \
    --json \
    "clean-$TAG: $(echo "$BODY" | head -c 50)" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
log "card $CARD created"
HERMES_HOME="$HOME_DIR" hermes kanban dispatch --max 1 >/dev/null 2>&1

# 5. Wait for terminal status
for i in $(seq 1 180); do
  sleep 4
  s=$(HERMES_HOME="$HOME_DIR" hermes kanban show "$CARD" --json 2>/dev/null \
        | python3 -c 'import sys,json; print(json.load(sys.stdin)["task"]["status"])' 2>/dev/null || echo "?")
  case "$s" in
    done|blocked|archived) break ;;
  esac
done
END_TS=$(date +%s)
DUR=$((END_TS - START_TS))
log "card status=$s after ${DUR}s"

# 6. Capture metrics
python3 - "$HOME_DIR" "$PROFILE" "$CARD" "$DUR" "$s" "$TAG" "$PORT" <<'PY'
import json, os, re, sqlite3, sys

hh, prof, card, dur, status, tag, port = sys.argv[1:8]
# Find the kanban DB that ACTUALLY contains this card.
# Try the shared DB first, then walk the per-board layout.
candidate_dbs = []
shared = os.path.join(hh, "kanban.db")
if os.path.exists(shared):
    candidate_dbs.append(shared)
boards_dir = os.path.join(hh, "kanban", "boards")
if os.path.exists(boards_dir):
    for entry in os.listdir(boards_dir):
        per_board = os.path.join(boards_dir, entry, "kanban.db")
        if os.path.exists(per_board):
            candidate_dbs.append(per_board)
kdb = None
for c in candidate_dbs:
    try:
        cc = sqlite3.connect(c)
        row = cc.execute("SELECT id FROM tasks WHERE id=?", (card,)).fetchone()
        cc.close()
        if row:
            kdb = c
            break
    except Exception:
        continue
if not kdb:
    print(f"WARN: card {card} not found in any kanban DB: {candidate_dbs}", file=sys.stderr)
    kdb = candidate_dbs[0] if candidate_dbs else shared
conn = sqlite3.connect(kdb)
row = conn.execute(
    "SELECT json_extract(metadata,'$.worker_session_id'), profile, outcome "
    "FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1",
    (card,)
).fetchone()
conn.close()
sess = row[0] if row else None

log_path = os.path.join(hh, "profiles", prof, "logs", "agent.log")
api_re = re.compile(rf"\[{re.escape(sess) if sess else 'NEVERMATCH'}\] agent.conversation_loop: API call #(\d+): "
                    rf"model=(\S+) provider=(\S+) in=(\d+) out=(\d+) total=(\d+) latency=([\d.]+)s")
calls = []
if sess and os.path.exists(log_path):
    for line in open(log_path):
        m = api_re.search(line)
        if m:
            calls.append({
                "in": int(m.group(4)), "out": int(m.group(5)),
                "total": int(m.group(6)), "lat": float(m.group(7)),
            })

# Bot final state
try:
    import urllib.request
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/status?lean=true", timeout=5) as r:
        d = json.loads(r.read().decode())["data"]
    bot = {"pos": d.get("position"), "hp": d.get("health"), "food": d.get("food")}
except Exception as e:
    bot = {"error": str(e)}

result = {
    "tag": tag,
    "profile": prof,
    "card": card,
    "status": status,
    "duration_s": int(dur),
    "worker_session_id": sess,
    "api_calls": len(calls),
    "tokens_in": sum(c["in"] for c in calls),
    "tokens_out": sum(c["out"] for c in calls),
    "turn1_in": calls[0]["in"] if calls else None,
    "final_in": calls[-1]["in"] if calls else None,
    "latency_sum": round(sum(c["lat"] for c in calls), 1),
    "bot_end": bot,
}
with open(f"/tmp/clean-{tag}.json", "w") as f:
    json.dump(result, f, indent=2)
print(json.dumps(result, indent=2))
PY

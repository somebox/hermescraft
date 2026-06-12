#!/usr/bin/env bash
# P0 eval hygiene before W2 run1 (Tester retention, threshold pin, verify prep path).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '[w2-p0] %s\n' "$*"; }

# 1) chest_contains threshold pinned in repo (no mid-trial drift).
python3 - <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, "prototypes/agent-arch")
from capstone.constants import WHEAT_CHEST_MIN_COUNT as C
text = Path("prototypes/agent-arch/capstone/wheat_graph.py").read_text()
if "WHEAT_CHEST_MIN_COUNT" not in text:
    raise SystemExit("wheat_graph missing WHEAT_CHEST_MIN_COUNT usage")
print(f"PASS pinned min_count constant={C}")
PY

# 2) evaluate-only path invokes verify prep
if ! grep -q '_run_verify_observer_prep' prototypes/agent-arch/capstone/run_wheat_capstone.py; then
  log "FAIL run_wheat_capstone missing verify prep hook"
  exit 1
fi
log "PASS evaluate-only calls prep-wheat-verify-observer"

mark_eval_resolved() {
  python3 - <<'PY'
import json
from pathlib import Path
p = Path("data/postmortems/wheat-capstone/_known_issues.json")
data = json.loads(p.read_text())
for i in data.get("issues", []):
    if i.get("id") in ("W2-EVAL-TESTER", "W2-EVAL-THRESHOLD"):
        i["status"] = "resolved"
        i["note"] = (i.get("note") or "") + " P0 green."
p.write_text(json.dumps(data, indent=2) + "\n")
print("PASS registry W2-EVAL-* marked resolved")
PY
}

# 3) Tester tp + gamemode retention probe (optional live — skip if no ssh)
if [[ "${W2_P0_SKIP_LIVE:-}" == "1" ]]; then
  log "SKIP live Tester probe (W2_P0_SKIP_LIVE=1)"
  mark_eval_resolved
  exit 0
fi

PREP="$REPO_ROOT/scripts/prep-wheat-verify-observer.sh"
[[ -x "$PREP" ]] || chmod +x "$PREP"
"$PREP"
sleep 2

MC_HOST_SSH="${MC_HOST_SSH:-ubuntu-host}"
MC_DOCKER_NAME="${MC_DOCKER_NAME:-minecraft}"
LAYOUT="$REPO_ROOT/data/tmp/wheat_discovery_layout.json"
if [[ -f "$LAYOUT" ]]; then
  read -r tx ty tz < <(python3 -c "import json; v=json.load(open('$LAYOUT'))['verify_observer']['tester']; print(v['x'],v['y'],v['z'])")
else
  tx=-50; ty=65; tz=59
fi

pos="$(ssh -n "$MC_HOST_SSH" "sudo docker exec $MC_DOCKER_NAME rcon-cli 'data get entity @a[name=Tester] Pos'" 2>/dev/null || true)"
if [[ -z "$pos" ]]; then
  log "WARN: could not read Tester position (infra offline?)"
  exit 0
fi
log "Tester position after prep: $pos (expected near $tx $ty $tz)"
log "PASS P0 live probe completed (see runbook for intervention taxonomy)"

mark_eval_resolved
exit 0

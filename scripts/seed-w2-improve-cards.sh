#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOARD="${BOARD:-wheat-capstone}"
ISSUE_ID="${1:-W2-AUTO-001}"
RUN_ID="${2:-w2-local}"

# Pick the right registry by board (wheat-capstone vs proc-nav-lab). The
# registry path is overridable via REGISTRY env for non-standard boards.
case "$BOARD" in
  proc-nav-lab) DEFAULT_REGISTRY="$REPO_ROOT/data/postmortems/proc-nav-lab/_known_issues.json" ;;
  *)            DEFAULT_REGISTRY="$REPO_ROOT/data/postmortems/wheat-capstone/_known_issues.json" ;;
esac
REGISTRY="${REGISTRY:-$DEFAULT_REGISTRY}"

export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

BODY="$(REGISTRY="$REGISTRY" python3 - "$ISSUE_ID" "$RUN_ID" "$REPO_ROOT" <<'PY'
import json, os, sys
issue_id, run_id, repo = sys.argv[1:4]
reg_path = os.environ["REGISTRY"]
reg = json.loads(open(reg_path).read())
issue = next((i for i in reg["issues"] if i["id"] == issue_id), None)
if not issue:
    print(f"unknown issue {issue_id} in {reg_path}", file=sys.stderr)
    sys.exit(1)
path = issue.get("script_path") or "(see registry)"
verifier = issue.get("verifier") or "(no verifier; check registry note)"
specs = {
    # ── wheat self-improvement ────────────────────────────────────────
    "W2-AUTO-001": (
        "Write `data/workspace/production/scripts/wheat_plot_bounds.sh`.\n"
        "Spec: read plot bounds from `mc marks` / `mc inspect --mark wheat_plot`; "
        "emit JSON to stdout `{plot:{x,y,z}, corners:[[x1,z1],[x2,z2]]}`.\n"
        "No hardcoded world coords from the discovery seed file.\n"
        "Test: `scripts/w2-verify-plot-script.sh data/workspace/production/scripts/wheat_plot_bounds.sh`"
    ),
    "W2-AUTO-002": (
        "Write `data/workspace/production/scripts/wheat_chest_coords.sh`.\n"
        "Spec: resolve `wheat_chest` mark for deposit approach; print adjacent stand coords.\n"
        "Test: `scripts/w2-verify-chest-script.sh data/workspace/production/scripts/wheat_chest_coords.sh`"
    ),
    "W2-AUTO-003": (
        "Write `data/workspace/production/data/wheat_survey_cache.json` (not a shell script).\n"
        "Spec: JSON cache of last navigator 16×16 survey (marks + grid snapshot) so cycle 2+ "
        "can skip full re-survey when fixture marks match.\n"
        "Test: `scripts/w2-verify-survey-cache.sh data/workspace/production/data/wheat_survey_cache.json`"
    ),
    # ── proc-nav self-improvement ─────────────────────────────────────
    "W2-NAV-001": (
        "Write `data/workspace/production/scripts/proc_nav_anchor_coords.sh`.\n"
        "Spec: resolve an anchor by name to {x,y,z}. Strategy order:\n"
        "  1. `mc inspect --mark <anchor>` (preferred — live bot data)\n"
        "  2. `mc marks` text output, grep for the anchor name\n"
        "  3. `data/runtime/last-scenario-map.json` `placements.<anchor>` (fallback)\n"
        "Anchor name comes from --anchor flag or env ANCHOR; default `overlook`.\n"
        "Emit JSON to stdout `{anchor: <name>, coords: {x,y,z}, near: <int>}` (near default 4).\n"
        "Honor newline-safe parsing — do NOT use bare `read CX CY CZ` after `grep -oE '[-]?[0-9]+'` "
        "(W2 wheat lesson: that bug fell through to the wrong fallback).\n"
        f"Test: `scripts/proc-nav-verify-anchor.sh data/workspace/production/scripts/proc_nav_anchor_coords.sh`\n"
        "Strict runtime test (recommended): `scripts/proc-nav-verify-anchor.sh --runtime-test data/workspace/production/scripts/proc_nav_anchor_coords.sh`"
    ),
    "W2-NAV-002": (
        "Not automation_eligible — refine card bodies and `minecraft-navigation` skill hints.\n"
        "Deliverable: a markdown patch to `skills/minecraft-navigation.md` adding biome-aware "
        "escape doctrine (corner sidestep, tall-grass push-through, water-edge pillar up).\n"
        "Test: re-run proc-scout-stress; `nav_escape_count` ≥ 1 with no NAV_BLOCKED loop > 5 min."
    ),
    "W2-NAV-003": (
        "Not automation_eligible — extend the `verify_results` handoff schema.\n"
        "Deliverable: doc patch to `docs/architecture/observe-cards.md` requiring "
        "`position_at_complete`, `mark`, `predicates[]` non-empty on observe cards; "
        "matching pytest in `prototypes/agent-arch/tests/test_proc_nav_handoff.py`.\n"
        "Test: handoff pytest green on a re-run proc-scout RUN_ID."
    ),
    "W2-NAV-004": (
        "Fix `scripts/agent-test.py` so Phase B run JSON reports non-zero `mc_cli_invocations` "
        "when the worker runs `mc` via Hermes chat-mode tool calls (not only structured tool_calls).\n"
        "Add `scripts/tests/test_agent_test_tool_counter.py` with a fixture transcript.\n"
        "Test: pytest on tool counter; re-run baseline agent-test and confirm expect predicates."
    ),
    "W2-NAV-005": (
        "Patch `prototypes/agent-arch/setup-role-profiles.sh` to install "
        "`skills/minecraft-observe.md` on the **navigator** profile (gaming/minecraft-observe) "
        "when proc-nav / observe cards are in scope.\n"
        "Test: fresh profile install; pn-observe card skills resolve without manual copy."
    ),
    "W2-NAV-006": (
        "Patch `prototypes/agent-arch/capstone/proc_scout_graph.py` planner card bodies: "
        "explicit paths `data/runtime/last-scenario-map.json`, seed field, and "
        "`reports/agent-arch/proc-nav-scout-runbook.md` (or workspace playbook path).\n"
        "Test: dry-run card bodies grep those paths; planner trial cites map JSON."
    ),
}
print(f"IMPROVE for run **{run_id}** — issue **{issue_id}**\n")
print(f"Deliverable path: `{path}`")
print(f"Verifier: `{verifier}`\n")
print(specs.get(issue_id, "See _known_issues.json evidence.\n"))
print(f"\nRepo root: `$HERMESCRAFT_REPO` (= {repo}).")
print("On complete: overseer runs REVIEW; operator runs w2-promote-artifact.sh after REVIEW done.")
PY
)"

IMPROVE_ID="$(hermes kanban --board "$BOARD" create \
  --tenant proto-agent-arch \
  --assignee engineer \
  --body "$BODY" \
  --max-runtime 20m \
  --skill kanban-worker \
  --skill agent-engineer-desk \
  --json \
  "[IMPROVE] $ISSUE_ID for $RUN_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")"

REVIEW_BODY="Review engineer deliverable for $ISSUE_ID.
Run the verifier named in the IMPROVE card before approving.
Approve only if the file exists under data/workspace/production/ and verifier exits 0.
metadata.card_kind=research"

REVIEW_ID="$(hermes kanban --board "$BOARD" create \
  --tenant proto-agent-arch \
  --assignee overseer \
  --parent "$IMPROVE_ID" \
  --body "$REVIEW_BODY" \
  --max-runtime 15m \
  --skill kanban-worker \
  --json \
  "[REVIEW] approve $ISSUE_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")"

echo "improve=$IMPROVE_ID review=$REVIEW_ID"

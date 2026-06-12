#!/usr/bin/env bash
# W2 trial driver — tiered phases (see wheat-w2-self-improve-runbook.md).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
export HERMESCRAFT_REPO="${HERMESCRAFT_REPO:-$REPO_ROOT}"
BOARD="${BOARD:-wheat-capstone}"
RUN_ID="${RUN_ID:-w2-$(date +%s)}"
# Default execute graph: w2 (capstone fixture + script hooks). Set W2_GRAPH=discovery for arena lane.
W2_GRAPH="${W2_GRAPH:-w2}"
W2_FIXTURE="${W2_FIXTURE:-}"
MC_HOST="${MC_HOST:-}"

usage() {
  cat <<'EOF'
Usage: scripts/wheat-w2-trial.sh <phase>

Phases:
  prep-offline   reset + W1/W2 profiles + bots + fixture + validate + preflights + dry-run
  p0             P0 eval hygiene (after fixture staged)
  dispatcher     print start command (or run if W2_START_DISPATCHER=1)
  smoke-script   script obedience gate (dispatcher must be running)
  prep           fixture only (use prep-offline for cold start)
  run1|run2|run3 execute + watch + evaluate (W2_GRAPH default w2)
  feedback1|feedback2
  synthesize1|synthesize2
  plan-verify    optional desk chain (pv001–pv003); RUN_ID suffix -pv
  improve1|improve2  seed IMPROVE/REVIEW (execute lane idle; dispatcher ON)
  reset-execute  archive [bot:mox] + FEEDBACK; keep registry/scripts
  report         w2_report.py tiered summary
  teardown       stop dispatcher + reset-wheat-capstone

Env: RUN_ID, W2_GRAPH=w2|discovery, W2_FIXTURE=capstone|discovery,
     W2_BASELINE_RUN, W2_P0_SKIP_LIVE, W2_START_DISPATCHER=1
EOF
}

log() { printf '[w2-trial] %s\n' "$*"; }

_fixture_yaml() {
  if [[ -n "$W2_FIXTURE" ]]; then
    case "$W2_FIXTURE" in
      capstone) echo "data/test-fixtures/colony/wheat_capstone.yaml" ;;
      discovery) echo "data/test-fixtures/colony/wheat_discovery.yaml" ;;
      *) echo "$W2_FIXTURE" ;;
    esac
    return
  fi
  if [[ "$W2_GRAPH" == discovery ]]; then
    echo "data/test-fixtures/colony/wheat_discovery.yaml"
  else
    echo "data/test-fixtures/colony/wheat_capstone.yaml"
  fi
}

case "${1:-}" in
  prep-offline)
    scripts/reset-wheat-capstone.sh
    prototypes/agent-arch/setup-role-profiles.sh
    prototypes/agent-arch/setup-engineer-w2.sh
    prototypes/agent-arch/setup-overseer-w2.sh
    prototypes/agent-arch/setup-planner-w2.sh
    scripts/run-tester-bot.sh
    [[ -n "$MC_HOST" ]] || { log "set MC_HOST for scripts/colony start mox"; exit 2; }
    MC_HOST="$MC_HOST" scripts/colony start mox
    fy="$(_fixture_yaml)"
    WHEAT_DISCOVERY_SEED="${WHEAT_DISCOVERY_SEED:-$RUN_ID}" scripts/run-fixture.sh prep "$fy"
    if [[ "$fy" == *wheat_capstone* ]]; then
      scripts/validate-wheat-fixture.sh
    else
      scripts/validate-wheat-discovery.sh
    fi
    scripts/preflight-wheat.sh
    W2_P0_SKIP_LIVE="${W2_P0_SKIP_LIVE:-1}" scripts/preflight-w2-p0.sh
    prototypes/agent-arch/capstone/preflight.sh
    python3 prototypes/agent-arch/capstone/run_wheat_capstone.py \
      --dry-run --board "$BOARD" --graph "$W2_GRAPH"
    log "prep-offline done; start dispatcher before smoke-script / run1"
    ;;
  p0)
    scripts/preflight-w2-p0.sh
    ;;
  dispatcher)
    DISPATCHER_LOG="${DISPATCHER_LOG:-/tmp/wheat-dispatcher-${RUN_ID}.log}"
    if [[ "${W2_START_DISPATCHER:-}" == "1" ]]; then
      scripts/wheat-dispatcher.sh >>"$DISPATCHER_LOG" 2>&1 &
      echo $! >/tmp/wheat-dispatcher-w2-pid
      log "dispatcher pid=$(cat /tmp/wheat-dispatcher-w2-pid) log=$DISPATCHER_LOG"
    else
      echo "scripts/wheat-dispatcher.sh >>\"$DISPATCHER_LOG\" 2>&1 &"
      echo "echo \$! >/tmp/wheat-dispatcher-w2-pid"
    fi
    ;;
  smoke-script)
    scripts/wheat-w2-smoke-script.sh
    log "wait for smoke card done; grep dispatcher log for w2-smoke-ok; then reset-execute or archive smoke card before run1"
    ;;
  prep)
    fy="$(_fixture_yaml)"
    WHEAT_DISCOVERY_SEED="${WHEAT_DISCOVERY_SEED:-$RUN_ID}" scripts/run-fixture.sh prep "$fy"
    if [[ "$fy" == *discovery* ]]; then
      scripts/validate-wheat-discovery.sh
    else
      scripts/validate-wheat-fixture.sh
    fi
    ;;
  run1|run2|run3)
    cycle=1
    [[ "$1" == run2 ]] && cycle=2
    [[ "$1" == run3 ]] && cycle=3
    graph="$W2_GRAPH"
    python3 prototypes/agent-arch/capstone/run_wheat_capstone.py \
      --run-id "$RUN_ID" --board "$BOARD" --graph "$graph" --w2-cycle "$cycle" --create-only
    python3 prototypes/agent-arch/capstone/run_wheat_capstone.py \
      --run-id "$RUN_ID" --board "$BOARD" --watch
    python3 prototypes/agent-arch/capstone/run_wheat_capstone.py \
      --run-id "$RUN_ID" --board "$BOARD" --evaluate-only
    ;;
  feedback1|feedback2)
    scripts/collect-trial-feedback.sh --run-id "$RUN_ID" --board "$BOARD"
    ;;
  synthesize1|synthesize2)
    scripts/synthesize-trial-feedback.py --run-id "$RUN_ID" \
      --out-dir "data/postmortems/$BOARD/$RUN_ID" \
      --scorecard "data/postmortems/$BOARD/$RUN_ID/scorecard.json"
    ;;
  plan-verify)
    log "optional stretch: plan-live-verify desk chain (uses planner + observe skills)"
    python3 prototypes/agent-arch/capstone/run_wheat_capstone.py \
      --run-id "${RUN_ID}-pv" --board "$BOARD" --graph plan-verify --create-only
    python3 prototypes/agent-arch/capstone/run_wheat_capstone.py \
      --run-id "${RUN_ID}-pv" --board "$BOARD" --watch
    log "postmortem: data/postmortems/$BOARD/${RUN_ID}-pv/ ; pytest with W2_PLAN_VERIFY_RUN_ID=${RUN_ID}-pv"
    ;;
  improve1|improve2)
    issue=W2-AUTO-001
    [[ "$1" == improve2 ]] && issue=W2-AUTO-003
    log "policy: dispatcher STAYS ON; seed only when no [bot:mox] card is running"
    scripts/seed-w2-improve-cards.sh "$issue" "$RUN_ID"
    log "when REVIEW done: scripts/w2-promote-artifact.sh $RUN_ID $issue"
    ;;
  reset-execute)
    scripts/reset-wheat-execute-only.sh
    ;;
  report)
    python3 prototypes/agent-arch/capstone/w2_report.py --run-id "$RUN_ID" --baseline "${W2_BASELINE_RUN:-}"
    log "output: data/postmortems/$BOARD/$RUN_ID/w2-report.json"
    ;;
  teardown)
    kill "$(cat /tmp/wheat-dispatcher-w2-pid 2>/dev/null)" 2>/dev/null || true
    rm -f /tmp/wheat-dispatcher-w2-pid
    scripts/reset-wheat-capstone.sh
    log "teardown done; keep data/postmortems/$BOARD/$RUN_ID for evidence"
    ;;
  ""|-h|--help)
    usage; exit 0
    ;;
  *)
    echo "unknown phase: $1" >&2; usage; exit 2
    ;;
esac

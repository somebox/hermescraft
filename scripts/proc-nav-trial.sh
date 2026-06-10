#!/usr/bin/env bash
# Proc-nav trial driver — Baseline → Core → Stress (see proc-nav-scout-runbook.md).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
export HERMESCRAFT_REPO="${HERMESCRAFT_REPO:-$REPO_ROOT}"
BOARD="${BOARD:-proc-nav-lab}"
RUN_ID="${RUN_ID:-proc-nav-$(date +%s)}"
PROC_NAV_GRAPH="${PROC_NAV_GRAPH:-proc-scout}"
MOX_URL="${MOX_URL:-http://127.0.0.1:3007}"
export MC_API_URL="$MOX_URL"
export MC_USERNAME="${MC_USERNAME:-Mox}"
export BOT_URL="$MOX_URL"
MC_HOST="${MC_HOST:-}"

usage() {
  cat <<'EOF'
Usage: scripts/proc-nav-trial.sh <phase>

Phases:
  preflight       proc-nav-preflight.sh + offline capstone preflight (adapted)
  prep-map        document spike / materialize via scenario-agent-test path
  prep-board      reset-proc-nav-lab + setup-role-profiles + prep marks
  dispatcher      wheat-dispatcher with BOARD=proc-nav-lab
  baseline        Phase B agent-test (scouting.overlook tactical spec)
  run-core        proc-scout create/watch/evaluate
  run-road        proc-scout-road two-bot (Mox+Pip); run setup-proc-nav-dual-bot in prep-board
  run-stress      proc-scout-stress (requires baseline+core scorecards green)
  evaluate        evaluate-only for RUN_ID
  report          cat scorecard + spatial map path
  verify-fast     pytest + run_proc_nav dry-run + optional anchor verifier (no MC)
  mvtp-bots       rcon mvtp Mox(+Pip) into proc-nav (see proc-nav-mvtp-bots.py)
  smoke-dual-mc   curl Mox+Pip /status — confirm bots before road trial
  feedback1|synthesize1|improve1  W2-style loop (proc-nav postmortems)
  improve-issue   seed one IMPROVE+REVIEW (ISSUE_ID=W2-NAV-004 RUN_ID=...)
  teardown        kill dispatcher + reset-proc-nav-lab (no wheat reset)

Env: RUN_ID, BOARD, PROC_NAV_GRAPH, MOX_URL, AGENT_SPEC (baseline override)
EOF
}

log() { printf '[proc-nav-trial] %s\n' "$*"; }

_pin_run_id() {
  [[ -n "${RUN_ID:-}" ]] && printf '%s\n' "$RUN_ID" > /tmp/proc-nav-run-id
}

_scorecard_band() {
  local rid="$1"
  local sc="$REPO_ROOT/data/postmortems/proc-nav-lab/$rid/scorecard.json"
  [[ -f "$sc" ]] || { echo "fail"; return; }
  python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('band','fail'))" "$sc"
}

case "${1:-}" in
  preflight)
    scripts/proc-nav-preflight.sh
    BOARD="$BOARD" python3 prototypes/agent-arch/capstone/run_proc_nav.py \
      --dry-run --board "$BOARD" --graph proc-scout
    ;;
  prep-map)
    log "Ensure server.local.yaml world.name=proc-nav; materialize with:"
    log "  AGENT_SPEC=data/agent-tests/topics/scouting/overlook-survey-proc-nav.yaml \\"
    log "  BOT_URL=$MOX_URL MC_USERNAME=Mox scripts/scenario-agent-test.sh scouting.overlook -- --dry-run"
    log "Spike: python3 -m mapcatalog try -r requirements/scenario_scout_overlook.yaml -s server.local.yaml --seed <N> --json-full"
    ;;
  prep-board)
    _pin_run_id
    scripts/reset-proc-nav-lab.sh
    KANBAN_BOARD="$BOARD" prototypes/agent-arch/setup-role-profiles.sh
    # The proc-scout graph's pn-plan/pn-plan-2 cards target the planner role;
    # without this, the dispatcher cannot claim them. Engineer + overseer only
    # if Phase E runs in the same session (idempotent, so cheap to always run).
    KANBAN_BOARD="$BOARD" prototypes/agent-arch/setup-planner-w2.sh
    if [[ "${PROC_NAV_WITH_DESK:-0}" == "1" ]]; then
      KANBAN_BOARD="$BOARD" prototypes/agent-arch/setup-engineer-w2.sh
      KANBAN_BOARD="$BOARD" prototypes/agent-arch/setup-overseer-w2.sh
    fi
    if [[ "${PROC_NAV_DUAL_BOT:-0}" == "1" ]] || [[ "${PROC_NAV_GRAPH:-}" == "proc-scout-road" ]]; then
      KANBAN_BOARD="$BOARD" prototypes/agent-arch/setup-proc-nav-dual-bot.sh
      log "dual-bot profiles: navigator=Mox builder=Pip"
    fi
    python3 scripts/prep-proc-scout-marks.py --ports "3007,3005,3004" \
      || log "WARN: marks prep failed (bots down?)"
    if [[ "${PROC_NAV_SKIP_MVTP:-}" != "1" ]]; then
      bots="mox"
      [[ "${PROC_NAV_DUAL_BOT:-0}" == "1" || "${PROC_NAV_GRAPH:-}" == "proc-scout-road" ]] && bots="mox,pip"
      if python3 scripts/proc-nav-mvtp-bots.py --bots "$bots"; then
        log "mvtp execute bots into proc-nav ($bots)"
      else
        log "WARN: proc-nav-mvtp-bots failed — manual: scripts/proc-nav-trial.sh mvtp-bots"
      fi
    fi
    ;;
  dispatcher)
    _pin_run_id
    DISPATCHER_LOG="${DISPATCHER_LOG:-/tmp/proc-nav-dispatcher-${RUN_ID}.log}"
    if [[ "${PROC_NAV_START_DISPATCHER:-}" == "1" ]]; then
      BOARD="$BOARD" scripts/wheat-dispatcher.sh >>"$DISPATCHER_LOG" 2>&1 &
      echo $! >/tmp/proc-nav-dispatcher-pid
      log "dispatcher pid=$(cat /tmp/proc-nav-dispatcher-pid) log=$DISPATCHER_LOG"
    else
      echo "BOARD=$BOARD scripts/wheat-dispatcher.sh >>\"$DISPATCHER_LOG\" 2>&1 &"
    fi
    ;;
  baseline)
    _pin_run_id
    AGENT_SPEC="${AGENT_SPEC:-data/agent-tests/topics/scouting/overlook-survey-proc-nav.yaml}"
    export AGENT_SPEC
    SENTINEL_DIR="$REPO_ROOT/data/postmortems/proc-nav-lab/$RUN_ID"
    mkdir -p "$SENTINEL_DIR"
    rm -f "$SENTINEL_DIR/baseline-passed"
    if scripts/scenario-agent-test.sh scouting.overlook -- \
         --bot-url "$MOX_URL" --model "${AGENT_TEST_MODEL:-deepseek/deepseek-v4-flash:exacto}"; then
      printf 'RUN_ID=%s\nAGENT_SPEC=%s\ntimestamp=%s\n' \
        "$RUN_ID" "$AGENT_SPEC" "$(date -Iseconds)" > "$SENTINEL_DIR/baseline-passed"
      log "baseline PASS — sentinel: $SENTINEL_DIR/baseline-passed"
    else
      rc=$?
      log "baseline FAIL (exit $rc) — no sentinel written"
      exit "$rc"
    fi
    ;;
  run-core|run-stress|run-road)
    _pin_run_id
    graph="proc-scout"
    [[ "$1" == run-stress ]] && graph="proc-scout-stress"
    if [[ "$1" == run-road ]]; then
      graph="proc-scout-road"
      export PROC_NAV_GRAPH=proc-scout-road PROC_NAV_DUAL_BOT=1
      if [[ "${PROC_NAV_SKIP_PREFLIGHT:-}" != "1" ]]; then
        PROC_NAV_GRAPH=proc-scout-road PROC_NAV_DUAL_BOT=1 scripts/proc-nav-preflight.sh || exit 1
      fi
    fi
    if [[ "$graph" == proc-scout-stress ]]; then
      base="${PROC_NAV_BASELINE_RUN_ID:-}"
      core="${PROC_NAV_CORE_RUN_ID:-$RUN_ID}"
      base_sentinel="$REPO_ROOT/data/postmortems/proc-nav-lab/$base/baseline-passed"
      if [[ -z "$base" ]]; then
        log "run-stress blocked: PROC_NAV_BASELINE_RUN_ID unset (baseline RUN_ID that produced baseline-passed sentinel)"
        exit 2
      fi
      if [[ ! -f "$base_sentinel" ]]; then
        log "run-stress blocked: baseline sentinel missing at $base_sentinel"
        log "  re-run: RUN_ID=$base scripts/proc-nav-trial.sh baseline"
        exit 2
      fi
      if [[ "$(_scorecard_band "$core")" != "pass" ]]; then
        log "run-stress blocked: core scorecard band != pass for RUN_ID=$core"
        exit 2
      fi
      log "stress gate OK: baseline=$base core=$core"
    fi
    python3 prototypes/agent-arch/capstone/run_proc_nav.py \
      --run-id "$RUN_ID" --board "$BOARD" --graph "$graph" --create-only
    # proc-nav-1781079999: road tier needs a longer watch budget than the
    # 2h default. Per-tier overrides + a `|| true` so a timeout doesn't
    # `set -e`-kill evaluate-only (the prior trial finished build but
    # never reached the scorecard).
    if [[ "$graph" == proc-scout-road ]]; then
      watch_timeout="${PROC_NAV_WATCH_TIMEOUT:-14400}"
    elif [[ "$graph" == proc-scout-stress ]]; then
      watch_timeout="${PROC_NAV_WATCH_TIMEOUT:-7200}"
    else
      watch_timeout="${PROC_NAV_WATCH_TIMEOUT:-3600}"
    fi
    python3 prototypes/agent-arch/capstone/run_proc_nav.py \
      --run-id "$RUN_ID" --board "$BOARD" --watch --mox-url "$MOX_URL" \
      --watch-timeout "$watch_timeout" \
      || log "watch returned non-zero (timeout or all-terminal-with-failures); continuing to evaluate"
    python3 prototypes/agent-arch/capstone/run_proc_nav.py \
      --run-id "$RUN_ID" --board "$BOARD" --evaluate-only
    sc="$REPO_ROOT/data/postmortems/proc-nav-lab/$RUN_ID/scorecard.json"
    if [[ -f "$sc" ]]; then
      map_path="$(python3 -c "import json; print(json.load(open('$sc')).get('spatial_map_path',''))" 2>/dev/null || true)"
      log "spatial-map: ${map_path:-<missing>}"
    fi
    log "learnings: while dispatcher still up → RUN_ID=$RUN_ID scripts/proc-nav-trial.sh feedback1 && scripts/proc-nav-trial.sh synthesize1"
    if [[ "${PROC_NAV_AUTO_FEEDBACK:-}" == "1" ]]; then
      roles="${PROC_NAV_FEEDBACK_ROLES:-navigator,navigator-pip,builder,builder-mox,planner}"
      scripts/collect-trial-feedback.sh --run-id "$RUN_ID" --board "$BOARD" \
        --roles "$roles" \
        --out "$REPO_ROOT/data/postmortems/proc-nav-lab/$RUN_ID" || log "WARN: feedback partial"
      python3 scripts/synthesize-trial-feedback.py --run-id "$RUN_ID" \
        --out-dir "$REPO_ROOT/data/postmortems/proc-nav-lab/$RUN_ID" \
        --registry "$REPO_ROOT/data/postmortems/proc-nav-lab/_known_issues.json" \
        --scorecard "$sc" || true
    fi
    ;;
  evaluate)
    python3 prototypes/agent-arch/capstone/run_proc_nav.py \
      --run-id "$RUN_ID" --board "$BOARD" --evaluate-only \
      ${PROC_NAV_EVALUATE_TESTER:+--evaluate-tester}
    ;;
  report)
    sc="$REPO_ROOT/data/postmortems/proc-nav-lab/$RUN_ID/scorecard.json"
    cat "$sc" 2>/dev/null || { log "no scorecard for $RUN_ID"; exit 1; }
    ;;
  verify-fast)
    PY="${REPO_ROOT}/.venv/bin/pytest"
    [[ -x "$PY" ]] || PY=pytest
    log "pytest proc-nav contract tests"
    "$PY" -q \
      prototypes/agent-arch/tests/test_proc_nav_graph.py \
      prototypes/agent-arch/tests/test_proc_nav_road_graph.py \
      scripts/tests/test_agent_test_from_map_bot_username.py \
      scripts/tests/test_proc_nav_mvtp_bots.py \
      ${PROC_NAV_EXTRA_PYTEST:-}
    log "run_proc_nav dry-run"
    python3 prototypes/agent-arch/capstone/run_proc_nav.py \
      --dry-run --board "$BOARD" --graph "${PROC_NAV_GRAPH:-proc-scout}"
    anchor_script="${PROC_NAV_ANCHOR_SCRIPT:-data/workspace/production/scripts/proc_nav_anchor_coords.sh}"
    if [[ -f "$REPO_ROOT/$anchor_script" ]]; then
      log "proc-nav-verify-anchor on $anchor_script"
      scripts/proc-nav-verify-anchor.sh "$REPO_ROOT/$anchor_script" || exit 1
    else
      log "skip anchor verifier (no $anchor_script yet — W2-NAV-001)"
    fi
    if [[ -f "$REPO_ROOT/scripts/tests/test_agent_test_tool_counter.py" ]]; then
      log "agent-test tool counter tests"
      "$PY" -q scripts/tests/test_agent_test_tool_counter.py
    fi
    log "verify-fast OK"
    ;;
  improve-issue)
    issue="${ISSUE_ID:-W2-NAV-004}"
    rid="${RUN_ID:-proc-nav-1780956289}"
    BOARD="$BOARD" scripts/seed-w2-improve-cards.sh "$issue" "$rid"
    ;;
  mvtp-bots)
    bots="${PROC_NAV_MVTP_BOTS:-mox,pip}"
    python3 scripts/proc-nav-mvtp-bots.py --bots "$bots" ${PROC_NAV_MVTP_DRY:+--dry-run}
    ;;
  smoke-dual-mc)
    for url in "${MOX_URL:-http://127.0.0.1:3007}" "${PIP_URL:-http://127.0.0.1:3005}"; do
      body="$(curl -sf "$url/status?lean=true")" || { log "FAIL curl $url"; exit 1; }
      user="$(printf '%s' "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('data') or d).get('username','?'))")"
      log "OK $url username=$user"
    done
    log "smoke-dual-mc OK — confirm Pip worker MC_API_URL from session after first pip card (004)"
    ;;
  feedback1)
    roles="${PROC_NAV_FEEDBACK_ROLES:-navigator,navigator-pip,builder,builder-mox,planner}"
    scripts/collect-trial-feedback.sh --run-id "$RUN_ID" --board "$BOARD" \
      --roles "$roles" \
      --out "$REPO_ROOT/data/postmortems/proc-nav-lab/$RUN_ID" || true
    ;;
  synthesize1)
    python3 scripts/synthesize-trial-feedback.py --run-id "$RUN_ID" \
      --out-dir "$REPO_ROOT/data/postmortems/proc-nav-lab/$RUN_ID" \
      --registry "$REPO_ROOT/data/postmortems/proc-nav-lab/_known_issues.json" \
      --scorecard "$REPO_ROOT/data/postmortems/proc-nav-lab/$RUN_ID/scorecard.json"
    ;;
  improve1)
    BOARD="$BOARD" scripts/seed-w2-improve-cards.sh || log "seed improve skipped"
    ;;
  teardown)
    scripts/reset-proc-nav-lab.sh
    ;;
  *)
    usage
    exit 64
    ;;
esac

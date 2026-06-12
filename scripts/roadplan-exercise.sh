#!/usr/bin/env bash
# Phase 3 — single planner-agent road exercise (adaptive-road-planning §8.3).
#
# Hands the WHOLE loop to a real Hermes agent (not an operator): it loads the
# road-planner skill and drives sample -> solve -> confirm -> light unaided,
# using `roadplan` (emit) + `mc` (act). This script only sets the stage and
# checks the result; the agent does the planning.
#
#   scripts/roadplan-exercise.sh <START x,z> <END x,z> [y_hint]
#     [--bot Mox] [--port 3007] [--world proc-nav]
#     [--setup-only] [--verify-only] [--no-verify]
#
# Phases: setup (fresh ledger, torches, peaceful+day, tp to start, sync skill,
# write prompt) -> launch agent (foreground; you watch it work) -> gate
# (scripts/roadplan-verify-chain.py: converged + confirmed + torches natural).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

BOT="Mox"; PORT="3007"; WORLD="proc-nav"
SETUP_ONLY=0; VERIFY_ONLY=0; DO_VERIFY=1
POSARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bot) BOT="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --world) WORLD="$2"; shift 2;;
    --setup-only) SETUP_ONLY=1; shift;;
    --verify-only) VERIFY_ONLY=1; shift;;
    --no-verify) DO_VERIFY=0; shift;;
    *) POSARGS+=("$1"); shift;;
  esac
done
START="${POSARGS[0]:?Usage: roadplan-exercise.sh START_x,z END_x,z [y_hint]}"
END="${POSARGS[1]:?Usage: roadplan-exercise.sh START_x,z END_x,z [y_hint]}"
YHINT="${POSARGS[2]:-66}"

LEDGER="/tmp/roadplan-exercise-${BOT}"
AGENT_HOME="$HOME/.hermes-roadplanner-${BOT,,}"
PROMPT_FILE="$LEDGER/planner-prompt.txt"
export PATH="$REPO/bin:$PATH"
export HERMES_PLATFORM="${HERMES_PLATFORM:-hermescraft}"
PY="$REPO/.venv/bin/python3"; [ -x "$PY" ] || PY=python3
sx="${START%,*}"; sz="${START#*,}"

log() { printf '\033[36m[exercise]\033[0m %s\n' "$*"; }

rcon() { "$PY" - "$@" <<'PY'
import sys
sys.path.insert(0, ".")
from pathlib import Path
from mapcatalog.rcon_client import make_rcon
from mapcatalog.server_config import load_server_config
c = make_rcon(load_server_config(Path("server.local.yaml")))
print(c.run_batch(list(sys.argv[1:])))
PY
}

setup() {
  log "bot health check on :$PORT"
  curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null || { echo "bot not up on :$PORT"; exit 1; }
  log "roadplan preflight"
  roadplan preflight >/dev/null || { echo "roadplan preflight failed"; exit 1; }
  log "fresh ledger $LEDGER"
  rm -rf "$LEDGER"; mkdir -p "$LEDGER"
  log "sync skills into agent home $AGENT_HOME"
  mkdir -p "$AGENT_HOME/memories" "$AGENT_HOME/sessions" "$AGENT_HOME/skills/gaming"
  QUIET=1 "$REPO/scripts/sync-skills.sh" "$AGENT_HOME/skills/gaming" >/dev/null
  log "world: peaceful + day, provision $BOT with torches, tp to start ($sx,$sz)"
  # mvtp first — after a regen the bot is in the hub world; an in-world `tp`
  # can't cross worlds. Then settle the bot at the start (loads chunks).
  rcon "mvtp $BOT $WORLD" >/dev/null; sleep 2
  # tp to just above the rough ground (y_hint+3), NOT y=100 — a long drop over
  # water/gaps kills the bot and it respawns at worldspawn (the ocean spire on
  # this seed). setworldspawn at the start keeps any respawn local.
  rcon \
    "execute in $WORLD run difficulty peaceful" \
    "execute in $WORLD run gamerule doMobSpawning false" \
    "execute in $WORLD run gamerule doDaylightCycle false" \
    "execute in $WORLD run time set day" \
    "execute in $WORLD run kill @e[type=!minecraft:player]" \
    "execute in $WORLD run give $BOT minecraft:torch 64" \
    "execute in $WORLD run setworldspawn $sx $YHINT $sz" \
    "execute in $WORLD run tp $BOT $sx $((YHINT+3)) $sz" >/dev/null
  sleep 3
  write_prompt
  log "prompt written to $PROMPT_FILE"
}

write_prompt() {
  cat > "$PROMPT_FILE" <<EOF
You are ${BOT}, a road planner in Minecraft. Plan a SAFE, WALKABLE route
between two points and stake it with a torch chain. You decide the route; the
tools do the geometry and the world.

The bot ${BOT} is ALREADY running and connected — your \`mc\` commands act on
it directly (MC_API_URL and MC_USERNAME are set for you). Do NOT start, spawn,
or manage bots; do NOT use roster, landfolk, profiles, or any other scripts.
The ONLY commands you need are \`roadplan\` and \`mc\` — don't explore the repo.
Run \`mc status\` first to confirm the bot responds, then begin.

START: ${START}      END: ${END}      (rough ground elevation ~${YHINT})

FIRST, load your playbook: run \`skill_view road-planner\` and follow its loop
exactly. The \`roadplan\` and \`mc\` commands are already on your PATH — run
them with the terminal tool. \`roadplan\` PRINTS the \`mc\` commands to run; run
each printed line verbatim and pipe its \`--json\` output back into
\`roadplan ingest\` exactly as printed. Pass \`--ledger ${LEDGER}\` to EVERY
roadplan call. Use \`--y-hint ${YHINT}\` on the first sample.

The loop: \`roadplan sample\` (run its lines, repeat until it prints
\`converged\`) -> \`roadplan solve\` -> \`roadplan render\` (sanity check) ->
\`roadplan confirm --bot ${BOT}\` (run its blocks, repeat until all waypoints
confirmed).

STOP when \`roadplan confirm\` reports all waypoints confirmed. If \`confirm\`
REFUSES because the route needs construction, report that the route needs the
build role and stop — do not force it. Never place any block except the
torches \`mc waypoint\` places; never build ground under a torch.
EOF
}

launch() {
  local model provider
  model="$("$REPO/scripts/resolve-agent-model.py" entrypoint run_landfolk_agent model "$REPO/data/agent-models.json")"
  provider="$("$REPO/scripts/resolve-agent-model.py" entrypoint run_landfolk_agent provider "$REPO/data/agent-models.json")"
  log "launching planner agent ($model/$provider) — it drives the loop now"
  # Provider API keys (OPENROUTER_API_KEY etc.) live in ~/.hermes/.env;
  # load them so the agent's provider resolves, same as hermescraft.sh.
  # shellcheck disable=SC1091
  . "$REPO/scripts/load-hermes-env.sh"
  unset ANTHROPIC_API_KEY ANTHROPIC_TOKEN CLAUDE_CODE_OAUTH_TOKEN || true
  env HERMES_HOME="$AGENT_HOME" \
      MC_API_URL="http://localhost:${PORT}" MC_USERNAME="$BOT" \
      hermes chat --yolo -q "$(cat "$PROMPT_FILE")" \
      -t terminal,memory,skills -s road-planner \
      -m "$model" --provider "$provider"
}

verify() {
  log "gate: verify chain (converged + confirmed + torches on natural ground)"
  "$PY" "$REPO/scripts/roadplan-verify-chain.py" --ledger "$LEDGER" --world "$WORLD"
}

if [ "$VERIFY_ONLY" = 1 ]; then verify; exit $?; fi
setup
if [ "$SETUP_ONLY" = 1 ]; then
  log "setup-only: prompt + stage ready. Launch with --verify-only later, or rerun without --setup-only."
  exit 0
fi
launch
[ "$DO_VERIFY" = 1 ] && verify

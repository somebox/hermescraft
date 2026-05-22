#!/usr/bin/env bash
set -euo pipefail

NAME="${1:?Usage: run-landfolk-agent.sh NAME API_PORT PROMPT_FILE HOME_DIR}"
API_PORT="${2:?Usage: run-landfolk-agent.sh NAME API_PORT PROMPT_FILE HOME_DIR}"
PROMPT_FILE="${3:?Usage: run-landfolk-agent.sh NAME API_PORT PROMPT_FILE HOME_DIR}"
AGENT_HOME="${4:?Usage: run-landfolk-agent.sh NAME API_PORT PROMPT_FILE HOME_DIR}"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_MODELS_JSON="${AGENT_MODELS_JSON:-$SCRIPT_DIR/data/agent-models.json}"
RESOLVE_AM="$SCRIPT_DIR/scripts/resolve-agent-model.py"
MODEL="${MODEL:-$("$RESOLVE_AM" entrypoint run_landfolk_agent model "$AGENT_MODELS_JSON")}"
PROVIDER="${PROVIDER:-$("$RESOLVE_AM" entrypoint run_landfolk_agent provider "$AGENT_MODELS_JSON")}"
cd "$SCRIPT_DIR"

# Do not override Anthropic auth here.
# Let Hermes resolve credentials naturally (e.g. ~/.claude/.credentials.json).
unset ANTHROPIC_API_KEY || true
unset ANTHROPIC_TOKEN || true
unset CLAUDE_CODE_OAUTH_TOKEN || true

export PATH="$SCRIPT_DIR/bin:$PATH"

until curl -sf "http://localhost:${API_PORT}/health" >/dev/null 2>&1; do
  echo "[$NAME] waiting for bot body on port ${API_PORT}..."
  sleep 1
done

PROMPT="$(cat "$PROMPT_FILE")"

echo "[$NAME] starting Hermes on port ${API_PORT} using ${MODEL}/${PROVIDER}"
# exec so the bash wrapper IS replaced by hermes — meta.json's agent_pid
# then points at the real python process. Without exec, the bash wrapper
# forks hermes as a child, and killing the wrapper orphans the python
# process (the bug behind exp.sh stop leaving 4+ stale hermes chats running).
exec env HERMES_HOME="$AGENT_HOME" MC_API_URL="http://localhost:${API_PORT}" MC_USERNAME="$NAME" hermes chat --yolo -q "$PROMPT" -m "$MODEL" --provider "$PROVIDER"

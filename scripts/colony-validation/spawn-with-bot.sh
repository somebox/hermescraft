#!/usr/bin/env bash
# Spawn seam: inject per-card MC env from data/bots/<name>.yaml.
#
# Stand-in for Section F of docs/architecture/impact.md. NOT production
# code — the contract this honours is what the eventual Hermes spawn
# hook will need to honour when it replaces this layer.
#
# Usage:
#   spawn-with-bot.sh --bot <name>     -- <worker-cmd> [args...]
#   spawn-with-bot.sh --task-id <id> [--board <board>] -- <worker-cmd> [args...]
#
# Behavior:
#   - Resolves the bot from --bot, or by parsing the title prefix
#     `[bot:<name>]` of the card identified by --task-id (matches
#     plugins/landfolk/landfolk/orchestrator/mutex_key.py).
#   - Looks up <BOT_REGISTRY_DIR>/<bot>.yaml (defaults to
#     <repo>/data/bots/), reads api_port + username.
#   - Exports MC_API_URL=http://127.0.0.1:<port> and MC_USERNAME=<name>.
#     These OVERRIDE any values in the parent env (matches the
#     precedence rule in bot/cli/api-url.mjs for kanban workers).
#   - exec's the remaining args as the worker invocation. If no command
#     given, prints the resolved env vars and exits 0 (for inspection).
#
# Failure modes (all non-zero, stderr names the cause):
#   - 64: bad CLI usage
#   - 65: no bot resolvable
#   - 66: registry yaml missing
#   - 67: yaml missing required fields
set -euo pipefail

BOT=""
TASK_ID=""
BOARD=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REGISTRY_DIR="${BOT_REGISTRY_DIR:-$REPO_ROOT/data/bots}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot)
      [[ $# -ge 2 ]] || { echo "spawn-with-bot: --bot needs a value" >&2; exit 64; }
      BOT="$2"; shift 2 ;;
    --task-id)
      [[ $# -ge 2 ]] || { echo "spawn-with-bot: --task-id needs a value" >&2; exit 64; }
      TASK_ID="$2"; shift 2 ;;
    --board)
      [[ $# -ge 2 ]] || { echo "spawn-with-bot: --board needs a value" >&2; exit 64; }
      BOARD="$2"; shift 2 ;;
    --)
      shift; break ;;
    -h|--help)
      sed -n '2,32p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)
      echo "spawn-with-bot: unknown arg: $1" >&2; exit 64 ;;
  esac
done

# Resolve bot from task title if --bot not given. Mirrors mutex_key.py's
# `[bot:<name>]` prefix regex so the contract is symmetric: the mutex
# domain a card lives in is the same bot the spawn seam binds.
if [[ -z "$BOT" && -n "$TASK_ID" ]]; then
  if ! command -v hermes >/dev/null 2>&1; then
    echo "spawn-with-bot: --task-id given but 'hermes' CLI not on PATH" >&2
    exit 65
  fi
  show_args=("kanban" "show" "$TASK_ID" "--json")
  [[ -n "$BOARD" ]] && show_args+=("--board" "$BOARD")
  if ! card_json=$(hermes "${show_args[@]}" 2>/dev/null); then
    echo "spawn-with-bot: failed to read card $TASK_ID via hermes kanban show" >&2
    exit 65
  fi
  BOT=$(python3 - "$card_json" <<'PY'
import json, re, sys
data = json.loads(sys.argv[1])
title = data.get("title", "") or ""
m = re.match(r"^\s*\[bot:([a-z0-9_]+)\]", title, re.IGNORECASE)
print(m.group(1).lower() if m else "")
PY
)
fi

if [[ -z "$BOT" ]]; then
  echo "spawn-with-bot: no bot resolved (pass --bot, or a task whose title starts with [bot:<name>])" >&2
  exit 65
fi

YAML_PATH="$REGISTRY_DIR/$BOT.yaml"
if [[ ! -f "$YAML_PATH" ]]; then
  echo "spawn-with-bot: missing $YAML_PATH (no entry for bot=$BOT in registry $REGISTRY_DIR)" >&2
  exit 66
fi

# Parse api_port + username via PyYAML. The script emits KEY=VALUE lines
# (or exits non-zero with stderr) so bash can apply them via export.
# Note: `var=$(...)` does not honour `set -e` on failure, and the
# `if ! var=$(...); then exit $?` pattern loses the inner rc through the
# `!` inversion — so we capture the rc explicitly and propagate.
parsed=$(python3 - "$YAML_PATH" <<'PY'
import sys, yaml
path = sys.argv[1]
with open(path) as f:
    data = yaml.safe_load(f) or {}
if not isinstance(data, dict):
    sys.stderr.write(f"spawn-with-bot: {path} did not parse as a mapping\n")
    sys.exit(67)
missing = [k for k in ("api_port", "username") if k not in data]
if missing:
    sys.stderr.write(
        f"spawn-with-bot: {path} missing required fields: {','.join(missing)}\n"
    )
    sys.exit(67)
try:
    port = int(data["api_port"])
except (TypeError, ValueError):
    sys.stderr.write(f"spawn-with-bot: {path} api_port not an integer\n")
    sys.exit(67)
username = str(data["username"]).strip()
if not username:
    sys.stderr.write(f"spawn-with-bot: {path} username is empty\n")
    sys.exit(67)
print(f"MC_API_URL=http://127.0.0.1:{port}")
print(f"MC_USERNAME={username}")
PY
) || parse_rc=$?
if [[ -n "${parse_rc:-}" ]]; then
  exit "$parse_rc"
fi

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  export "$line"
done <<< "$parsed"

if [[ $# -eq 0 ]]; then
  # No worker command — print resolved env for inspection.
  echo "MC_API_URL=$MC_API_URL"
  echo "MC_USERNAME=$MC_USERNAME"
  exit 0
fi

exec "$@"

#!/usr/bin/env bash
# Sourced helper: populates ANTHROPIC_API_KEY and OPENROUTER_API_KEY from
# $HOME/.hermes/.env so launch scripts don't have to grep manually.
# Also populates LOG_DIR from config/hermescraft.yaml when not already set.
#
# Usage (from a launch script):
#   . "$SCRIPT_DIR/scripts/load-hermes-env.sh"
#
# Idempotent. Silent when ~/.hermes/.env is absent. Does not touch the repo
# .env — scripts that need PAPERMCP_TOKEN should still `set -a; . "$ROOT/.env"`
# explicitly (see scripts/landfolk-control.sh for the pattern).

if [ -f "$HOME/.hermes/.env" ]; then
  _AN=$(grep "^ANTHROPIC_API_KEY=" "$HOME/.hermes/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
  [ -n "${_AN:-}" ] && export ANTHROPIC_API_KEY="$_AN"
  _OR=$(grep "^OPENROUTER_API_KEY=" "$HOME/.hermes/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
  [ -n "${_OR:-}" ] && export OPENROUTER_API_KEY="$_OR"
  unset _AN _OR
fi

# Populate LOG_DIR from the central config if the caller hasn't set it.
# Best-effort: requires python3 + pyyaml; on systems without them the
# launch scripts' own defaults (typically /tmp/hermescraft) apply.
if [ -z "${LOG_DIR:-}" ]; then
  _LOADER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _CFG_YAML="$_LOADER_DIR/../config/hermescraft.yaml"
  if [ -f "$_CFG_YAML" ] && command -v python3 >/dev/null 2>&1; then
    _LD=$(python3 -c "
import sys, yaml
try:
    cfg = yaml.safe_load(open('$_CFG_YAML'))
    print((cfg or {}).get('logging', {}).get('dir', ''))
except Exception:
    pass
" 2>/dev/null)
    [ -n "${_LD:-}" ] && export LOG_DIR="$_LD"
    unset _LD
  fi
  unset _LOADER_DIR _CFG_YAML
fi

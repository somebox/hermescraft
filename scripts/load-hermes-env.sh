#!/usr/bin/env bash
# Sourced helper: populates ANTHROPIC_API_KEY and OPENROUTER_API_KEY from
# $HOME/.hermes/.env so launch scripts don't have to grep manually.
#
# Usage (from a launch script):
#   . "$SCRIPT_DIR/scripts/load-hermes-env.sh"
#
# Idempotent. Silent when ~/.hermes/.env is absent. Does not touch the repo
# .env — scripts that need PAPERMCP_TOKEN should still `set -a; . "$ROOT/.env"`
# explicitly (see scripts/landfolk-bodies-only.sh for the pattern).

if [ -f "$HOME/.hermes/.env" ]; then
  _AN=$(grep "^ANTHROPIC_API_KEY=" "$HOME/.hermes/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
  [ -n "${_AN:-}" ] && export ANTHROPIC_API_KEY="$_AN"
  _OR=$(grep "^OPENROUTER_API_KEY=" "$HOME/.hermes/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
  [ -n "${_OR:-}" ] && export OPENROUTER_API_KEY="$_OR"
  unset _AN _OR
fi

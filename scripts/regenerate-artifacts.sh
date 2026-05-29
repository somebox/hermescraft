#!/usr/bin/env bash
# Regenerate repo artifacts derived from authoritative sources.
#
# Today this is just `docs/mc-cheatsheet.md` (generated from
# `bot/cli/registry.mjs`). Add new generators here as they appear so a
# single call from `landfolk deploy` / genesis bootstrap keeps everything
# fresh.
#
# Usage:
#   scripts/regenerate-artifacts.sh           # verbose
#   scripts/regenerate-artifacts.sh --quiet   # only print on change/error
#
# Behavior:
#   - Non-fatal on a missing generator dependency (e.g. node not installed
#     on this host) — emits a warning and exits 0 so the caller can keep
#     going. Failures inside a generator (syntax error, etc.) DO propagate.
#   - Stable when nothing changed: re-running back-to-back is a no-op.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --quiet|-q) QUIET=1 ;;
    -h|--help)
      sed -n '1,18p' "$0" | tail -n +2
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log() { [ "$QUIET" = 1 ] || echo "[regenerate-artifacts] $*"; }
warn() { echo "[regenerate-artifacts] WARN: $*" >&2; }

# ── mc-cheatsheet.md ──────────────────────────────────────────────────────
regen_cheatsheet() {
  local gen="$ROOT/scripts/gen-mc-cheatsheet.mjs"
  local target="$ROOT/docs/mc-cheatsheet.md"
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found — skipping mc-cheatsheet regen"
    return 0
  fi
  if [ ! -f "$gen" ]; then
    warn "$gen missing — skipping mc-cheatsheet regen"
    return 0
  fi
  local before_sum=""
  [ -f "$target" ] && before_sum=$(shasum "$target" 2>/dev/null | awk '{print $1}')
  node "$gen" >/dev/null
  local after_sum
  after_sum=$(shasum "$target" 2>/dev/null | awk '{print $1}')
  if [ "$before_sum" != "$after_sum" ]; then
    log "mc-cheatsheet.md regenerated (content changed — commit the result)"
  else
    log "mc-cheatsheet.md up to date"
  fi
}

regen_cheatsheet

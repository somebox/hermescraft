#!/usr/bin/env bash
# Regenerate repo artifacts derived from authoritative sources.
#
# Today this is just `docs/reference/mc-cheatsheet.md` (generated from
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
#   - Playbook skills: docs → repo skills/playbook-*.md, then (if present)
#     ~/.hermes/skills/gaming/<name>/SKILL.md for agent-test / Hermes --skills.

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
  local target="$ROOT/docs/reference/mc-cheatsheet.md"
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

sync_playbooks_to_skills() {
  local reg="$ROOT/data/playbooks/registry.yaml"
  local skills="$ROOT/skills"
  if [[ ! -f "$reg" ]]; then
    warn "no registry.yaml — skipping playbook skill sync"
    return 0
  fi
  python3 - "$reg" "$skills" <<'PY'
import re, sys, shutil
from pathlib import Path
reg_path, skills_dir = Path(sys.argv[1]), Path(sys.argv[2])
text = reg_path.read_text(encoding="utf-8")
repo = reg_path.parents[2]
for m in re.finditer(r"doc:\s*(docs/testing/playbooks/catalog/[^\s#]+)", text):
    doc = repo / m.group(1)
    if not doc.is_file():
        continue
    dest = skills_dir / f"playbook-{doc.stem}.md"
    shutil.copy2(doc, dest)
    print(f"  playbook skill: {dest.name}")
PY
  log "playbook docs synced to skills/ (when registry docs exist)"
}

mirror_playbooks_to_hermes_hub() {
  local hub="${HERMES_SKILLS_GAMING:-${HOME}/.hermes/skills/gaming}"
  local parent
  parent="$(dirname "$hub")"
  if [[ ! -d "$parent" ]]; then
    log "no ${parent} — skipping playbook mirror to Hermes hub"
    return 0
  fi
  mkdir -p "$hub"
  local n=0
  local src sk dst
  for src in "$ROOT/skills"/playbook-*.md; do
    [[ -f "$src" ]] || continue
    sk="$(basename "$src" .md)"
    dst="$hub/$sk/SKILL.md"
    mkdir -p "$hub/$sk"
    cp "$src" "$dst"
    log "  hermes hub: $sk → $dst"
    n=$((n + 1))
  done
  if [ "$n" -eq 0 ]; then
    log "no skills/playbook-*.md to mirror (run playbook doc sync first)"
  else
    log "mirrored $n playbook skill(s) under $hub"
  fi
}

sync_playbooks_to_skills
mirror_playbooks_to_hermes_hub

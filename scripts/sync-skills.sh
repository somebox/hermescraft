#!/usr/bin/env bash
# Sync hermescraft/skills/*.md into a target gaming/<name>/SKILL.md tree.
#
# Usage:
#   scripts/sync-skills.sh <target_gaming_dir> [target_gaming_dir ...]
#
# Examples:
#   scripts/sync-skills.sh "$HERMES_HOME/skills/gaming"
#   scripts/sync-skills.sh "$HOME/.hermes/profiles/flint/skills/gaming"
#
# Env:
#   DRY_RUN=1   Print actions, don't copy.
#   QUIET=1     Suppress per-skill messages (only summary printed).
#
# Source list: skills/MANIFEST (one skill name per line, # = comment).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/skills/MANIFEST"
SKILLS_SRC="$ROOT/skills"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <target_gaming_dir> [target_gaming_dir ...]" >&2
  exit 2
fi

if [ ! -f "$MANIFEST" ]; then
  echo "error: manifest not found at $MANIFEST" >&2
  exit 1
fi

dry="${DRY_RUN:-0}"
quiet="${QUIET:-0}"

# Read skill names from MANIFEST (strip comments + whitespace + blanks).
skills=()
while IFS= read -r line || [ -n "$line" ]; do
  name="${line%%#*}"
  # trim leading/trailing whitespace
  name="$(printf '%s' "$name" | awk '{$1=$1;print}')"
  [ -z "$name" ] && continue
  skills+=("$name")
done < "$MANIFEST"

if [ "${#skills[@]}" -eq 0 ]; then
  echo "error: manifest empty: $MANIFEST" >&2
  exit 1
fi

rc=0
for target in "$@"; do
  copied=0
  missing=0
  for sk in "${skills[@]}"; do
    src="$SKILLS_SRC/${sk}.md"
    if [ ! -f "$src" ]; then
      echo "  ✗ missing skill source: $src" >&2
      missing=$((missing+1))
      rc=1
      continue
    fi
    dst_dir="$target/${sk}"
    dst="$dst_dir/SKILL.md"
    if [ "$dry" = "1" ]; then
      [ "$quiet" = "1" ] || echo "  [dry-run] cp $src $dst"
    else
      mkdir -p "$dst_dir"
      cp "$src" "$dst"
      [ "$quiet" = "1" ] || echo "  ✓ $sk → $dst"
    fi
    copied=$((copied+1))
  done
  echo "  ✓ Synced $copied skills → $target${missing:+ ($missing missing)}"
done

exit $rc

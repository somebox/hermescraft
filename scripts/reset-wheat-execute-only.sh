#!/usr/bin/env bash
# Archive execute/feedback cards (any status); preserve W2 registry + workspace.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOARD="${BOARD:-wheat-capstone}"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

log() { printf '[reset-execute] %s\n' "$*"; }

for p in \
  "$REPO_ROOT/data/postmortems/wheat-capstone/_known_issues.json" \
  "$REPO_ROOT/data/postmortems/wheat-capstone/_w2_artifacts.json" \
  "$REPO_ROOT/data/workspace/production"
do
  [[ -e "$p" ]] && log "preserve: $p"
done

archive_if_execute_lane() {
  local tid="$1"
  local title
  title="$(hermes kanban --board "$BOARD" show "$tid" --json 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); t=d.get('task',d); print(t.get('title',''))" 2>/dev/null || echo "")"
  [[ -z "$title" ]] && return 0
  if [[ "$title" == *"[bot:mox]"* ]] || [[ "$title" == FEEDBACK* ]] || [[ "$title" == *"smoke script obedience"* ]]; then
    hermes kanban --board "$BOARD" archive "$tid" 2>/dev/null \
      && log "  archived $tid ($title)"
  fi
}

log "archiving execute-lane cards on board=$BOARD (all statuses)"
card_ids="$(hermes kanban --board "$BOARD" list 2>/dev/null | grep -oE 't_[0-9a-f]+' | sort -u || true)"
if [[ -z "$card_ids" ]]; then
  log "  board empty"
else
  while read -r tid; do
    [[ -n "$tid" ]] && archive_if_execute_lane "$tid"
  done <<< "$card_ids"
fi

log "execute-only reset done (desk IMPROVE/REVIEW/RESEARCH cards left unless titled [bot:mox])"

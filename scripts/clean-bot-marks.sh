#!/usr/bin/env bash
# clean-bot-marks.sh — drop every mark from a bot's marks DB EXCEPT
# the wheat-capstone marks (wheat_plot, wheat_chest, wheat_start) and
# the organic per-bot marks the bot wrote on its own (`spawn` from
# first connect; `death_*` from prior void-falls).
#
# Trial 1780840853 surfaced that Mox carries persistent marks from
# earlier sessions (spawn + 3 death_* marks). They didn't cause that
# particular failure, but a stale `field_south` from an aborted trial
# would silently shadow the new fixture's coords on re-prep — bot
# mark store doesn't dedupe, it overwrites by name. Cleaning before
# each trial keeps the bot's mark list a small, predictable set.
#
# Usage:
#   scripts/clean-bot-marks.sh mox tester                # both bots
#   scripts/clean-bot-marks.sh mox                       # just one
#   KEEP="spawn,death_1,wheat_plot" scripts/clean-bot-marks.sh mox
#
# Env:
#   KEEP — comma-separated list of mark names to preserve. Default
#          drops EVERYTHING (the fixture re-POSTs wheat_* anyway).
#   PORTS — override the default bot:port map below.

set -u

declare -A PORTS=( [mox]=3007 [tester]=3004 [pip]=3005 [zee]=3006 )

KEEP="${KEEP:-}"
if [[ $# -eq 0 ]]; then
  echo "usage: $(basename "$0") <bot> [<bot> ...]" >&2
  echo "  known bots: ${!PORTS[*]}" >&2
  exit 64
fi

for bot in "$@"; do
  port="${PORTS[$bot]:-}"
  if [[ -z "$port" ]]; then
    echo "ERROR: unknown bot '$bot' (no port mapping)" >&2
    exit 64
  fi

  # Fetch current marks
  marks_json=$(curl -sf "http://127.0.0.1:$port/marks" 2>/dev/null)
  if [[ -z "$marks_json" ]]; then
    echo "WARN: $bot (:$port) unreachable — skipping" >&2
    continue
  fi

  # Decide which to drop
  to_drop=$(echo "$marks_json" | python3 -c "
import json, os, sys
keep = {n.strip() for n in os.environ.get('KEEP', '').split(',') if n.strip()}
marks = json.load(sys.stdin).get('data', {}).get('marks', [])
for m in marks:
    name = m.get('name', '')
    if name and name not in keep:
        print(name)
" 2>/dev/null)

  if [[ -z "$to_drop" ]]; then
    echo "$bot (:$port): nothing to drop"
    continue
  fi

  count=0
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    curl -sf -X POST "http://127.0.0.1:$port/action/unmark" \
      -H "content-type: application/json" \
      -d "{\"name\":\"$name\"}" >/dev/null 2>&1 && {
      printf "  %s: dropped %s\n" "$bot" "$name"
      count=$((count + 1))
    } || printf "  %s: FAILED to drop %s\n" "$bot" "$name" >&2
  done <<< "$to_drop"
  echo "$bot (:$port): dropped $count marks"
done

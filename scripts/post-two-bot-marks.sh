#!/usr/bin/env bash
# Post (or unpost) the six two-bot-base marks to a single bot's HTTP API.
# Called from data/test-fixtures/open/two_bot_base.yaml as a `local:`
# command so the fixture doesn't have to repeat the loop body inline.
#
# Marks are hardcoded here because they're tightly coupled to the fixture's
# block coords. If you change the fixture seed, change them here too.
#
# Usage:
#   scripts/post-two-bot-marks.sh post <port>     # POST all 6 marks
#   scripts/post-two-bot-marks.sh unmark <port>   # remove all 6 marks
#
# Unreachable port → echo warning, exit 0 (fixture should tolerate
# bots-not-yet-up at prep time).
set -uo pipefail

ACTION="${1:-}"
PORT="${2:-}"

if [[ -z "$ACTION" || -z "$PORT" ]]; then
  echo "usage: $(basename "$0") <post|unmark> <port>" >&2
  exit 64
fi

# Each line: name:x:y:z:note
MARKS=(
  "seed:300:65:300:demo build site"
  "wood_supply:295:65:300:west chest (64 oak_log)"
  "chest_stash:300:65:305:south chest (axe + pickaxe + signs)"
  "stone_source:310:65:308:south face of SE cobble outcrop"
  "pip_start:298:65:300:pip teleport target"
  "zee_start:302:65:300:zee teleport target"
)

case "$ACTION" in
  post)
    # NB: the mark endpoint requires `at: {x,y,z}` to save at a specific
    # coord; flat top-level x/y/z is ignored and the mark saves at the
    # bot's current position. See bot/lib/runtime/locations.js#resolvePlace.
    for entry in "${MARKS[@]}"; do
      IFS=':' read -r name x y z note <<< "$entry"
      if ! curl -sf --max-time 3 -X POST "http://127.0.0.1:$PORT/action/mark" \
          -H 'content-type: application/json' \
          -d "{\"name\":\"$name\",\"at\":{\"x\":$x,\"y\":$y,\"z\":$z},\"note\":\"$note\"}" \
          >/dev/null; then
        echo "  mark $name → :$PORT unreachable (bot down? warning only)"
      fi
    done
    ;;
  unmark)
    for entry in "${MARKS[@]}"; do
      IFS=':' read -r name x y z note <<< "$entry"
      curl -sf --max-time 3 -X POST "http://127.0.0.1:$PORT/action/unmark" \
        -H 'content-type: application/json' \
        -d "{\"name\":\"$name\"}" >/dev/null || true
    done
    ;;
  *)
    echo "unknown action: $ACTION (want: post | unmark)" >&2
    exit 64
    ;;
esac

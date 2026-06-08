#!/usr/bin/env bash
# Move Tester near the wheat plot so region_blocks / at_mark acceptance
# predicates run with chunks loaded (r4 verify observer prep).
#
# Usage: scripts/prep-wheat-verify-observer.sh
#
# Env: MC_HOST_SSH (default ubuntu-host), MC_DOCKER_NAME (default minecraft)
set -u

MC_HOST_SSH="${MC_HOST_SSH:-ubuntu-host}"
MC_DOCKER_NAME="${MC_DOCKER_NAME:-minecraft}"
# Tester must be (a) adjacent to wheat_chest (-50,65,60) for chest_contains
# verify (≤4 blocks), and (b) close enough to wheat_plot (-50,64,50) for the
# region scan to load chunks. (-50,65,59) is one block south of the chest
# (distance 1) and ~10 blocks from the plot — same 16×16 chunk, so all
# region cells load. Mox goes to wheat_start (-55,65,50) — known dry, out
# of the water hole so it doesn't drown during eval.
TESTER_X=-50
TESTER_Y=65
TESTER_Z=59
MOX_X=-55
MOX_Y=65
MOX_Z=50

log() { printf '[prep-verify-observer] %s\n' "$*"; }

log "tp Tester to dry plot vicinity ($TESTER_X $TESTER_Y $TESTER_Z) in landfolk-test"
if ! ssh -n "$MC_HOST_SSH" "sudo docker exec $MC_DOCKER_NAME rcon-cli 'execute in landfolk-test run tp Tester $TESTER_X $TESTER_Y $TESTER_Z'" 2>&1 \
  | grep -E "Teleported|Error" | sed 's/^/  /'; then
  log "WARN: rcon tp Tester may have failed"
  exit 1
fi

log "tp Mox to wheat_start ($MOX_X $MOX_Y $MOX_Z) in landfolk-test (out of the water hole)"
if ! ssh -n "$MC_HOST_SSH" "sudo docker exec $MC_DOCKER_NAME rcon-cli 'execute in landfolk-test run tp Mox $MOX_X $MOX_Y $MOX_Z'" 2>&1 \
  | grep -E "Teleported|Error" | sed 's/^/  /'; then
  log "WARN: rcon tp Mox may have failed"
  # don't fail — Mox tp is nice-to-have, Tester is the load-bearing one
fi
log "done"
exit 0

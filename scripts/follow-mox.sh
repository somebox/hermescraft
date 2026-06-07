#!/usr/bin/env bash
# follow-mox.sh — thin wrapper around proto-logs-follow.py that always
# targets pilot-mox in the LIVE HERMES_HOME. Two CLI gotchas the
# wrapper hides:
#
#   1. proto-logs-follow.py defaults HERMES_HOME to
#      ~/.hermes-proto-agent-arch (the proto rig), not ~/.hermes
#      where the wheat capstone runs.
#   2. The flag is --profiles (plural), and the default is
#      pilot-pip,pilot-zee — so a bare invocation never sees Mox.
#
# Default mode follows new events in real time (thoughts + tool
# calls + tool responses + bot chat). Common variants:
#
#   scripts/follow-mox.sh                  # follow (default)
#   scripts/follow-mox.sh --reasoning      # include hidden reasoning
#   scripts/follow-mox.sh --tail 50        # backfill last 50, then follow
#   scripts/follow-mox.sh --no-follow --tail 200 --no-color | less
#   scripts/follow-mox.sh -q                # quiet — tool calls + thoughts only
#
# Other log sources for Mox (these are NOT wrapped — use directly):
#   tail -F /tmp/hermescraft/bot-mox.log              # Mineflayer bot HTTP/MC chat
#   tail -F /tmp/wheat-runner-trial-$(cat /tmp/wheat-current-run-id 2>/dev/null).log
#   tail -F /tmp/wheat-dispatcher-trial-$(cat /tmp/wheat-current-run-id 2>/dev/null).log
#   tail -F ~/.hermes/profiles/pilot-mox/logs/agent.log
#   tail -F ~/.hermes/profiles/pilot-mox/logs/errors.log
set -u

cd "$(dirname "$0")/.."

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}" \
  exec scripts/proto-logs-follow.py --profiles pilot-mox "$@"

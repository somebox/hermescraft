#!/usr/bin/env bash
# Smoke alias — see scripts/scenario-agent-test.sh
exec "$(cd "$(dirname "$0")" && pwd)/scenario-agent-test.sh" smoke data/agent-tests/topics/smoke/map-anchor.yaml "$@"

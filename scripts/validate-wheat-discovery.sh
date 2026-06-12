#!/usr/bin/env bash
# Outcome-oriented discovery arena checks (pools + anchors), not fixed 9×9 plot.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAYOUT="$REPO_ROOT/data/tmp/wheat_discovery_layout.json"
[[ -f "$LAYOUT" ]] || { echo "FAIL: missing $LAYOUT — run prep first" >&2; exit 1; }

MC_HOST_SSH="${MC_HOST_SSH:-ubuntu-host}"
MC_DOCKER_NAME="${MC_DOCKER_NAME:-minecraft}"
fail=0

rcon() {
  ssh -n "$MC_HOST_SSH" "sudo docker exec $MC_DOCKER_NAME rcon-cli '$1'" 2>/dev/null
}

block_at() {
  local x="$1" y="$2" z="$3"
  rcon "execute in landfolk-test run data get block $x $y $z" | grep -o 'minecraft:[a-z_]*' | head -1
}

check() {
  local label="$1" want="$2" got="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS $label ($got)"
  else
    echo "FAIL $label want=$want got=$got"
    fail=1
  fi
}

pool_a="$(python3 -c "import json; d=json.load(open('$LAYOUT')); p=d['pool_a']; print(p['x'],p['y'],p['z'])")"
pool_b="$(python3 -c "import json; d=json.load(open('$LAYOUT')); p=d['pool_b']; print(p['x'],p['y'],p['z'])")"
read -r ax ay az <<< "$pool_a"
read -r bx by bz <<< "$pool_b"

check "pool_a water" "minecraft:water" "$(block_at "$ax" "$ay" "$az")"
check "pool_b water" "minecraft:water" "$(block_at "$bx" "$by" "$bz")"

for port in 3007 3004; do
  if curl -sf "http://127.0.0.1:$port/action/status" >/dev/null; then
    echo "PASS bot :$port up"
  else
    echo "FAIL bot :$port not reachable"
    fail=1
  fi
done

exit "$fail"

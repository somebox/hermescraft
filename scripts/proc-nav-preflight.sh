#!/usr/bin/env bash
# Proc-nav trial preflight — proc-nav MV slot + Mox :3007 (not wheat/proc-lab).
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

OK=$'\033[32mOK\033[0m'
MISS=$'\033[31mMISSING\033[0m'
fail=0
say() { printf '  %s  %s\n' "$1" "$2"; }
header() { printf '\n== %s ==\n' "$1"; }

MOX_URL="${MOX_URL:-http://127.0.0.1:3007}"
SERVER="${SERVER:-server.local.yaml}"

header "toolchain"
if [[ "${BASH_VERSINFO[0]:-0}" -ge 5 ]]; then
  say "$OK" "bash ${BASH_VERSION}"
else
  say "$MISS" "bash 5+ required"
  fail=1
fi
if command -v python3 >/dev/null; then
  say "$OK" "python3 $(python3 -V 2>&1)"
else
  say "$MISS" "python3"
  fail=1
fi

header "server.local.yaml"
if [[ -f "$SERVER" ]]; then
  say "$OK" "$SERVER present"
  world_name="$(python3 -c "
import yaml, sys
d=yaml.safe_load(open(sys.argv[1]))
print((d.get('world') or {}).get('name',''))
" "$SERVER" 2>/dev/null || true)"
  if [[ "$world_name" == "proc-nav" ]]; then
    say "$OK" "world.name=proc-nav"
  elif [[ "$world_name" == "proc-lab" ]]; then
    say "$MISS" "world.name is proc-lab — set proc-nav for this program"
    fail=1
  else
    say "$MISS" "world.name=${world_name:-?} (expected proc-nav)"
    fail=1
  fi
  # bot_players gate — mapcatalog try mvtp's listed players before mv delete;
  # if Mox isn't listed, materialize will leave Mox in the old world and the
  # trial sees stale dimension data. The plan called this out as a real risk.
  bot_players="$(python3 -c "
import yaml, sys
d=yaml.safe_load(open(sys.argv[1]))
evac=(d.get('world') or {}).get('evac') or {}
players=evac.get('bot_players') or []
print(','.join(players))
" "$SERVER" 2>/dev/null || true)"
  if [[ ",$bot_players," == *",Mox,"* ]]; then
    say "$OK" "world.evac.bot_players includes Mox"
  else
    say "$MISS" "world.evac.bot_players missing Mox (found: ${bot_players:-<empty>}) — add Mox so materialize mvtp's it out before mv delete"
    fail=1
  fi
else
  say "$MISS" "copy server.local.yaml.example → server.local.yaml"
  fail=1
fi

header "Mox bot"
if curl -sf "$MOX_URL/status?lean=true" >/dev/null 2>&1; then
  say "$OK" "Mox at $MOX_URL"
else
  say "$MISS" "start: MC_HOST=… scripts/colony start mox"
  fail=1
fi

header "scenario pools (optional)"
if [[ "${PROC_NAV_SKIP_POOLS_LINT:-}" != "1" ]] && [[ -x scripts/scenario-pools.sh ]]; then
  if scripts/scenario-pools.sh lint >/dev/null 2>&1; then
    say "$OK" "scenario-pools lint"
  else
    say "$MISS" "scenario-pools lint failed"
    fail=1
  fi
fi

header "summary"
if [[ "$fail" -eq 0 ]]; then
  echo "proc-nav preflight: all green"
  exit 0
fi
echo "proc-nav preflight: fix MISSING items"
exit 1

#!/usr/bin/env bash
# Shared config + helpers for the self-hosted LOCAL HermesCraft Paper server:
# Paper + Multiverse-Core on this machine, rcon over native TCP (no ssh/docker).
# Sourced by local-setup.sh / local-start.sh / local-stop.sh / rcon.sh.
# Distinct from server/start.sh (the hardcore "The Crash" demo on :12345).
set -euo pipefail

# ── Paths ──
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVER_DIR/.." && pwd)"
PAPER_JAR="$SERVER_DIR/paper.jar"
PLUGINS_DIR="$SERVER_DIR/plugins"
PID_FILE="$SERVER_DIR/server.pid"
LOG_FILE="${LOG_FILE:-/tmp/hermescraft/server/paper.log}"

# rcon password lives outside the repo (chmod 600), referenced by configs.
PASS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/hermescraft"
PASS_FILE="$PASS_DIR/local-rcon.pass"

# Python with mcrcon (the test venv); fall back to system python3.
VENV_PY="$REPO_ROOT/.venv/bin/python"
PY="${PY:-$([ -x "$VENV_PY" ] && echo "$VENV_PY" || command -v python3)}"

# ── Server constants (keep in sync with config/hermescraft.yaml $overrides.local) ──
PAPER_VERSION="${PAPER_VERSION:-1.21.4}"
MC_PORT="${MC_PORT:-25565}"
RCON_PORT="${RCON_PORT:-25575}"
JAVA_XMS="${JAVA_XMS:-2G}"
JAVA_XMX="${JAVA_XMX:-4G}"

# Multiverse-managed worlds the test/dev paths expect (so `/execute in <name>`
# resolves to a real dimension key). proc-lab is a scratch world created/
# destroyed by mapcatalog at runtime, so it is not pre-made here.
WORLDS=(landfolk-test proc-lab-bootstrap)

SPIGOT_FILE="$SERVER_DIR/spigot.yml"

# Space-separated players to op for in-game /mv, /tp, /gamemode (offline mode).
# Bots don't need this — the harness drives them via rcon (op-level) + bot HTTP.
OP_PLAYERS="${OP_PLAYERS:-re44}"

# Loosened spigot.yml movement anti-cheat: Mineflayer pathing otherwise trips
# "moved too quickly"/"moved wrongly" and disconnects the bot.
SPIGOT_MOVED_TOO_QUICKLY="${SPIGOT_MOVED_TOO_QUICKLY:-1000.0}"
SPIGOT_MOVED_WRONGLY="${SPIGOT_MOVED_WRONGLY:-4.0}"

log()  { printf '  %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Loosen spigot.yml movement anti-cheat in place (idempotent). Reloads live if up.
patch_spigot_movement() {
  [ -f "$SPIGOT_FILE" ] || { log "spigot.yml not generated yet — skipping anti-cheat patch"; return 0; }
  PY_SPIGOT="$SPIGOT_FILE" TQ="$SPIGOT_MOVED_TOO_QUICKLY" MW="$SPIGOT_MOVED_WRONGLY" "$PY" - <<'PY'
import os, re, pathlib
p = pathlib.Path(os.environ["PY_SPIGOT"]); t = p.read_text()
for key, val in (("moved-too-quickly-multiplier", os.environ["TQ"]),
                 ("moved-wrongly-threshold", os.environ["MW"])):
    t = re.sub(rf'(^\s*{key}:\s*).*$', rf'\g<1>{val}', t, count=1, flags=re.M)
p.write_text(t)
print(f"  patched spigot.yml: moved-too-quickly-multiplier={os.environ['TQ']}, moved-wrongly-threshold={os.environ['MW']}")
PY
  server_is_up && rcon_cmd "spigot reload" >/dev/null 2>&1 && log "spigot reload (anti-cheat live)" || true
}

# Op the configured OP_PLAYERS (no-op if empty). Server must be up.
op_configured_players() {
  [ -n "$OP_PLAYERS" ] || return 0
  for name in $OP_PLAYERS; do
    rcon_cmd "op $name" >/dev/null 2>&1 && log "op'd $name" || log "could not op $name (will apply when they join)"
  done
}

# bukkit.yml connection-throttle (default 4000ms) drops bots on multi-bot
# reconnect storms; set 0. Read at boot, so it applies on next start.
BUKKIT_FILE="$SERVER_DIR/bukkit.yml"
patch_bukkit_throttle() {
  [ -f "$BUKKIT_FILE" ] || { log "bukkit.yml not generated yet — skipping throttle patch"; return 0; }
  PY_BUKKIT="$BUKKIT_FILE" "$PY" - <<'PY'
import os, re, pathlib
p = pathlib.Path(os.environ["PY_BUKKIT"]); t = p.read_text()
t2 = re.sub(r'(^\s*connection-throttle:\s*).*$', r'\g<1>0', t, count=1, flags=re.M)
p.write_text(t2)
print("  patched bukkit.yml: connection-throttle=0 (takes effect on next start)" if t2 != t
      else "  bukkit.yml: connection-throttle already 0")
PY
}

# Canonical landfolk-test settings via vanilla rcon (version-independent, no MV5
# mv-modify dependency): gamerules plus a stone platform at spawn so cross-world
# tp doesn't suffocate the bot. Terrain stays NORMAL (better than FLAT here).
configure_landfolk_test() {
  rcon_cmd \
    "execute in landfolk-test run difficulty peaceful" \
    "execute in landfolk-test run gamerule doDaylightCycle false" \
    "execute in landfolk-test run gamerule doMobSpawning false" \
    "execute in landfolk-test run gamerule doWeatherCycle false" \
    "execute in landfolk-test run gamerule keepInventory true" \
    "execute in landfolk-test run gamerule doImmediateRespawn true" \
    "execute in landfolk-test run time set noon" \
    "execute in landfolk-test run weather clear" \
    "execute in landfolk-test run forceload add 0 0" \
    "execute in landfolk-test run setworldspawn 0 65 0" \
    "execute in landfolk-test run fill -8 64 -8 8 64 8 minecraft:stone" \
    "execute in landfolk-test run fill -8 65 -8 8 70 8 minecraft:air" \
    >/dev/null 2>&1 && log "configured landfolk-test (gamerules, spawn 0,65,0, platform, forceload)"
}

read_rcon_pass() {
  [ -f "$PASS_FILE" ] || die "rcon password file missing: $PASS_FILE (run server/local-setup.sh first)"
  cat "$PASS_FILE"
}

# Send one or more rcon commands (one per arg) via native TCP using mcrcon.
# Usage: rcon_cmd "list" "mv list"
rcon_cmd() {
  local pass; pass="$(read_rcon_pass)"
  RCON_PASS="$pass" RCON_PORT="$RCON_PORT" "$PY" - "$@" <<'PY'
import os, sys
from mcrcon import MCRcon
host = os.environ.get("RCON_HOST", "127.0.0.1")
port = int(os.environ["RCON_PORT"])
with MCRcon(host, os.environ["RCON_PASS"], port=port, timeout=15) as mcr:
    for cmd in sys.argv[1:]:
        out = mcr.command(cmd)
        if out:
            print(out)
PY
}

# True if the server answers rcon (i.e. fully started).
server_is_up() { rcon_cmd "list" >/dev/null 2>&1; }

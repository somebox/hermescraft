#!/usr/bin/env bash
# Op a player for in-game /mv, /tp, /gamemode, etc. (offline mode ops no one by
# default, so /mv is denied until you do this once):
#   server/op.sh <YourMinecraftName>
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local-common.sh"

[ $# -ge 1 ] || die "usage: server/op.sh <player> [<player> ...]"
server_is_up || die "server not responding on rcon :$RCON_PORT (start it first)"
for name in "$@"; do
  out="$(rcon_cmd "op $name")"
  log "${out:-op $name}"
done
log "Re-join (or it applies on next join) if /mv is still denied."

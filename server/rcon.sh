#!/usr/bin/env bash
# Send rcon command(s) to the local Paper server (native TCP via mcrcon).
# Replaces ssh+docker rcon-cli against the old LAN server.
#
# Usage:
#   server/rcon.sh "list"
#   server/rcon.sh "mv list" "time set noon"
#   server/rcon.sh "execute in landfolk-test run setblock 0 64 0 stone"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local-common.sh"

[ $# -ge 1 ] || die "usage: server/rcon.sh <command> [<command> ...]"
server_is_up || die "server not responding on rcon :$RCON_PORT (is it started?)"
rcon_cmd "$@"

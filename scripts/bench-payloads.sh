#!/usr/bin/env bash
# bench-payloads.sh — measure mc CLI / endpoint response sizes.
#
# Usage:
#   scripts/bench-payloads.sh [BOT_URL]   # default: http://localhost:3001
#
# Prints each endpoint's size in bytes against the bot's CURRENT scene.
# Run this against a realistic test scene (e.g. mid-G-test) so the
# numbers reflect what agents actually see.

set -euo pipefail

BASE="${1:-http://localhost:3001}"

probe() {
  local url="$1"
  local label="$2"
  local bytes
  bytes=$(curl -s "${BASE}${url}" 2>/dev/null | wc -c | tr -d ' ')
  printf '  %-30s  %s bytes\n' "$label" "$bytes"
}

echo "Payload sizes against ${BASE}:"
echo ""
echo "Read-only endpoints"
probe "/health"                  "/health"
probe "/inventory"               "/inventory"
probe "/look"                    "/look"
probe "/map"                     "/map (default r=16)"
probe "/nearby"                  "/nearby (default r=32)"
probe "/scene"                   "/scene (default r=16)"
echo ""
echo "Status / observe (lean vs full)"
probe "/status?lean=true"        "/status?lean=true"
probe "/status"                  "/status"
probe "/observe?lean=true"       "/observe?lean=true"
probe "/observe"                 "/observe"

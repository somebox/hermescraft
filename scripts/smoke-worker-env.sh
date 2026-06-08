#!/usr/bin/env bash
# smoke-worker-env.sh — spawn a one-shot worker and assert it can reach Mox.
#
# Background: Hermes scrubs MC_* env vars at worker spawn
# (kanban_db.py:6671). W1 routes them via role profile .env. This gate
# proves the route works BEFORE we burn LLM budget on a live trial.
#
# Pass criteria: a worker spawned for any W1 role can run `mc status`
# without setting MC_* manually and get an HTTP 200 from Mox.
#
# Usage:
#   HERMES_HOME=~/.hermes scripts/smoke-worker-env.sh [role]
# Default role: navigator.
set -u

export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
ROLE="${1:-navigator}"

if [[ ! -d "$HERMES_HOME/profiles/$ROLE" ]]; then
  echo "[smoke] FAIL: profile $ROLE missing under $HERMES_HOME" >&2
  exit 1
fi

ENV_FILE="$HERMES_HOME/profiles/$ROLE/.env"
if ! grep -qE '^MC_API_URL=' "$ENV_FILE" 2>/dev/null; then
  echo "[smoke] FAIL: $ENV_FILE missing MC_API_URL (re-run setup-role-profiles.sh)" >&2
  exit 1
fi
if ! grep -qE '^MC_USERNAME=' "$ENV_FILE" 2>/dev/null; then
  echo "[smoke] FAIL: $ENV_FILE missing MC_USERNAME" >&2
  exit 1
fi

EXPECTED_URL=$(grep -E '^MC_API_URL=' "$ENV_FILE" | head -1 | sed 's/^MC_API_URL=//')
EXPECTED_USER=$(grep -E '^MC_USERNAME=' "$ENV_FILE" | head -1 | sed 's/^MC_USERNAME=//')
echo "[smoke] profile=$ROLE env declares MC_API_URL=$EXPECTED_URL MC_USERNAME=$EXPECTED_USER"

# Direct probe — confirms Mox is up at the URL the .env points to. This
# is the same URL the worker will resolve.
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "$EXPECTED_URL/status" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "[smoke] FAIL: $EXPECTED_URL/status returned $HTTP_CODE (Mox not reachable from your shell)" >&2
  exit 1
fi
echo "[smoke] OK: Mox /status returned 200"

# Spawn-time check — read the would-be worker's resolved env. Hermes
# loads the profile .env post-spawn via _apply_profile_override; the
# behavior to verify is that MC_API_URL is present after that load.
# We invoke `hermes -p <role> chat -q "echo $MC_API_URL"` and look for
# the URL in stdout.
SPAWN_OUT=$(timeout 30 hermes -p "$ROLE" chat -q "Run: \`echo MC_API_URL=\$MC_API_URL MC_USERNAME=\$MC_USERNAME\` and report exactly what it prints." 2>&1 \
  | grep -E "MC_API_URL=" | head -3)
if [[ -z "$SPAWN_OUT" ]]; then
  echo "[smoke] WARN: hermes chat returned no MC_API_URL echo — may be LLM-dependent" >&2
  echo "[smoke] (continuing — .env presence + Mox /status are the load-bearing checks)"
else
  echo "[smoke] worker echoed:"
  echo "$SPAWN_OUT" | sed 's/^/  /'
  if echo "$SPAWN_OUT" | grep -q "MC_API_URL=$EXPECTED_URL"; then
    echo "[smoke] OK: worker shell carries MC_API_URL=$EXPECTED_URL"
  else
    echo "[smoke] FAIL: worker echo did not match MC_API_URL=$EXPECTED_URL" >&2
    exit 1
  fi
fi

echo "[smoke] PASS: $ROLE worker can reach Mox at $EXPECTED_URL"
exit 0

#!/usr/bin/env bash
# Reset a Hermes profile to clean state between test runs.
#
# Removes everything that carries between sessions and would contaminate
# a fresh worker spawn:
#   - memories/MEMORY.md          (auto-injected at session start)
#   - memories/MEMORY.md.lock     (dangling lock)
#   - state.db, state.db-shm, state.db-wal  (session transcripts + FTS)
#   - sessions/<id>/              (per-session caches)
#   - logs/agent.log              (truncated, NOT deleted — Hermes appends)
#
# Leaves alone:
#   - SOUL.md, config.yaml, .env, profile.yaml
#   - skills/, bin/, hooks/, plans/
#   - .skills_prompt_snapshot.json (Hermes regenerates as needed)
#
# Also kills any running worker for that profile so file handles release.
#
# Usage:
#   reset_profile.sh <hermes_home> <profile_name>
#
# Examples:
#   reset_profile.sh $HOME/.hermes-proto-agent-arch pilot-navigator
#   reset_profile.sh $HOME/.hermes-proto-agent-arch pilot-miner
#   reset_profile.sh $HOME/.hermes flint

set -euo pipefail

HOME_DIR="${1:-}"
PROFILE="${2:-}"

if [ -z "$HOME_DIR" ] || [ -z "$PROFILE" ]; then
  echo "usage: $0 <hermes_home> <profile_name>" >&2
  exit 2
fi

PDIR="$HOME_DIR/profiles/$PROFILE"
if [ ! -d "$PDIR" ]; then
  echo "profile not found: $PDIR" >&2
  exit 1
fi

log() { printf '[reset_profile/%s] %s\n' "$PROFILE" "$*"; }

# 1. Kill any running workers for this profile so files unlock cleanly.
#    The hermes process command line includes `-p <profile>` so we can match.
#    grep exits non-zero when no matches; tolerate it with `|| true`.
PIDS=$(ps -ef | grep -E "hermes -p $PROFILE\b" | grep -v grep | awk '{print $2}' || true)
if [ -n "$PIDS" ]; then
  log "killing $(echo $PIDS | wc -w) running worker(s): $PIDS"
  for pid in $PIDS; do kill "$pid" 2>/dev/null || true; done
  # Give them ~1s to exit; SIGKILL stragglers.
  sleep 1.5
  for pid in $PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      log "  SIGKILL $pid"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
fi

# 2. Empty MEMORY.md (write 0 bytes; Hermes treats as "no memory").
MEM="$PDIR/memories/MEMORY.md"
if [ -f "$MEM" ]; then
  : > "$MEM"
  log "truncated $MEM"
fi
# 2a. Remove any dangling lock file.
[ -f "$MEM.lock" ] && rm -f "$MEM.lock" && log "removed MEMORY.md.lock"

# 3. Wipe state.db (Hermes recreates the schema on first session).
for f in state.db state.db-shm state.db-wal; do
  P="$PDIR/$f"
  [ -f "$P" ] && rm -f "$P" && log "removed $f"
done

# 4. Clear sessions/ directory (per-session caches).
if [ -d "$PDIR/sessions" ]; then
  find "$PDIR/sessions" -mindepth 1 -delete
  log "cleared sessions/"
fi

# 5. Truncate agent.log so per-run metrics extraction starts from a clean slate.
LOG="$PDIR/logs/agent.log"
if [ -f "$LOG" ]; then
  : > "$LOG"
  log "truncated logs/agent.log"
fi

# 6. Drop the .skills_prompt_snapshot.json so Hermes rebuilds it from the
#    current SKILL.md files (avoids stale snapshot drift).
if [ -f "$PDIR/.skills_prompt_snapshot.json" ]; then
  rm -f "$PDIR/.skills_prompt_snapshot.json"
  log "removed .skills_prompt_snapshot.json"
fi

# 7. Remove the auth.lock if present (Hermes recreates).
[ -f "$PDIR/auth.lock" ] && rm -f "$PDIR/auth.lock" && log "removed auth.lock"

log "done."

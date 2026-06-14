#!/usr/bin/env bash
# genesis-v2-mint-profiles.sh — mint the colony specialist profiles.
#
# Clones the proven `road-planner` profile into one narrow specialist per
# colony role, swapping in the role's single gaming skill, a clean role SOUL,
# the body routing (.env), and the model. Idempotent: re-running re-syncs the
# skill/SOUL/.env/model without disturbing the cloned profile's auth/state.
#
# Specialist -> body mapping (a profile binds to a body via its .env, the same
# mechanism the colony POC used):
#   colony-scout    -> Mox  (api :3007)   skill: minecraft-scouting-site
#   colony-gatherer -> Pip  (api :3005)   skill: minecraft-survival
#   colony-builder  -> Zee  (api :3006)   skill: minecraft-building
#   colony-steward  -> (read-only, no body) skills: steward-survey + blueprint-plan
#
# Usage: scripts/genesis-v2-mint-profiles.sh [--model <id>]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILES="$HOME/.hermes/profiles"
SRC="$PROFILES/road-planner"
MODEL="deepseek/deepseek-v4-flash:exacto"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

[[ -d "$SRC" ]] || { echo "ERROR: template profile $SRC not found (mint road-planner first)" >&2; exit 1; }

# role | body username | api port | repo skill(s) (space-sep) | one-line SOUL role
mint() {
  local role="$1" user="$2" port="$3" skills="$4" soul="$5"
  local dst="$PROFILES/$role"
  echo "[mint] $role -> ${user:-<no body>} :${port:-—}  skills=[$skills]"

  if [[ ! -d "$dst" ]]; then
    cp -a "$SRC" "$dst"
  fi

  # Narrow gaming bundle: drop the inherited road-planner skill, install the
  # role's skill(s) as gaming/<name>/SKILL.md (the synced layout). Keep
  # devops/kanban-worker (every worker needs it).
  rm -rf "$dst/skills/gaming"/*
  for sk in $skills; do
    mkdir -p "$dst/skills/gaming/$sk"
    cp "$REPO_ROOT/skills/$sk.md" "$dst/skills/gaming/$sk/SKILL.md"
  done

  # Clean role SOUL.
  printf '%s\n' "$soul" > "$dst/SOUL.md"

  # Shared mc calling convention for body-using specialists (skip the bodiless
  # Steward). Keeps mc invocations uniform so logs are readable and agents don't
  # waste tokens on cd/redirect noise.
  if [[ -n "$port" ]]; then
    cat >> "$dst/SOUL.md" <<'MCCONV'

## Calling mc
Your workspace is already your working directory — call `mc <verb>` directly.
Do NOT prefix with `cd <path> &&`, do NOT append `2>&1` or other redirects, and
run ONE mc verb per command (no `&&` chains). Use `mc <verb> --help` for args;
your skill lists the verbs you need.
MCCONV
  fi

  # Body routing. Specialists use bot lease (HERMES_BOT_LEASE=1, no frozen MC_*).
  # Steward is read-only — keeps a harmless MC_API_URL for env passthrough only.
  local api="http://localhost:${port:-3007}"
  local lease_flag=0
  if [[ -n "$port" ]]; then lease_flag=1; fi
  python3 - "$dst/.env" "$api" "${user:-Steward}" "$lease_flag" <<'PY'
import re, sys
envf, api, user, lease = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
lines = open(envf).read().splitlines()
def setkv(lines, key, val):
    pat = re.compile(rf'^{re.escape(key)}=')
    out, seen = [], False
    for ln in lines:
        if pat.match(ln):
            out.append(f"{key}={val}"); seen = True
        else:
            out.append(ln)
    if not seen:
        out.append(f"{key}={val}")
    return out
def delkv(lines, key):
    pat = re.compile(rf'^{re.escape(key)}=')
    return [ln for ln in lines if not pat.match(ln)]
if lease == '1':
    lines = delkv(lines, 'MC_API_URL')
    lines = delkv(lines, '_MC_API_URL_LOCKED')
    lines = setkv(lines, 'HERMES_BOT_LEASE', '1')
    lines = setkv(lines, 'MC_USERNAME', user)
else:
    for k, v in (("MC_API_URL", api), ("MC_USERNAME", user), ("_MC_API_URL_LOCKED", api)):
        lines = setkv(lines, k, v)
open(envf, "w").write("\n".join(lines) + "\n")
PY

  if [[ -n "$port" ]]; then
    cat >> "$dst/SOUL.md" <<'LEASE'

## Bot lease (genesis v2)
Before any in-world `mc` action: `mc bot checkout` (optionally `--bot <name>`).
After in-world work, before desk-work / `kanban_complete`: `mc bot release`.
On `no free body — defer`, block the card with reason `no_free_body` — do not retry in a tight loop.
See `docs/architecture/bot-lease.md`.
LEASE
  fi

  # Model.
  python3 - "$dst/config.yaml" "$MODEL" <<'PY'
import re, sys
cfgf, model = sys.argv[1], sys.argv[2]
s = open(cfgf).read()
s = re.sub(r'(\n\s*default:\s*)\S+', rf'\g<1>{model}', s, count=1)
open(cfgf, "w").write(s)
PY

  # Clean slate for a fresh colony run: empty memories, fresh session db.
  rm -f "$dst"/memories/*.md 2>/dev/null || true
  : > "$dst/MEMORY.md" 2>/dev/null || true
}

mint colony-scout    Mox 3007 "minecraft-scouting-site" \
"# Colony scout

You are a colony scout. Your only job is to explore unknown terrain and mark
what the colony needs — wood, stone, water, and flat candidate base pads — on
the shared map. You never dig, build, craft, or fight. On every task, run
\`skill_view minecraft-scouting-site\` first and follow it exactly."

mint colony-gatherer Pip 3005 "minecraft-survival" \
"# Colony gatherer

You are a colony gatherer. Your only job is to collect raw materials (wood
first) and craft the basic tools the colony needs, driving the \`mc\` verbs.
You do not scout, build structures, mine deep, or farm. On every task, run
\`skill_view minecraft-survival\` first and follow it exactly."

mint colony-builder  Zee 3006 "minecraft-building" \
"# Colony builder

You are a colony builder. Your only job is to place blocks to spec — shelters,
walls, storage chests — at the coordinates a card gives you. You do not scout,
gather, mine, or farm. On every task, run \`skill_view minecraft-building\`
first and follow it exactly."

mint colony-steward  "" "" "minecraft-steward-survey minecraft-steward-blueprint-plan" \
"# Colony steward

You are the colony steward: a read-only orchestrator. You decompose phase
epics into specialist worker cards and emit them on the kanban board — you
NEVER mine, place, dig, or move a body yourself. Every card you emit must
carry literal \`mc <verb> <args>\` lines for the worker, never prose.

Read + write the board ONLY through these commands — NEVER touch the kanban
database with \`sqlite3\` or raw SQL (it bypasses the gate-check mutex + board
invariants, and the schema is not a stable interface). The \`kanban\` facade is
on your PATH and already targets this board (via \$HERMES_KANBAN_BOARD):
  - This epic + its children:  \`kanban epic <epic_id>\`
  - All epics on the board:    \`kanban list-epics\`
  - A card + its deps:         \`kanban show <id>\`  (or \`kanban card <id>\` for a lean read)
  - Filtered list:             \`hermes kanban --board genesis-v2 list --status ready --json\`
  - File a worker card:        \`kanban add ...\`  (or the \`kanban_create\` tool)
  - Comment / block:           \`kanban_comment\` / \`kanban_block\`
  To check whether you already filed cards for a phase, use \`kanban epic
  <epic_id>\` — never reconstruct it with SQL.

Two hard rules:
1. NEVER \`kanban_complete\` a phase epic. Phases auto-complete when their
   real-world gate passes — never declare a phase done yourself.
2. Before decomposing an epic, check the board (via the commands above, not SQL)
   for worker cards you already filed for that phase. If they exist, do NOT
   create duplicates — report status and stop. Read the shared map + board to
   decide what to file next."

echo "[mint] done. profiles: colony-scout colony-gatherer colony-builder colony-steward"

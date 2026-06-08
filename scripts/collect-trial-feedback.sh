#!/usr/bin/env bash
# collect-trial-feedback.sh — post-trial role-agent feedback gather.
#
# For each role that ran a card during a trial, create a follow-up
# "feedback" card asking what problems they hit and what tooling
# improvements would help. Workers write a markdown file into the
# trial's postmortem dir; this script waits for each card to reach
# terminal, then writes an index.
#
# Assumes:
#   - the trial's dispatcher is still running for $BOARD
#   - HERMES_HOME is set (or default ~/.hermes)
#   - data/postmortems/<board>/<run-id>/manifest.json exists (the
#     capstone runner writes this on creation; reuse for prior-card
#     context per role)
#
# Usage:
#   scripts/collect-trial-feedback.sh \
#     --run-id w1-1780871693 \
#     --board wheat-capstone \
#     [--roles navigator,builder,farmer,crafter] \
#     [--out data/postmortems/<board>/<run-id>] \
#     [--max-runtime 10m]
#
# Output files (in --out):
#   feedback-<role>.md      raw worker write
#   feedback-index.md       headers + concatenation
#   feedback-manifest.json  card ids + status per role
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

RUN_ID=""
BOARD=""
ROLES_CSV="navigator,builder,farmer,crafter"
OUT_DIR=""
MAX_RUNTIME="10m"
POLL_INTERVAL=15
WATCH_TIMEOUT=900   # 15 min per role

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2;;
    --board) BOARD="$2"; shift 2;;
    --roles) ROLES_CSV="$2"; shift 2;;
    --out) OUT_DIR="$2"; shift 2;;
    --max-runtime) MAX_RUNTIME="$2"; shift 2;;
    --watch-timeout) WATCH_TIMEOUT="$2"; shift 2;;
    -h|--help) sed -n '2,30p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

[[ -z "$RUN_ID" ]] && { echo "FATAL: --run-id required" >&2; exit 2; }
[[ -z "$BOARD"  ]] && { echo "FATAL: --board required"  >&2; exit 2; }

OUT_DIR="${OUT_DIR:-$REPO_ROOT/data/postmortems/$BOARD/$RUN_ID}"
MANIFEST="$OUT_DIR/manifest.json"
[[ -f "$MANIFEST" ]] || { echo "FATAL: missing $MANIFEST" >&2; exit 2; }

mkdir -p "$OUT_DIR"

log() { printf '[feedback] %s\n' "$*"; }

prior_title_for_role() {
  local role="$1"
  python3 -c "
import json,sys
with open('$MANIFEST') as f: m=json.load(f)
for c in m.get('cards',[]):
  if c.get('assignee')=='$role':
    print(c.get('title','(no title)')); sys.exit(0)
print('')
"
}

prior_card_id_for_role() {
  local role="$1"
  python3 -c "
import json
with open('$MANIFEST') as f: m=json.load(f)
for c in m.get('cards',[]):
  if c.get('assignee')=='$role':
    print(c.get('card_id','')); break
"
}

# Build the prompt body. We tell the worker:
#   - what trial just ran
#   - which card they finished (jog memory)
#   - to write feedback to an explicit file path (so we can find it)
#   - to keep it concrete (verbs, errors, marks — no platitudes)
build_prompt() {
  local role="$1" prior_title="$2" prior_id="$3" out_path="$4"
  cat <<EOF
You are completing a post-trial feedback card for run **$RUN_ID** on board **$BOARD**.

You (the **$role** role) just finished: \`$prior_id\` "$prior_title".

Reflect briefly on what you observed during the trial. Write a short markdown
report — 5–12 concrete bullets — covering:

1. **Problems you hit** — be specific. Verb names, error strings, missing marks,
   ambiguous instructions, env vars you had to work around (e.g. \`MC_API_URL\`
   not in the shell). Skip "everything fine" — name a real friction.
2. **Tooling improvements** — what one or two changes would have made your
   card go faster or cleaner? A new skill verb? A clearer hint in the card
   body? A mark you wished existed? An mc subcommand?
3. **Anything in the bundle (skills, SOUL, profile) that was missing or
   stale**, if you noticed.

**Write your answer to this exact path** (overwriting if present):

    $out_path

Use \`write_file\` or shell \`cat > … <<EOF\`. After the file exists, complete
this card with a one-line summary in chat (\`mc chat "feedback recorded: …"\`).

Do not move the bot. Do not run mc verify. The only artifact for this card
is the markdown file.
EOF
}

create_feedback_card() {
  local role="$1" body="$2"
  local title="FEEDBACK [bot:mox] $role on $RUN_ID"
  hermes kanban --board "$BOARD" create \
    --tenant proto-agent-arch \
    --assignee "$role" \
    --body "$body" \
    --max-runtime "$MAX_RUNTIME" \
    --skill kanban-worker \
    --json \
    "$title" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))"
}

card_status() {
  local card_id="$1"
  hermes kanban --board "$BOARD" show "$card_id" --json 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); t=d.get('task',d); print(t.get('status','?'))" \
    2>/dev/null
}

wait_for_terminal() {
  local card_id="$1" deadline=$(( $(date +%s) + WATCH_TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    local s
    s="$(card_status "$card_id")"
    case "$s" in
      done|archived) echo "$s"; return 0;;
      "") echo "(query failed; retrying)" >&2;;
    esac
    sleep "$POLL_INTERVAL"
  done
  echo "timeout"; return 1
}

declare -A FB_CARD FB_STATUS FB_PATH
IFS=',' read -ra ROLES <<< "$ROLES_CSV"

log "run-id=$RUN_ID board=$BOARD out=$OUT_DIR"
log "roles: ${ROLES[*]}"

for role in "${ROLES[@]}"; do
  prior_title="$(prior_title_for_role "$role")"
  prior_id="$(prior_card_id_for_role "$role")"
  if [[ -z "$prior_id" ]]; then
    log "  skip $role — no prior card in manifest"
    continue
  fi

  out_path="$OUT_DIR/feedback-${role}.md"
  body="$(build_prompt "$role" "$prior_title" "$prior_id" "$out_path")"

  log "creating feedback card for $role (prior: $prior_id)"
  card_id="$(create_feedback_card "$role" "$body")"
  if [[ -z "$card_id" ]]; then
    log "  FAIL — could not create card for $role"
    FB_STATUS[$role]="create-failed"
    continue
  fi
  log "  card: $card_id — waiting for terminal (max ${WATCH_TIMEOUT}s)"
  FB_CARD[$role]="$card_id"

  status="$(wait_for_terminal "$card_id")"
  FB_STATUS[$role]="$status"
  log "  $role: $status"

  if [[ -f "$out_path" ]]; then
    FB_PATH[$role]="$out_path"
    log "  feedback file: $out_path ($(wc -c <"$out_path") bytes)"
  else
    log "  WARN: feedback file missing — worker did not write $out_path"
    FB_PATH[$role]=""
  fi
done

# Write index.
INDEX="$OUT_DIR/feedback-index.md"
{
  echo "# Trial feedback — $RUN_ID"
  echo
  echo "Board: $BOARD"
  echo "Roles: ${ROLES_CSV}"
  echo "Generated: $(date -Iseconds)"
  echo
  for role in "${ROLES[@]}"; do
    echo "## $role"
    echo
    echo "- card: \`${FB_CARD[$role]:-}\`  status: ${FB_STATUS[$role]:-skipped}"
    if [[ -n "${FB_PATH[$role]:-}" && -f "${FB_PATH[$role]}" ]]; then
      echo
      cat "${FB_PATH[$role]}"
      echo
    else
      echo
      echo "_no feedback file written_"
      echo
    fi
  done
} > "$INDEX"

# Manifest of feedback cards.
FB_MANIFEST="$OUT_DIR/feedback-manifest.json"
python3 - "$FB_MANIFEST" <<PY
import json, sys
data = {
  "run_id":      "$RUN_ID",
  "board":       "$BOARD",
  "generated_at": __import__("time").time(),
  "roles": [],
}
for role, card, status, path in zip(
  "${ROLES[*]}".split(),
  "${FB_CARD[navigator]:-} ${FB_CARD[builder]:-} ${FB_CARD[farmer]:-} ${FB_CARD[crafter]:-}".split(),
  "${FB_STATUS[navigator]:-} ${FB_STATUS[builder]:-} ${FB_STATUS[farmer]:-} ${FB_STATUS[crafter]:-}".split(),
  "${FB_PATH[navigator]:-} ${FB_PATH[builder]:-} ${FB_PATH[farmer]:-} ${FB_PATH[crafter]:-}".split(),
):
  data["roles"].append({"role": role, "card_id": card, "status": status, "path": path})
with open(sys.argv[1], "w") as f:
  json.dump(data, f, indent=2)
PY

log "wrote $INDEX"
log "wrote $FB_MANIFEST"
log "done"

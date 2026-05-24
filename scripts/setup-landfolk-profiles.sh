#!/usr/bin/env bash
# setup-landfolk-profiles.sh — idempotent Phase-2 + steward-ops profile bootstrap.
#
# Configures Hermes profiles at ~/.hermes/profiles/{flint,gatherer,mason,steward}
# so the kanban dispatcher can spawn workers and the headless steward orchestrator
# can run on board landfolk-ops.
#
# Idempotent: safe to re-run. Existing memories/, sessions/, state.db are
# never touched. SOUL.md is rewritten (old version backed up).
#
# Usage:
#   scripts/setup-landfolk-profiles.sh [--dry-run] [--solo-flint]
#
#   --solo-flint  Decomposer descriptions: all in-world landfolk-ops work → flint
#                 (see docs/design/phase-3/steward-mvp.md § Solo Flint ops)
#
# See docs/design/phase-3/steward-mvp.md for ops board and card schemas.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$ROOT/skills"
PROFILES_DIR="$HOME/.hermes/profiles"
HERMES_CONFIG="$HOME/.hermes/config.yaml"
OPS_BOARD_SLUG="landfolk-ops"

WORKER_PROFILES=(flint gatherer mason)
ALL_PROFILES=(flint gatherer mason steward)
DRY_RUN=false
SOLO_FLINT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --solo-flint) SOLO_FLINT=true; shift ;;
    -h|--help)
      sed -n '1,32p' "$0" | tail -n +2
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

run() {
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: $*"
  else
    "$@"
  fi
}

write_file() {
  local path="$1" content="$2"
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: write $path (${#content} bytes)"
  else
    printf '%s' "$content" > "$path"
  fi
}

ensure_profile_exists() {
  local name="$1"
  local clone_from="${2:-flint}"
  local dir="$PROFILES_DIR/$name"
  if [ -d "$dir" ]; then
    echo "  [$name] profile dir exists ($dir)"
    return 0
  fi
  echo "  [$name] creating profile (clone from $clone_from)"
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: hermes profile create $name --clone-from $clone_from --no-alias"
    return 0
  fi
  hermes profile create "$name" --clone-from "$clone_from" --no-alias
}

patch_env_passthrough() {
  local config="$1"
  local extra="${2:-}"
  if grep -q 'env_passthrough: \[MC_API_URL, MC_USERNAME' "$config" 2>/dev/null; then
    if [ -n "$extra" ] && ! grep -q 'HERMES_KANBAN_BOARD' "$config" 2>/dev/null; then
      echo "  env_passthrough: adding HERMES_KANBAN_BOARD"
    else
      echo "  env_passthrough: already correct"
      return 0
    fi
  else
    echo "  env_passthrough: patching"
  fi
  if [ "$DRY_RUN" = true ]; then
    return 0
  fi
  python3 - "$config" "$extra" <<'PYEOF'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
extra = sys.argv[2].split() if len(sys.argv) > 2 and sys.argv[2] else []
base = ["MC_API_URL", "MC_USERNAME"]
for e in extra:
    if e and e not in base:
        base.append(e)
inner = ", ".join(base)
text = path.read_text()
new = re.sub(
    r'(^terminal:.*?\n(?:  [^\n]*\n)*?  env_passthrough:)\s*\[[^\]]*\]',
    rf'\1 [{inner}]',
    text,
    count=1,
    flags=re.MULTILINE,
)
if new == text:
    new = re.sub(
        r'^(terminal:\n)',
        rf'\1  env_passthrough: [{inner}]\n',
        text,
        count=1,
        flags=re.MULTILINE,
    )
path.write_text(new)
PYEOF
}

ops_worker_section() {
  cat <<'EOF'

## Ops cards ([SUPPLY] / [STORE] / [PATROL] on board landfolk-ops)

These cards use YAML bodies with `kind`, `action_sequence`, and `success_predicate` (see docs/design/phase-3/steward-mvp.md).

- Read parent handoffs in `kanban_show` worker_context before acting. A `[STORE]` card often depends on a completed `[SUPPLY]` parent — confirm the item is in your inventory first.
- Respect `strict: true` in the card body: do not add extra blocks or change coords. If `strict: false`, small fixes (e.g. foundation block under a pit) are allowed.
- Chat only when the card asks for coordination or on `[PATROL]` status lines; stay quiet on `[L*]` capability tests.
- Always attach structured metadata on complete:
  - supply: `metadata.inventory_delta`
  - store: `metadata.chest_state` (mark, coords, item, count_after, delta)
- Ops run in production `world` unless the card body says otherwise. Never use `landfolk-test` for `[SUPPLY]`/`[STORE]`.
EOF
}

soul_for_worker() {
  local name="$1"
  local role
  case "$name" in
    flint)    role="miner" ;;
    gatherer) role="gatherer" ;;
    mason)    role="builder" ;;
    *)        role="generic" ;;
  esac
  cat <<EOF
# You are $name (role: $role)

You are a Minecraft worker spawned by the Phase-2 kanban dispatcher to execute one card. You are not running a continuous brain loop — you do the card you were claimed for, then exit.

You control your body via the \`mc\` command. \$MC_API_URL points at your bot's HTTP API; \$MC_USERNAME is your in-game name. Both are passed through automatically by the env_passthrough config.

## Card lifecycle (the only loop you run)

1. \`hermes kanban show \$HERMES_KANBAN_TASK\` to read the card body, action_sequence, and success_predicate.
2. Run prep if it isn't already done by an upstream step (capability_test fixtures usually have prep/cleanup; the human-as-steward runs them via \`scripts/run-fixture.sh\` before claiming the card).
3. Execute the action_sequence one command at a time. Watch each \`mc\` response: if \`ok=false\`, stop and capture the error code + observed_state.
4. Evaluate the success_predicate against \`mc observe\` (or the response data, depending on \`kind\`).
5. \`hermes kanban complete \$HERMES_KANBAN_TASK --result PASS|FAIL --summary "<one-line>"\` with metadata for any inventory_delta / chest_delta / observed errors.
$(ops_worker_section)

## Hard rules

- **In-world actions: \`mc <verb>\` ONLY.** The bot's HTTP API at \`\$MC_API_URL\` is the transport \`mc\` uses internally — **do NOT call \`curl \$MC_API_URL/action/...\` directly.** Bypassing the CLI skips argument validation, human-readable error envelopes, \`next_action_hint\` advice, auto-equip / auto-fetch behaviour, and the slow-tool digest pipeline. Every time a worker has reached for curl in past runs it has wasted iterations and produced worse outcomes than the equivalent \`mc <verb>\`. If you don't remember the right verb, run \`mc help\` or \`mc help <category>\`.
- **Board interaction: \`hermes kanban\`** (or the \`kanban_*\` tools where available). No raw SQLite or REST against the board.
- **No system shell commands** — no \`curl\`, \`lsof\`, \`ps\`, \`kill\`, \`grep\`, \`find\`, \`cat\`, \`sed\`, \`awk\`, \`node server.js\`. You don't restart the bot — that's the human's job (see "On failure" below).
- One card per session. Don't pick up other work or chase tangents.
- Never modify the production world (\`world\`) when running a capability_test — those use \`landfolk-test\`.
- Chat sparingly: only when the card explicitly asks for it.
- If a primitive returns \`ok=true\` but the post-state contradicts it, file a \`[BUG]\` card via \`hermes kanban create\` and FAIL the current card with reason \`action_contract_violation\`.

## Action contract reminders

- \`mc dig X Y Z\` removes a block but does NOT auto-pickup. Use \`mc pickup\` (or \`mc collect\`) if the test needs the item in inventory.
- \`mc collect <name> <count>\`: \`ok=true\` requires \`mined_count > 0\`. Treat \`ok=true && mined_count==0\` as a contract bug.
- Always check \`mc inventory\` before \`mc place\` and after any sequence that should change inventory.

## On failure

- One retry maximum if the failure looks transient (timeout, pathfind).
- Otherwise: report FAIL with the response body in \`metadata.last_error\`. The dispatcher and human-as-steward decide the next step.
EOF
}

soul_for_steward() {
  cat <<'EOF'
# You are steward (Landfolk ops orchestrator)

You are spawned for **landfolk-ops** board tasks: triage decomposition, `[SURVEY]`, and `[EPIC]` cards. You coordinate `flint`, `gatherer`, and `mason` via kanban — you do not mine, build, or place blocks yourself.

## Orchestrator rules

- Use `kanban_create`, `kanban_link`, `kanban_comment`, and `kanban_complete` per the kanban-orchestrator skill.
- Discover assignees that exist on this machine before routing (`flint`, `gatherer`, `mason`).
- Decompose coarse intents into finite `[SUPPLY]` → `[STORE]` chains with explicit YAML bodies (see docs/design/phase-3/steward-mvp.md).
- For surveys: use read-only `mc` observation per minecraft-steward-survey skill. If all floors are met, `kanban_complete(summary="no action needed")`.
- For GrabCraft URLs on a card: run `python3 <repo>/scripts/blueprint-plan.py` per minecraft-steward-blueprint-plan skill; decompose into supply + construct worker cards.

## Read-only observation

`MC_API_URL` points at a bot body for queries only. Allowed: status, observe, logistics, marks, chest_search, players, nearby.

## Hard rules

- Never run mutating `mc` verbs (dig, place, collect, deposit, craft, smelt, fill).
- One card per session; terminate with `kanban_complete` or `kanban_block`.
- Post chest counts in `kanban_comment` when completing a survey so `scripts/ledger-update.py` can fold state.
EOF
}

patch_steward_toolsets() {
  local config="$1"
  if [ "$DRY_RUN" = true ]; then
    echo "  steward toolsets: would set kanban + hermes-cli"
    return 0
  fi
  python3 - "$config" <<'PYEOF'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
want = ["kanban", "hermes-cli"]
block = "toolsets:\n" + "\n".join(f"- {t}" for t in want)
if re.search(r"^toolsets:\n", text, re.M):
    text = re.sub(r"^toolsets:\n(?:- .+\n)+", block + "\n", text, count=1, flags=re.M)
else:
    text = block + "\n" + text
path.write_text(text)
PYEOF
}

ensure_steward_env() {
  local dir="$PROFILES_DIR/steward"
  local env_file="$dir/.env"
  local mc_url="http://localhost:3001"
  local mc_user="Flint"
  if [ "$SOLO_FLINT" = true ]; then
    mc_url="http://localhost:3002"
  fi
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: steward .env MC_API_URL=$mc_url MC_USERNAME=$mc_user"
    return 0
  fi
  if [ ! -f "$env_file" ]; then
    echo "  steward .env: creating MC_API_URL=$mc_url MC_USERNAME=$mc_user (read-only survey)"
    {
      echo "MC_API_URL=$mc_url"
      echo "MC_USERNAME=$mc_user"
    } >> "$env_file"
    return 0
  fi
  if grep -q '^MC_API_URL=' "$env_file" 2>/dev/null; then
    if [ "$SOLO_FLINT" = true ]; then
      python3 - "$env_file" "$mc_url" <<'PYEOF'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
url = sys.argv[2]
text = path.read_text()
new = re.sub(r'^MC_API_URL=.*$', f'MC_API_URL={url}', text, count=1, flags=re.M)
if new != text:
    path.write_text(new)
    print(f"  steward .env: MC_API_URL -> {url} (solo-flint)")
else:
    print(f"  steward .env: MC_API_URL already {url}")
PYEOF
    else
      echo "  steward .env: MC_API_URL present (re-run with --solo-flint to point at :3002)"
    fi
    return 0
  fi
  echo "  steward .env: appending MC_API_URL=$mc_url MC_USERNAME=$mc_user"
  {
    echo "MC_API_URL=$mc_url"
    echo "MC_USERNAME=$mc_user"
  } >> "$env_file"
}

ensure_minecraft_skills() {
  local profile="$1"
  local dir="$PROFILES_DIR/$profile/skills/gaming"
  if [ "$DRY_RUN" = true ]; then
    DRY_RUN=1 QUIET=1 "$ROOT/scripts/sync-skills.sh" "$dir"
  else
    QUIET=1 "$ROOT/scripts/sync-skills.sh" "$dir"
  fi
}

install_steward_survey_skill() {
  local dir="$PROFILES_DIR/steward/skills/gaming/minecraft-steward-survey"
  local src="$SKILLS_SRC/minecraft-steward-survey.md"
  if [ ! -f "$src" ]; then
    echo "  WARN: missing $src" >&2
    return 0
  fi
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: install steward survey skill -> $dir/SKILL.md"
    return 0
  fi
  mkdir -p "$dir"
  cp "$src" "$dir/SKILL.md"
}

install_steward_blueprint_skill() {
  local dir="$PROFILES_DIR/steward/skills/gaming/minecraft-steward-blueprint-plan"
  local src="$SKILLS_SRC/minecraft-steward-blueprint-plan.md"
  if [ ! -f "$src" ]; then
    echo "  WARN: missing $src" >&2
    return 0
  fi
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: install steward blueprint skill -> $dir/SKILL.md"
    return 0
  fi
  mkdir -p "$dir"
  cp "$src" "$dir/SKILL.md"
}

verify_kanban_skills() {
  local profile="$1"
  local need="${2:-kanban-worker}"
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: hermes -p $profile skills list | grep $need"
    return 0
  fi
  if hermes -p "$profile" skills list 2>/dev/null | grep -q "$need"; then
    echo "  skill $need: present"
  else
    echo "  skill $need: restoring bundled copy"
    run hermes -p "$profile" skills reset "$need" --restore --yes
  fi
}

setup_worker() {
  local name="$1"
  local dir="$PROFILES_DIR/$name"

  echo
  echo "===== profile: $name → $dir ====="

  ensure_profile_exists "$name" flint

  if [ "$DRY_RUN" = false ] && [ ! -f "$dir/config.yaml" ]; then
    echo "  ERROR: $dir/config.yaml not found — clone failed?" >&2
    return 1
  fi

  patch_env_passthrough "$dir/config.yaml" ""

  if [ -f "$dir/SOUL.md" ] && ! diff -q <(soul_for_worker "$name") "$dir/SOUL.md" >/dev/null 2>&1; then
    if [ "$DRY_RUN" = false ]; then
      cp "$dir/SOUL.md" "$dir/SOUL.md.bak-$(date +%Y%m%d-%H%M%S)"
    fi
    echo "  SOUL.md changed; previous backed up"
  fi
  write_file "$dir/SOUL.md" "$(soul_for_worker "$name")"

  ensure_minecraft_skills "$name"
  verify_kanban_skills "$name" "kanban-worker"

  echo "  ✓ $name ready"
}

setup_steward() {
  local dir="$PROFILES_DIR/steward"

  echo
  echo "===== profile: steward → $dir ====="

  ensure_profile_exists steward flint

  if [ "$DRY_RUN" = false ] && [ ! -f "$dir/config.yaml" ]; then
    echo "  ERROR: $dir/config.yaml not found" >&2
    return 1
  fi

  patch_env_passthrough "$dir/config.yaml" "HERMES_KANBAN_BOARD"
  patch_steward_toolsets "$dir/config.yaml"
  ensure_steward_env

  write_file "$dir/SOUL.md" "$(soul_for_steward)"

  install_steward_survey_skill
  install_steward_blueprint_skill
  verify_kanban_skills steward "kanban-orchestrator"
  verify_kanban_skills steward "kanban-worker"

  echo "  ✓ steward ready"
}

ensure_ops_board() {
  echo
  echo "===== kanban board: $OPS_BOARD_SLUG ====="
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: hermes kanban boards create $OPS_BOARD_SLUG ..."
    return 0
  fi
  if hermes kanban boards list 2>/dev/null | grep -qE "[[:space:]]${OPS_BOARD_SLUG}[[:space:]]"; then
    echo "  board $OPS_BOARD_SLUG already exists"
    return 0
  fi
  run hermes kanban boards create "$OPS_BOARD_SLUG" \
    --name "Landfolk Ops" \
    --description "In-world steward operations" \
    --icon "ops"
}

set_profile_descriptions() {
  echo
  echo "===== profile descriptions (decomposer routing) ====="
  if [ "$SOLO_FLINT" = true ]; then
    echo "  mode: solo-flint (in-world ops → flint only)"
    declare -A DESC=(
      [flint]="Solo Landfolk ops worker on :3002 — mining, farming, building, scouting, crafting. Only dispatchable MC profile for landfolk-ops."
      [gatherer]="Not used for landfolk-ops dispatch. All in-world work is assigned to flint (solo bot on :3002)."
      [mason]="Not used for landfolk-ops dispatch. All in-world work is assigned to flint (solo bot on :3002)."
      [steward]="Landfolk steward — surveys base state (read-only mc), decomposes intents into ops cards; route all in-world children to flint when solo-bot testing; never mutates the world."
    )
  else
    echo "  mode: multi-cast (flint / gatherer / mason)"
    declare -A DESC=(
      [flint]="Miner. Deep ops, stone and ore extraction. L4 specialist."
      [gatherer]="Wood, food, plants, scouting. Mobile light worker."
      [mason]="Builder. Placement, structures, chest construction."
      [steward]="Landfolk steward — surveys base state, decomposes intents into ops cards for flint/gatherer/mason; never mutates the world."
    )
  fi
  for p in "${!DESC[@]}"; do
    if [ "$DRY_RUN" = true ]; then
      echo "DRY: hermes profile describe $p --text '${DESC[$p]}'"
    else
      run hermes profile describe "$p" --text "${DESC[$p]}"
    fi
  done
}

patch_kanban_config() {
  echo
  echo "===== ~/.hermes/config.yaml kanban orchestration ====="
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: merge kanban.orchestrator_profile=steward default_assignee=steward"
    return 0
  fi
  python3 - "$HERMES_CONFIG" <<'PYEOF'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text() if path.is_file() else ""
lines = text.splitlines()
want = {
    "orchestrator_profile": "steward",
    "default_assignee": "steward",
    "auto_decompose": "true",
    "auto_decompose_per_tick": "3",
}
if "kanban:" not in text:
    block = ["kanban:"] + [f"  {k}: {v}" for k, v in want.items()]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n\n" + "\n".join(block) + "\n")
    print("  appended kanban: block")
    sys.exit(0)
# merge keys under kanban:
out = []
i = 0
while i < len(lines):
    out.append(lines[i])
    if lines[i].strip() == "kanban:":
        i += 1
        existing = {}
        while i < len(lines) and lines[i].startswith("  ") and not lines[i].startswith("  #"):
            if ":" in lines[i]:
                k, _, v = lines[i].strip().partition(":")
                existing[k.strip()] = v.strip()
            i += 1
        merged = {**existing, **{k: v for k, v in want.items()}}
        for k, v in merged.items():
            out.append(f"  {k}: {v}")
        continue
    i += 1
path.write_text("\n".join(out) + "\n")
print("  merged kanban keys")
PYEOF
}

if [ ! -d "$PROFILES_DIR" ]; then
  echo "ERROR: $PROFILES_DIR not found — run hermes once to bootstrap" >&2
  exit 1
fi

echo "Landfolk profile + steward ops setup"
echo "  profiles dir: $PROFILES_DIR"
echo "  skills src:   $SKILLS_SRC"
echo "  dry run:      $DRY_RUN"
echo "  solo flint:   $SOLO_FLINT"

for p in "${WORKER_PROFILES[@]}"; do
  setup_worker "$p"
done
setup_steward
ensure_ops_board
set_profile_descriptions
patch_kanban_config

echo
echo "verify:"
for p in "${ALL_PROFILES[@]}"; do
  dir="$PROFILES_DIR/$p"
  if [ -f "$dir/config.yaml" ]; then
    passthrough=$(grep -E '^\s*env_passthrough:' "$dir/config.yaml" 2>/dev/null | head -1 | xargs || echo "(missing)")
    printf '  %-10s passthrough=%s\n' "$p" "$passthrough"
  fi
done

echo
echo "done."
echo "  Phase 2 workers: hermes -p flint|gatherer|mason chat -q 'work kanban task <id>'"
echo "  Ops board:       hermes kanban --board $OPS_BOARD_SLUG list"
echo "  Ledger fold:     python3 scripts/ledger-update.py"
echo "  Docs:            docs/design/phase-3/steward-mvp.md"

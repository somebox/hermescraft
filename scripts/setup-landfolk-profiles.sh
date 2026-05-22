#!/usr/bin/env bash
# setup-landfolk-profiles.sh — idempotent Phase-2 profile bootstrap.
#
# Configures real Hermes profiles at ~/.hermes/profiles/{flint,gatherer}
# so the kanban dispatcher can spawn workers via `hermes -p <name>` against
# the right body and personality.
#
# Idempotent: safe to re-run. Existing memories/, sessions/, state.db are
# never touched. SOUL.md is rewritten (old version backed up) so the
# Phase-2 worker pattern stays the source of truth.
#
# Usage:
#   scripts/setup-landfolk-profiles.sh [--dry-run]
#
# What it does:
#   1. `hermes profile create gatherer --clone-from flint` if missing.
#   2. Verifies terminal.env_passthrough includes MC_API_URL + MC_USERNAME
#      and patches the line if not.
#   3. Installs Phase-2 SOUL.md (backing up the prior one).
#   4. Ensures hermescraft/skills/minecraft-*.md are present under
#      skills/gaming/<sk>/SKILL.md (cloned profile already has these).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$ROOT/skills"
PROFILES_DIR="$HOME/.hermes/profiles"

PROFILES=(flint gatherer)
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      sed -n '1,22p' "$0" | tail -n +2
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
  local dir="$PROFILES_DIR/$name"
  if [ -d "$dir" ]; then
    echo "  [$name] profile dir exists ($dir)"
    return 0
  fi
  echo "  [$name] creating profile (clone from flint)"
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: hermes profile create $name --clone-from flint --no-alias"
    return 0
  fi
  hermes profile create "$name" --clone-from flint --no-alias
}

patch_env_passthrough() {
  local config="$1"
  if grep -q 'env_passthrough: \[MC_API_URL, MC_USERNAME\]' "$config" 2>/dev/null; then
    echo "  env_passthrough: already correct"
    return 0
  fi
  echo "  env_passthrough: patching"
  if [ "$DRY_RUN" = true ]; then
    return 0
  fi
  python3 - "$config" <<'PYEOF'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
text = path.read_text()
new = re.sub(
    r'(^terminal:.*?\n(?:  [^\n]*\n)*?  env_passthrough:)\s*\[[^\]]*\]',
    r'\1 [MC_API_URL, MC_USERNAME]',
    text,
    count=1,
    flags=re.MULTILINE,
)
if new == text:
    new = re.sub(
        r'^(terminal:\n)',
        r'\1  env_passthrough: [MC_API_URL, MC_USERNAME]\n',
        text,
        count=1,
        flags=re.MULTILINE,
    )
path.write_text(new)
PYEOF
}

soul_for() {
  local name="$1"
  local role
  case "$name" in
    flint)    role="miner" ;;
    gatherer) role="gatherer" ;;
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

## Hard rules

- Use only \`mc\` commands and \`hermes kanban\` for board interaction. No curl, lsof, ps, kill, grep, find.
- One card per session. Don't pick up other work or chase tangents.
- Never modify the production world (\`world\`). Tests run in \`landfolk-test\`.
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

ensure_minecraft_skills() {
  # Phase-2 skills: install hermescraft/skills/minecraft-*.md as
  # gaming/<name>/SKILL.md. Canonical list lives in skills/MANIFEST;
  # deployed via scripts/sync-skills.sh.
  local profile="$1"
  local dir="$PROFILES_DIR/$profile/skills/gaming"
  if [ "$DRY_RUN" = true ]; then
    DRY_RUN=1 QUIET=1 "$ROOT/scripts/sync-skills.sh" "$dir"
  else
    QUIET=1 "$ROOT/scripts/sync-skills.sh" "$dir"
  fi
}

setup_one() {
  local name="$1"
  local dir="$PROFILES_DIR/$name"

  echo
  echo "===== profile: $name → $dir ====="

  ensure_profile_exists "$name"

  if [ "$DRY_RUN" = false ] && [ ! -f "$dir/config.yaml" ]; then
    echo "  ERROR: $dir/config.yaml not found — clone failed?" >&2
    return 1
  fi

  patch_env_passthrough "$dir/config.yaml"

  # SOUL.md (always rewritten to current Phase-2 pattern; back up any old)
  if [ -f "$dir/SOUL.md" ] && ! diff -q <(soul_for "$name") "$dir/SOUL.md" >/dev/null 2>&1; then
    if [ "$DRY_RUN" = false ]; then
      cp "$dir/SOUL.md" "$dir/SOUL.md.bak-$(date +%Y%m%d-%H%M%S)"
    fi
    echo "  SOUL.md changed; previous backed up"
  fi
  write_file "$dir/SOUL.md" "$(soul_for "$name")"

  ensure_minecraft_skills "$name"

  echo "  ✓ $name ready"
}

if [ ! -d "$PROFILES_DIR" ]; then
  echo "ERROR: $PROFILES_DIR not found — run hermes once to bootstrap" >&2
  exit 1
fi

echo "Phase 2 profile setup"
echo "  profiles dir: $PROFILES_DIR"
echo "  skills src:   $SKILLS_SRC"
echo "  dry run:      $DRY_RUN"

for p in "${PROFILES[@]}"; do
  setup_one "$p"
done

echo
echo "verify:"
for p in "${PROFILES[@]}"; do
  dir="$PROFILES_DIR/$p"
  passthrough=$(grep -E '^\s*env_passthrough:' "$dir/config.yaml" 2>/dev/null | head -1 | xargs || echo "(missing)")
  soul_first=$(head -1 "$dir/SOUL.md" 2>/dev/null || echo "(missing)")
  printf '  %-10s passthrough=%s\n  %-10s soul     =%s\n' "$p" "$passthrough" "" "$soul_first"
done

echo
echo "done. Workers will be spawned by the dispatcher via:"
echo "  hermes -p flint   chat -q 'work kanban task <id>'"
echo "  hermes -p gatherer chat -q 'work kanban task <id>'"

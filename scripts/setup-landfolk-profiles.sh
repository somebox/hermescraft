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
#   scripts/setup-landfolk-profiles.sh [--dry-run] [--solo-flint] [--apply-config]
#
#   --apply-config  Sync SOUL.md, worker max_turns (150), steward skills, and env
#                   passthrough only — skip board creation and profile descriptions.
#                   Use after checkout when ~/.hermes/profiles already exist.
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
APPLY_CONFIG=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --solo-flint) SOLO_FLINT=true; shift ;;
    --apply-config) APPLY_CONFIG=true; shift ;;
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

patch_max_turns() {
  # Workers spawn one mc verb per turn and routinely need 60-120 steps for
  # multi-stage cards (scout + gather + craft + deposit). The default
  # max_turns=90 hits "Iteration budget exhausted" on cards that aren't
  # actually stuck — they just need more steps. Bump worker profiles to 150.
  local config="$1"
  local turns="${2:-150}"
  if [ "$DRY_RUN" = true ]; then
    echo "  max_turns: would set to $turns"
    return 0
  fi
  python3 - "$config" "$turns" <<'PYEOF'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
turns = sys.argv[2]
text = path.read_text()
# Decide first whether the key exists at all. If it does, replace the value
# (which may be a no-op); if not, fall through to the insert path. The
# previous logic conflated "key exists with correct value" (where the
# in-place re.sub leaves `new == text`) with "key absent" and re-inserted
# every deploy, producing duplicate lines.
pattern = re.compile(r'^(\s*max_turns:\s*)\d+', re.M)
m = pattern.search(text)
if m:
    new = pattern.sub(r'\g<1>' + turns, text, count=1)
else:
    if re.search(r'^agent:\s*$', text, re.M):
        new = re.sub(r'^(agent:\s*\n)', r'\1  max_turns: ' + turns + '\n', text, count=1, flags=re.M)
    else:
        new = text.rstrip() + f"\nagent:\n  max_turns: {turns}\n"
if new != text:
    path.write_text(new)
    print(f"  max_turns: set to {turns}")
else:
    print(f"  max_turns: already {turns}")
PYEOF
}

patch_context_length() {
  # Cap the context-budget Hermes uses (deepseek-v4-flash advertises ~1M via
  # OpenRouter). Without this, compression.threshold applies to the full 1M
  # window. With 250K cap + threshold 0.2 (see apply_landfolk_compression_policy),
  # summarization runs at ~50K tokens.
  # Lives at top-level `model.context_length:` (NOT under agent:).
  local config="$1"
  local ctx="${2:-250000}"
  if [ "$DRY_RUN" = true ]; then
    echo "  model.context_length: would set to $ctx"
    return 0
  fi
  python3 - "$config" "$ctx" <<'PYEOF'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
ctx = sys.argv[2]
text = path.read_text()
# Check whether the key exists before deciding insert vs replace — see the
# patch_max_turns note for why the no-op-in-place case was duplicating lines.
pattern = re.compile(
    r'^(model:\s*\n(?:  [^\n]*\n)*?  context_length:\s*)\d+',
    re.M,
)
m = pattern.search(text)
if m:
    new = pattern.sub(r'\g<1>' + ctx, text, count=1)
else:
    # No context_length under model: — insert at top of model: block.
    new = re.sub(
        r'^(model:\s*\n)',
        r'\1  context_length: ' + ctx + '\n',
        text, count=1, flags=re.M)
if new != text:
    path.write_text(new)
    print(f"  model.context_length: set to {ctx}")
else:
    print(f"  model.context_length: already {ctx}")
PYEOF
}

apply_landfolk_compression_policy() {
  # Cap context + aggressive compression.threshold (see patch-landfolk-compression-config.py).
  local config="$1"
  local py="$ROOT/scripts/patch-landfolk-compression-config.py"
  if [ "$DRY_RUN" = true ]; then
    echo "  compression policy: would run $py"
    return 0
  fi
  python3 "$py" "$config"
}

patch_compression_model() {
  # Legacy: pins auxiliary.compression.model directly. New callers should let
  # apply_landfolk_compression_policy do it via patch-landfolk-compression-config.py,
  # which reads the canonical model from data/agent-models.json. Kept for
  # back-compat with ad-hoc invocations.
  local config="$1"
  local model="$2"
  if [ "$DRY_RUN" = true ]; then
    echo "  auxiliary.compression.model: would set to $model"
    return 0
  fi
  python3 - "$config" "$model" <<'PYEOF'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
model = sys.argv[2]
text = path.read_text()
pattern = re.compile(
    r'^(auxiliary:\s*\n(?:  [^\n]*\n)*?  compression:\s*\n(?:    [^\n]*\n)*?    model:\s*)["\']?[^"\'\n]*["\']?',
    re.M,
)
m = pattern.search(text)
if m:
    new = pattern.sub(r'\g<1>"' + model + '"', text, count=1)
else:
    # No auxiliary.compression.model key — append the whole subtree at end-of-file.
    new = text.rstrip() + f'\nauxiliary:\n  compression:\n    provider: "openrouter"\n    model: "{model}"\n'
if new != text:
    path.write_text(new)
    print(f"  auxiliary.compression.model: set to {model}")
else:
    print(f"  auxiliary.compression.model: already {model}")
PYEOF
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
  echo "  env_passthrough: syncing"
  if [ "$DRY_RUN" = true ]; then
    return 0
  fi
  python3 - "$config" "$extra" <<'PYEOF'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
extra = sys.argv[2].split() if len(sys.argv) > 2 and sys.argv[2] else []
# Terminal shells need the full kanban env surface. If any of these are
# dropped by env_passthrough filtering, downstream scripts can see empty
# values (or fallback incorrectly), even when parent launch env is correct.
base = [
    "MC_API_URL",
    "MC_USERNAME",
    "HERMES_KANBAN_DB",
    "HERMES_KANBAN_ROOT",
    "HERMES_KANBAN_WORKSPACES_ROOT",
    "HERMES_KANBAN_BOARD",
]
for e in extra:
    if e and e not in base:
        base.append(e)
inner = ", ".join(base)
text = path.read_text()

# Cleanup pass: scrub orphan block-sequence items inside the `terminal:`
# block. Older profile configs stored env_passthrough as a multi-line list:
#   terminal:
#     env_passthrough:
#       - MC_API_URL
#       - MC_USERNAME
# When the regex below converted env_passthrough to flow-array form, the
# `- MC_API_URL` / `- MC_USERNAME` lines became orphan siblings of the
# terminal: mapping keys — yaml.safe_load then fails with
#   "expected <block end>, but found '-'"
# and Hermes silently falls back to a default config with no model set,
# crash-looping the agent (observed in g-2026-05-30-2, mason). Remove
# any `  - VAR` line that sits inside the terminal block.
def strip_terminal_orphans(s):
    lines = s.split('\n')
    out = []
    in_terminal = False
    for line in lines:
        if re.match(r'^terminal:\s*$', line):
            in_terminal = True
            out.append(line)
            continue
        if in_terminal:
            # Leaving the terminal block: any non-indented line that isn't
            # blank terminates it.
            if line and not line.startswith(' '):
                in_terminal = False
            # Within the block, drop orphan sequence items at 2-space indent.
            elif re.match(r'^  - \S', line) and not re.match(r'^  - {2,}', line):
                continue
        out.append(line)
    return '\n'.join(out)

text = strip_terminal_orphans(text)

# Same idempotency pattern as patch_max_turns / patch_context_length: decide
# replace-vs-insert via re.search FIRST, otherwise a no-op replace (key
# present with identical value) falls through to the insert branch and
# duplicates the line on every deploy.
in_place_re = re.compile(
    r'(^terminal:.*?\n(?:  [^\n]*\n)*?  env_passthrough:)\s*\[[^\]]*\]',
    re.MULTILINE,
)
if in_place_re.search(text):
    new = in_place_re.sub(rf'\1 [{inner}]', text, count=1)
else:
    new = re.sub(
        r'^(terminal:\n)',
        rf'\1  env_passthrough: [{inner}]\n',
        text,
        count=1,
        flags=re.MULTILINE,
    )
if new != text:
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
  # Body loaded from prompts/landfolk/worker.md (with {{NAME}} and {{ROLE}}
  # placeholders substituted). Edit that file to change worker doctrine; this
  # function just templates it. Before 2026-05-26 the entire SOUL was an
  # inline heredoc here — moving to a file means edits don't require
  # navigating bash quoting/escapes.
  local name="$1"
  local role
  case "$name" in
    flint)    role="miner" ;;
    gatherer) role="gatherer" ;;
    mason)    role="builder" ;;
    *)        role="generic" ;;
  esac
  local template="$ROOT/prompts/landfolk/worker.md"
  if [ ! -f "$template" ]; then
    echo "ERROR: worker SOUL template missing: $template" >&2
    return 1
  fi
  sed -e "s/{{NAME}}/$name/g" -e "s/{{ROLE}}/$role/g" "$template"
}

# Legacy inline worker SOUL — replaced by file load above (2026-05-26).
# The original heredoc and ops_worker_section are preserved below as a
# reference for diff'ing/restoring if the file-load breaks. Safe to delete
# once the file-load path has run cleanly for several deploy cycles.
_legacy_soul_for_worker_inline_OLD() {
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

0. **FIRST action of every session: \`skill_view('kanban-worker')\`.** The \`--skills kanban-worker\` launch flag only registers the skill in your catalog — it does NOT load the body into your prompt. You MUST call \`skill_view\` on turn 1 to load the actual rules (validate-task, failure-escalation, escape-primitives, pass-back, state-continuity, mc-verb syntax). Without it you'll fumble verb arguments and miss the escalation thresholds. After that, also \`skill_view('minecraft-mining')\` and \`skill_view('minecraft-navigation')\` if your card involves digging/movement — these have verb syntax tables, Y-level cheat sheets, and the underground-escape playbook.
1. \`kanban_show\` (or \`hermes kanban show \$HERMES_KANBAN_TASK\`) to read the card body, action_sequence, and success_predicate.
2. If the card body includes \`worksite: <id>\` (bare region id, e.g. \`hut3\`), run \`mc task_context set <id>\` once before any dig/place inside that protect region. \`mc observe\` shows the active worksite while the grant is valid.
3. Run prep if it isn't already done by an upstream step (capability_test fixtures usually have prep/cleanup; the human-as-steward runs them via \`scripts/run-fixture.sh\` before claiming the card).
4. Execute the action_sequence one command at a time. Watch each \`mc\` response: if \`ok=false\`, stop and capture the error code + observed_state.
5. Evaluate the success_predicate against \`mc observe\` (or the response data, depending on \`kind\`).
6. \`kanban_complete\` (or \`hermes kanban complete \$HERMES_KANBAN_TASK --result PASS|FAIL --summary "<one-line>"\`) with metadata for any inventory_delta / chest_delta / observed errors. Run \`mc task_context clear\` on complete or block so the worksite grant does not leak to the next card.
$(ops_worker_section)

## Hard rules

- **In-world actions: \`mc <verb>\` ONLY.** The bot's HTTP API is the transport \`mc\` uses internally — never bypass it. Calling the bot's HTTP endpoints directly (with any shell tool) skips argument validation, human-readable error envelopes, \`next_action_hint\` advice, auto-equip / auto-fetch behaviour, and the slow-tool digest pipeline. Every time a worker has bypassed \`mc\` it has wasted iterations and produced worse outcomes. If you don't remember the right verb, run \`mc help\` or \`mc help <category>\`.
- **Board interaction: \`kanban_*\` tools** (\`kanban_show\`, \`kanban_complete\`, \`kanban_block\`, \`kanban_comment\`). Use \`hermes kanban\` CLI only if a tool is unavailable in your session.
- **No system shell commands** — no \`curl\`, \`lsof\`, \`ps\`, \`kill\`, \`grep\`, \`find\`, \`cat\`, \`sed\`, \`awk\`, \`node server.js\`. You don't restart the bot — that's the human's job (see "On failure" below).
- One card per session. Don't pick up other work or chase tangents.
- Never modify the production world (\`world\`) when running a capability_test — those use \`landfolk-test\`.
- Chat narration is MANDATORY at card boundaries (start, completion, block) and every 3–5 minutes during long work. See "Announce key card transitions" below. Workers who go silent for 10+ minutes mid-card make the fleet invisible to re44 and Steward — never go silent.
- If a primitive returns \`ok=true\` but the post-state contradicts it, file a \`[BUG]\` card via \`kanban_create\` and FAIL the current card with reason \`action_contract_violation\`.

## Action contract reminders

- \`mc dig X Y Z\` removes a block but does NOT auto-pickup. Use \`mc pickup\` (or \`mc collect\`) if the test needs the item in inventory.
- \`mc collect <name> <count>\`: \`ok=true\` requires \`mined_count > 0\`. Treat \`ok=true && mined_count==0\` as a contract bug.
- Always check \`mc inventory\` before \`mc place\` and after any sequence that should change inventory.

## Chat narration is MANDATORY (not optional)

The fleet's in-game chat is THE shared workspace for re44, Steward, and other workers. **Silent operation makes you invisible** — re44 has to grep logs to find out what you're doing, Steward can't help when stuck, peer workers can't coordinate. Audit on 2026-05-25 showed workers had made ZERO \`mc chat\` calls over multiple-hour sessions; that's the bug this section exists to fix.

**Required \`mc chat\` lines (use ALL of these on every card):**

1. **On startup**, your first or second tool call:
   \`mc chat "starting <kanban_id>: <short verb + target>"\`
   Examples: \`"starting t_6f58ca52: mining 3 iron at Y-15"\`, \`"starting t_4807ed72: planting wheat on tilled rows"\`

2. **Every 3-5 minutes during work** — narrate progress. One line, ≤120 chars:
   \`mc chat "<bot>: <what you just finished or are doing next>"\`
   Examples: \`"<flint>: 2/3 iron mined, smelting started"\`, \`"<mason>: foundation laid, framing east wall"\`, \`"<flint>: down to Y-12 in iron shaft, no diamond yet"\`. After EVERY significant milestone (a \`mc dig\` completed a vein, a \`mc craft\` succeeded, you reached a new worksite, you encountered a blocker) — narrate it.

3. **On completion**, just before \`kanban_complete\`:
   \`mc chat "done <kanban_id>: <one-line result>"\`
   Examples: \`"done t_6f58ca52: bucket crafted, deposited at chest_iron"\`, \`"done t_4807ed72: 12 wheat planted, 11 dry rows skipped"\`.

4. **On block**, just before \`kanban_block\`:
   \`mc chat "blocked <kanban_id>: <prefix>: <short reason>"\`
   Use the structured block-reason prefixes from the next section. Example: \`"blocked t_6f58ca52: help-needed: 4× mc collect raw_iron failed in stripmine, mc advise unclear"\`.

5. **On stuck mid-action** — narrate it before retrying:
   \`mc chat "<bot>: stuck at <X,Y,Z>, trying <variant>"\`. This is the 2-failure soft-help mark from the kanban-worker SKILL.

**Don't:**
- Don't chat per-`mc-call`. That's spam. Aim for one chat per significant milestone (≈3-5 mc verbs).
- Don't chat what's already visible in the card body. "starting harvest" yes, recapping the whole instruction list no.
- Don't substitute prose-output narration for actual \`mc chat\` tool calls. **Workers in chat = workers visible; workers in agent log only = workers invisible.**

**Self-check before exit**: if your last 10 minutes of tool calls didn't include an \`mc chat\`, you went silent — narrate something before completing or blocking.

## Requesting steward help (escalation channel)

When a structured obstacle stops your card and you've recognized the cause, \`kanban_block\` with a structured reason prefix so Steward can read blocked cards on the next planning cycle. Use these prefixes:

- \`region_blocked:<region_id>:<short_reason>\` — dig/place blocked inside a protect region and your card has no matching \`worksite:\` grant (or the worksite id is wrong). First confirm you ran \`mc task_context set <id>\` when the card body names a worksite. If the card never had a worksite, block so the steward can add \`worksite:\` to the body or fix decomposition. Example: \`kanban_block "region_blocked:hut3:cannot_dig_ceiling_to_exit"\`.
- \`prerequisite_missing:<item>:<count>\` — supply shortfall the card body didn't account for. Steward can create a \`[SUPPLY]\` precursor and link it as a parent.
- \`stuck_pocket_no_escape:<pos>\` — wedged with no tool path out. Steward can rcon-tp you out or give a missing tool.
- \`decision_needed:<options>\` — you have a partial result and need a stewarding judgment call (e.g. "accept 5 raw_iron vs continue mining for 32"). Steward decides and unblocks with guidance.

Don't grind iterations after recognizing one of these. Steward (continuous orchestrator loop) should unblock, decompose, reassign, or open a \`[BUG]\` card for re44 — not spawn nested supervise sub-tasks.

## On failure

- One retry maximum if the failure looks transient (timeout, pathfind).
- Otherwise: report FAIL with the response body in \`metadata.last_error\`. The dispatcher and human-as-steward decide the next step.
EOF
}

soul_for_steward() {
  # Profile SOUL body loaded from prompts/landfolk/steward-profile.md.
  # This is the SHORT profile SOUL (loaded at hermes session start) — distinct
  # from prompts/landfolk/steward.md (the LONG continuous-loop -q prompt
  # loaded per-round in landfolk-control.sh). Both are now file-driven.
  local template="$ROOT/prompts/landfolk/steward-profile.md"
  if [ ! -f "$template" ]; then
    echo "ERROR: steward profile SOUL missing: $template" >&2
    return 1
  fi
  cat "$template"
}

# Legacy inline steward profile SOUL — preserved here as a reference;
# the file-load above is canonical. Safe to delete once the file-load has
# run cleanly for several deploys.
_legacy_soul_for_steward_inline_OLD() {
  cat <<'EOF'
# You are steward (Landfolk ops orchestrator)

You are spawned for **landfolk-ops** board tasks: triage decomposition, `[SURVEY]`, `[EPIC]`, and `[SUPERVISE]` cards. You coordinate `flint`, `gatherer`, and `mason` via kanban — you do not mine, build, or place blocks yourself.

## First action of every session

`skill_view('kanban-orchestrator')` AND `skill_view('kanban-worker')`. The `--skills` launch flag only registers skills in your catalog — it does NOT load the body. You must call `skill_view` to actually read the rules. For continuous-loop activations (where you're the orchestrator reading the board across cycles), `prompts/landfolk/steward.md` is loaded as your initial `-q`, so you have the SOUL — but `skill_view('kanban-orchestrator')` is still useful on first activation for the decomposition / handoff playbook.

## Orchestrator rules

- Use `kanban_create`, `kanban_link`, `kanban_comment`, and `kanban_complete` per the kanban-orchestrator skill.
- Discover assignees that exist on this machine before routing (`flint`, `gatherer`, `mason`).
- Decompose coarse intents into finite `[SUPPLY]` → `[STORE]` chains with explicit YAML bodies (see docs/design/phase-3/steward-mvp.md).
- For surveys: use read-only `mc` observation per minecraft-steward-survey skill. If all floors are met, `kanban_complete(summary="no action needed")`.
- For GrabCraft URLs on a card: run `python3 <repo>/scripts/blueprint-plan.py` per minecraft-steward-blueprint-plan skill; decompose into supply + construct worker cards.

## Blocked-card escalation (optional [SUPERVISE] lane)

If a legacy \`[SUPERVISE]\` card appears (from an optional supervisor daemon), treat it like any other steward card: read the blocked target, take **one** action (unblock, decompose, reassign, archive, or open \`[BUG]\` for re44), then complete the supervise card. Prefer handling blocked cards directly during your normal board read in the continuous loop.

## Read-only observation

`MC_API_URL` points at a bot body for queries only. Allowed: status, observe, logistics, marks, chest_search, players, nearby.

## Hard rules

- Never run mutating `mc` verbs (dig, place, collect, deposit, craft, smelt, fill).
- One card per session; terminate with `kanban_complete` or `kanban_block`.
- Post chest counts in `kanban_comment` when completing a survey so `scripts/ledger-update.py` can fold state.
- BUG/INCIDENT cards are for `re44` — never assign them to bot profiles.
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

# Install our kanban-worker override (state continuity, validation,
# failure-escalation, pass-back). The repo source at `skills/kanban-worker.md`
# is the canonical truth; we deploy it to both the user-dir override
# (`~/.hermes/skills/devops/kanban-worker/SKILL.md`) and the per-profile copy
# (`~/.hermes/profiles/<profile>/skills/devops/kanban-worker/SKILL.md`).
#
# We do NOT touch `~/.hermes/hermes-agent/skills/...` (that's Hermes-shipped,
# clobbered on upstream updates). The user-dir path overrides the platform
# default via Hermes' skill-resolution precedence.
install_kanban_worker_skill() {
  local profile="$1"
  local src="$SKILLS_SRC/kanban-worker.md"
  if [ ! -f "$src" ]; then
    echo "  WARN: missing $src" >&2
    return 0
  fi

  local user_dir="$HOME/.hermes/skills/devops/kanban-worker"
  local profile_dir="$PROFILES_DIR/$profile/skills/devops/kanban-worker"

  if [ "$DRY_RUN" = true ]; then
    echo "DRY: install kanban-worker override -> $user_dir/SKILL.md"
    echo "DRY: install kanban-worker override -> $profile_dir/SKILL.md"
    return 0
  fi

  # User-dir canonical override (idempotent — same content for every profile).
  mkdir -p "$user_dir"
  cp "$src" "$user_dir/SKILL.md"

  # Per-profile copy. Hermes profile resolution may consult this first; we
  # keep it in sync to avoid divergence.
  mkdir -p "$profile_dir"
  cp "$src" "$profile_dir/SKILL.md"

  # Sync any OTHER profiles that already have the skill installed (e.g.
  # legacy/test profiles like librarian, worker-a, worker-b that aren't in
  # WORKER_PROFILES / ALL_PROFILES but were set up at some point). This
  # prevents stale drift in those copies. We only update existing files —
  # we don't create new ones for profiles we don't manage.
  local other_skill
  for other_skill in "$PROFILES_DIR"/*/skills/devops/kanban-worker/SKILL.md; do
    [ -f "$other_skill" ] || continue
    [ "$other_skill" = "$profile_dir/SKILL.md" ] && continue
    cp "$src" "$other_skill"
  done
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
  patch_max_turns "$dir/config.yaml" 150
  patch_context_length "$dir/config.yaml" 250000
  # apply_landfolk_compression_policy reads the aux model from
  # data/agent-models.json (auxiliary.compression) — single source of truth.
  apply_landfolk_compression_policy "$dir/config.yaml"

  if [ -f "$dir/SOUL.md" ] && ! diff -q <(soul_for_worker "$name") "$dir/SOUL.md" >/dev/null 2>&1; then
    if [ "$DRY_RUN" = false ]; then
      cp "$dir/SOUL.md" "$dir/SOUL.md.bak-$(date +%Y%m%d-%H%M%S)"
    fi
    echo "  SOUL.md changed; previous backed up"
  fi
  write_file "$dir/SOUL.md" "$(soul_for_worker "$name")"

  ensure_minecraft_skills "$name"
  install_kanban_worker_skill "$name"
  # NOTE: do NOT call `verify_kanban_skills "$name" "kanban-worker"` here.
  # `hermes skills list` doesn't see our raw file-drop as a registered skill;
  # `verify_kanban_skills` then mistakes it for missing and runs
  # `hermes skills reset --restore`, which clobbers our customization with
  # the upstream bundled default. install_kanban_worker_skill (above) is
  # the canonical install; trust it.

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
  patch_context_length "$dir/config.yaml" 250000
  # apply_landfolk_compression_policy reads the aux model from
  # data/agent-models.json (auxiliary.compression) — single source of truth.
  apply_landfolk_compression_policy "$dir/config.yaml"
  ensure_steward_env

  write_file "$dir/SOUL.md" "$(soul_for_steward)"

  install_steward_survey_skill
  install_steward_blueprint_skill
  install_kanban_worker_skill steward
  verify_kanban_skills steward "kanban-orchestrator"
  # See note in setup_worker — don't verify (and thereby reset) kanban-worker
  # after install_kanban_worker_skill. The orchestrator skill is fine because
  # we don't customize it.

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

install_landfolk_plugin() {
  # Idempotent: ensure the landfolk plugin is symlinked into
  # ~/.hermes/plugins/ and enabled in config. The plugin owns
  # per-assignee kanban concurrency (gate-check + hooks). See
  # docs/features/landfolk-plugin.md.
  local plugin_src="$ROOT/plugins/landfolk"
  local plugin_dst="$HOME/.hermes/plugins/landfolk"

  if [ ! -d "$plugin_src" ]; then
    echo "  landfolk plugin source missing at $plugin_src — skipping install" >&2
    return 0
  fi

  # Symlink (idempotent — -fn replaces existing link, never follows a dir).
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: ln -sfn $plugin_src $plugin_dst"
  else
    mkdir -p "$(dirname "$plugin_dst")"
    ln -sfn "$plugin_src" "$plugin_dst"
    echo "  landfolk plugin symlinked: $plugin_dst -> $plugin_src"
  fi

  # Enable (idempotent — `hermes plugins enable` is a no-op if already on).
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: hermes plugins enable landfolk"
  else
    if hermes plugins enable landfolk >/dev/null 2>&1; then
      echo "  landfolk plugin enabled"
    else
      echo "  WARN: 'hermes plugins enable landfolk' returned non-zero — check 'hermes plugins list'" >&2
    fi
  fi
}

patch_kanban_config() {
  echo
  echo "===== ~/.hermes/config.yaml kanban orchestration ====="
  if [ "$DRY_RUN" = true ]; then
    echo "DRY: merge kanban.orchestrator_profile=steward auto_decompose=false"
    return 0
  fi
  python3 - "$HERMES_CONFIG" <<'PYEOF'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text() if path.is_file() else ""
lines = text.splitlines()
want = {
    "orchestrator_profile": "steward",
    "auto_decompose": "false",
    "auto_decompose_per_tick": "0",
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
        merged = {**want, **existing}
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
echo "  apply config: $APPLY_CONFIG"

for p in "${WORKER_PROFILES[@]}"; do
  setup_worker "$p"
done
setup_steward
install_landfolk_plugin
if [ "$APPLY_CONFIG" = true ]; then
  echo
  echo "===== --apply-config: SOUL/skills + kanban merge (skipped board/descriptions) ====="
  patch_kanban_config
else
  ensure_ops_board
  set_profile_descriptions
  patch_kanban_config
fi

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

# HermesCraft Dev Log

Running log of design decisions, bugs encountered, and solutions applied while developing the multi-agent Minecraft system.

## 2026-05-29 — worker board proxy + Steward kanban redesign (commit A)

Three genesis runs (`g-2026-05-27-10`, `g-2026-05-27-N`, `g-2026-05-28-4 round 9`) wedged on the same flag: `hermes kanban create --parent` overloads epic membership and real-prereq dependency onto a single argument. Steward SOUL (`prompts/landfolk/steward.md:68-82`) and the kanban-worker skill both carry dedicated interdiction sections telling the LLM "do not type this" — the warnings' existence IS the bug. Fix: split the kanban surface **by role**, not by syntax. Workers get a tiny verb set on a new CLI scoped to their active card; Steward keeps `scripts/kanban` but with action-oriented verbs (Commit B). The wedge becomes structurally unreachable from the worker surface even before Steward switches over. Underlying philosophy: workers are the agile team, Steward is product/PM — give each the surface their role actually needs.

Commit A (shipped today):
- **P0 schema** — `scripts/migrations/add_card_meta_cols.py` (idempotent) adds nullable `location_x/y/z` (INTEGER) + `size` (TEXT, CLI validates `S|M|L|XL`) to the `tasks` table. Locality enables nearest-worker dispatch; size enables learned time estimates from `created_at` → `completed_at` deltas (no hardcoded minute map). Tests: `scripts/tests/test_card_meta_migration.py`.
- **P1 worker CLI** — `scripts/wb` (Python, 5 verbs): `context`, `comment`, `close`, `block`, `escalate`. Reads go direct to sqlite (read-only URI); writes shell out to `hermes kanban` for event/lock-cascade consistency with the dispatcher. `wb context` folds card body + epic + siblings (titles/status only — scope-locked) + recent comments + bot pose into one call. `wb escalate` reuses `kanban_block` events with a `[!ESCALATED] ` prefix so Steward's forthcoming `kanban board` can surface a NEEDS REVIEW lane without a schema change. Tests: `scripts/tests/test_wb_environment.py`.
- **P5 worker portion** — `prompts/landfolk/flint.md` and `prompts/landfolk/mason.md` now have a "Worker proxy: `wb`" section; `wb context` is the documented first-turn orient command.
- **P6 pre-flight** — `scripts/tests/test_board_environment.sh` runs in ~1.3s, eight checks (wb help, no-env error, bogus-card error, live-DB columns, migration idempotency, `scripts/kanban` still operational, wb pytest, migration pytest). Designed for `scripts/genesis.sh` to call before bots come up.

Architectural invariant: **no patches to Hermes**. Schema changes are additive nullable columns; all CLI lives in `scripts/`; the bot layer changes for P4 are landing under a separate agent.

Queued for commit B: P2 Steward action-verb redesign (`promote`, `complete`, `block`, `unblock`, `resolve`, `archive`, `assign`, `set-after`, `edit`, `comment`, plus `add` with `--size`/`--at`), P3 consolidated read views (`kanban board` / `kanban epic <id>` / `kanban card <id>` — single-screen orient, ≤30 lines), P4 chat→comment auto-capture (shipping in parallel under another agent — `bot/server.js` hook + `scripts/lib/kanban_chat_comment.py`), P5 Steward SOUL rewrite (delete the wedge-warning section at line 68, swap to action verbs, add t-shirt-size + locality guidance), P7 genesis replay smoke test.

Design doc: [features/worker-board-proxy.md](../features/worker-board-proxy.md). Plan of record: `~/.claude/plans/investigate-the-open-points-wondrous-karp.md`.

## 2026-05-28 — CLI forgivingness sweep + B3 empirical analysis

Closed five agent-failure-mode bugs in the mc CLI parser surface from a single survey:
- `pillar_step/pillar_down` arg-schema type bug (`force`/`jump`/`pickup` declared as string instead of boolean — caused `Number("--force") = NaN` → "not_number" coercion failures). Commit `1f9ded5`.
- `--no-FLAG` boolean negation, universal across all 14 boolean specs. Commit `36240fa`.
- Engineering-shorthand directions (`+x`/`-z`/`plus_x` aliases) in `cardinalDelta`. Commit `36240fa`.
- Positional swap rescue: `mc collect 5 oak_log` (count/block transposed) now parses correctly via a (string, number) → (number, string) swap detector in `positionalToParams`. Commit `7589799`.
- Universal `@mark` token expansion in `executeHttp`: every coord-taking verb now accepts `mc dig @home` / `mc place block @corner1 @corner2`. Smoke-tested against live Tester. Commit `7589799`.

B3 (block/item name normalization in non-mining verbs — `mc place "Oak Planks"` style) was **DROPPED after empirical analysis**. New scripts `scripts/analyze-mc-name-shapes.py` and `scripts/analyze-mc-name-failures.py` scanned 5 days of cognition logs (flint + mason + steward, 58k tool_calls, 4587 mc <verb> <material> invocations): **99.74% of agent names are already canonical** lowercase+underscore mcData ids. The 12 non-canonical cases (0.26%) are all regex artifacts — prose, placeholder text, env var names. Of 91 observed `UNKNOWN_BLOCK` failures, ALL are SEMANTIC mistakes (plural `sticks`, conceptual `tree`/`village`, mcData-version-drift `grass`/`grass_path`/`wheat_crop`) — case/whitespace normalization would fix none of them. Ticket: [features/resolver-semantic-aliases.md](../features/resolver-semantic-aliases.md) for the right fix (extend `resolveBlockQuery`'s alias table).

## 2026-05-27 — genesis boot Core v1

Shipped operator tooling for repeatable fresh-world benchmarks: `scripts/genesis.sh`, `scripts/genesis_lib.py`, `scripts/genesis-snapshot.py`, `scripts/genesis-diff.py`, `scripts/genesis-phase-poller.py`, seven templates under `data/genesis/templates/`, Steward genesis doctrine in `prompts/landfolk/steward.md`, and `docs/guides/genesis-runbook.md`. Conventions: `--anchor X,Y,Z`, `SYSTEM_CHEST_{PRIMARY,OTHER,SIGN}_{X,Y,Z}`, run ids `g-YYYY-MM-DD-N`, `config.json` schema pinned. `system-chest.mjs` reads per-run env with legacy coord fallback. Acceptance tests: `scripts/tests/test_genesis_*.py`. v1.1 backlog: watch-rescues daemon, Paper/Cubiomes targets, plugin snapshot hook.

## 2026-05-31 — landfolk plugin Phase D closed

Phase 1 orchestrator migration in [features/landfolk-plugin.md](../features/landfolk-plugin.md) is **closed** without a new 6h lab soak. Verification used git + devlog + genesis `g-2026-05-30-3` findings (6h 21m, zero cards in `blocked`, no `queue-mutex:` block noise, nav self-recovery under gate-check). Confirmed: `73ab8cf` plugin, dispatcher gate-check only (~140 lines, no `enforce_assignee_mutex`), SOUL/skill mutex doctrine replaced by `mutex_park` / `orch_continuous`, `kanban-flow-cleanup.md` absent. **Not done:** recorded `task_links` mutex-artifact SQL audit on live board (optional). **Next plugin backlog:** Plan A `mark-drift` detector (`scripts/mark-drift.py` → `hermes landfolk detect`), Plan B `kanban_yield` / `wb yield` (partial progress without fake blocks) — spec appended to landfolk-plugin.md.

## 2026-05-27 (PM) — landfolk plugin shipped + safety patches

The plugin designed earlier today landed in commit `73ab8cf` (`landfolk plugin: per-assignee kanban concurrency via gate-check + hooks`). Phases A–C of the migration plan in [features/landfolk-plugin.md](../features/landfolk-plugin.md) are done: plugin installed under `plugins/landfolk/` and symlinked into `~/.hermes/plugins/`; `landfolk-dispatcher.sh` no longer contains `enforce_assignee_mutex` (net −260 lines); Steward + worker SOULs updated to reference plugin-driven mutex parking (`claim_lock=mutex_park:<assignee>` / `orch_continuous:<assignee>`) instead of `--parent` chains. Phase D closed 2026-05-31 (see devlog entry above).

Alongside, a cluster of safety/quality fixes from the day's session (most still on the working tree, not yet committed):

- **Base region protection.** `data/regions-world.json` cleaned up: removed `hut3`, `storage1`, `tower`, `wheat1` (unused or stale); flipped `base` + `hut1` from `intent: marker` to `intent: protect`. Marker intent had `allow_ad_hoc_dig: true` which let the resolver's ad-hoc-dig allow fire before `isProtectedInRegion` was consulted — bots were mining `cobblestone` from base walls because nothing refused them. With protect intent, `PROTECTED_BY_PROFILE.base` (cobble, planks, fences, doors, glass, stairs, slabs, dirt, grass_block) is honored. Guided builds still pass via `allow_guided_edit: true`; card workers use `mc task_context set <region_id>` for `WORKSITE_GRANT`.
- **`_nav-helpers.js` step-down classification.** `neighborStatus` now probes 3 cells deeper before declaring `no_support`. 1–3 block drops to flat ground classify as `step_down` (excluded from `cliff_dirs`); fixes Mason hitting `BOT_ON_PILLAR` 69× over 25 sessions when standing on a 1-block bump in flat grass.
- **`position-guard.js` drift invalidation.** Middleware now clears `lastMoveFailed` when the bot has physically moved >1.5 blocks from the recorded `actual_pos`, so `mc dig` after a `mc pillar_down` recovery isn't blocked by the stale flag.
- **`mc dig` post-dig breach detection.** New `detectPostDigBreach()` in `dig-tools.js`; `dig.js` returns `data.breach = {kind, breach_cell, source_cell, wet_neighbors, severity}` + `next_action_hint: "mc place <plug> X Y Z"` when water/lava floods the just-dug cell. Lava breaches mark `severity: critical` and suggest retreat-before-plug.
- **`mc find_blocks` fair-play hint.** Hardcoded `"needs trunk in sight"` was wrong for cobble/ore. New `fairPlayCollectNote(blockName, blockType)` branches: trunks → trunk-in-sight, plants → no note (proximity), solid blocks → line-of-sight.
- **`scripts/landfolk enable/disable` multi-player.** Accepted CSV but then passed the multi-line blob as a single arg to downstream helpers, which then looked up an `api_port` for the literal `"flint\nmason\nsteward"` and failed. Both verbs now loop and accept either space- or comma-separated names.

Test totals: 85/85 across affected suites (nav-helpers, position-guard, dig-tools, mining-scout, task-lifecycle).

## 2026-05-27 — landfolk Hermes plugin design (supersedes kanban-flow-cleanup)

Designed a single Hermes plugin named `landfolk` (`plugins/landfolk/`, symlinked to `~/.hermes/plugins/landfolk`) to own landfolk-specific extensions. Phase 1 = `orchestrator/` subsystem: per-assignee concurrency cap for the `landfolk-ops` kanban board. Replaces three independent userland mutex layers (Steward SOUL queue-mutex passes, worker SOUL `--parent` rule, dispatcher's 322-line inline Python chain-building) with one cohesive plugin using two narrow surfaces: an out-of-process `hermes landfolk gate-check` CLI verb run every dispatcher tick, plus `post_tool_call` observer hooks on `kanban_complete`/`kanban_block`/`kanban_create`/`kanban_unblock`/`kanban_archive`. Mutex mechanism is status-demote (`ready → todo`), NOT `task_links` chain construction — eliminates the link-overload bug class (`338cccd`, `198151e`, `1995335`). Hook policy: observer-only, never block tool calls — Steward's reasoning loop stays uninterrupted; the gate-check tick (≤60s) is the enforcement layer. SOUL changes ride alongside: worker first-turn spec review, worker in-place blocker resolution, Steward smaller-card discipline (split 120-unit cards into 32-unit chunks to avoid the iteration-budget-as-block class — 31% of historical blocks). Full plan + acceptance criteria: [features/landfolk-plugin.md](../features/landfolk-plugin.md). The previous `kanban-flow-cleanup.md` was deleted; its content is folded into the new doc.

## 2026-05-24 — kanban flow cleanup MVP (patch-free Steward loop)

Landfolk kanban MVP: Steward continuous loop no longer loads worker goals (`minecraft-goals` / focus hint gated by role), 60s orchestrator sleep, manual triage (`auto_decompose: false`), chat listener ingress-only, explicit assignee prompts/skills, pauser/supervisor off by default on `landfolk start`. Reverted local Hermes kanban patches; snapshot in `reports/expedition/2026-05-24-hermes-framework-patches.patch`. Plan + acceptance: [features/kanban-flow-cleanup.md](../features/kanban-flow-cleanup.md).

## 2026-05-23 — canonical ground functional arena

Functional harness resets a 65×65 grass plane at origin each test
(`reset_ground_arena`), session stone substrate y=50–59, park at
`(0, 65, 0)`. Removed redundant `flat_arena` fixtures; stair/water/mining
outliers moved to surface. Added `/clone` prefab vault, `check-arena-coords.py`,
lab/mining zone markers.

## 2026-05-23 — lean functional test infrastructure

Harness now runs `rescue_tester` + `arena.clean()` once per test; session
`_tester_bot_ready_once`; dropped per-test `move_to_safe`. Added
`Arena.reset_workspace`, settle profiles, `place_player` floor assertions,
RconClient SSH multiplex + `count_blocks_in_box`, profile scripts, and
`@slow` on long mining/wait tests. Fill performance table in
`docs/archive/test-inventory.md` after a local full run.

## Session: 2026-05-18 — functional-test remediation (continuation)

Continuing the previous session's triage of the functional-test suite
against the live Tester bot. The starting point (per `.claude/plans/
please-review-the-recent-vectorized-boole.md`) was 4 remaining failures.
Per-failure verdict + fix below.

### 1. `test_F57_3_successful_escape_carries_do_not_retry_goto`

**Verdict**: observability infra corrupting SUT. `do_not_retry_goto`
came back null even though `mc escape` correctly classified the corner
and sidestepped. Root cause: the autouse `bot_trace` fixture
(`tests/_lib/trace.py`) polls `GET /status?lean=true` every 0.4s, and
that endpoint clears `ctx.runtime.lastMoveFailed` (F51.2/F58 contract
for the agent's `mc status` rethink). Trace was wiping the flag
between the goto-fail and the escape on every test.

**Fix** (`fa62575`): added `?preserve=true` to GET /status — opt-out
for diagnostic callers that need a non-mutating read. Carve-out
preserves the agent's `mc status` reset semantics (no flag → still
clears, verified by `test_status_clears_precondition_flag`). Wired
preserve into: `BotClient.status_lean`, `BotTrace` poller, dashboard
modal-detail poll, agent-test early-exit watchdog.

### 2. `test_F57_1_escape_recurring_loop_after_3_within_90s`

**Verdict**: same root cause as F57_3. `bot_trace` was also clearing
`ctx.runtime.recentEscapes` every 0.4s, so the F57.1 loop detector
(`queries.js:391-394`) never saw a 3rd entry within 90s. Live evidence:
4 sequential escapes all returned `OK`, never `ESCAPE_RECURRING_LOOP`.

**Fix**: subsumed by the same `?preserve=true` change.

### 3. `test_collect_eighteen_blocks_height2`

**Verdict**: test contract too strict. The verb is functioning
correctly — curl repro yields `mined_count=17, attempted=19, causes={
pathfind_failed:1, behind_wall:1 }` in 23.6s. Graceful exit with full
structured context. Per user steer, the test's purpose is NOT to
assert perfect throughput (mineflayer auto-magnet timing + occasional
LOS-blocked corner blocks make 18/18 non-deterministic), it's to
prove the bot doesn't hang / wedge / blow past the outer cap, and
that partial results carry actionable context back to the agent.

**Fix**: rewrote `_run_collect_scenario` to assert: (1) no wedge
(elapsed < 45s), (2) on partial, `causes` dict + `partial_failure:
true` are present, (3) `mined_count ≥ ceil(want_count * 0.85)`.
Threshold gives 1 miss on 9-block runs, 2 on 18, strict on 1. All 4
grid scenarios pass.

### 4. `test_goto_into_solid_in_alley_carries_standing_state`

**Verdict**: test asserted obsolete contract. With the #102 Y-grace
patch in `movement.js:412`, a goto to a solid target now searches
y±5 for a standable cell; if it finds one (e.g. y+2 on a flat stone
floor), pathfinder runs against the real terrain and returns
`NAV_BLOCKED` with the y-shifted target. The previous
`NAV_TARGET_OCCUPIED` only fires when Y-grace finds no standable Y.
The standing-state enrichment (`classification='alley'`,
`blocked_dirs=[N,S]`, plus new `closest_standable` and
`next_hop_suggestion`) is still attached on the new code path.

**Fix**: accept either `NAV_TARGET_OCCUPIED` or `NAV_BLOCKED` for
this scenario; the regression-relevant signal — standing-state on
movement failure — remains the primary assertion. The docstring
explains why.

### Framework note — the F58 contract decision

Per the plan's verification step 3, the `/status` F51.2/F58 contract
is now: agent's `mc status` (GET /status without `preserve=true`)
clears `lastMoveFailed` + `recentEscapes` + `recentStuckCells`.
Diagnostic GETs (`preserve=true`) leave state alone. The unused
POST `/action/status` clear at `http-app.js:558` is dead but harmless
— no caller hits it (mc status maps to GET via `registry.mjs:35`).

### Full-suite verification

Cold-run full functional pass after the 4 fixes (fresh Tester,
landfolk-test on ubuntu-host): **139 passed, 2 failed, 1 skipped, 6
xfailed, 8 xpassed in 1691.88s**. Down from the session-start 4
failures.

The 2 remaining failures are **cumulative-state cascade flakes** — both
pass cleanly when re-run in isolation on a fresh bot:

- `test_collect_eighteen_blocks_height2` — passes standalone in 25s;
  fails inside the suite after ~90 prior tests have left arena state
  + bot position fragmented. Same family of flakes as the documented
  `test_build_then_navigate[*]` XPASS set.
- `test_wait_chat_interrupt::test_wait_interrupts_on_at_mention` —
  passes standalone (40s for the pair). Likely residual chat-handler
  / wait-task state from prior tests; outside the plan's scope.

Plan acceptance bar was ≤1 failing on cold-run with a doc note for
the remainder. We're at 2, both standalone-clean. Next session can
either land the framework changes from Phase 3 of the plan (audit
fixtures still doing raw `tp Tester ...` without `place_player` or
flat_arena pre-place) or accept the current state.

### Commits this session
- `fa62575` http+tests: ?preserve=true on GET /status; trace + dashboard opt in
- (next commit) tests: height-2 collect contract by percentage; alley goto accepts NAV_BLOCKED post-Y-grace

---

## Session: May 8-9, 2026

### Overview

This session focused on stabilizing multi-agent operations (Gatherer, Flint, Mason, Barley), fixing crafting failures, hardening process management, and improving agent behavior through better prompts. The system runs on a homelab Paper 1.21.4 server with Mineflayer bots controlled by LLM agents via OpenRouter.

---

### 1. Process management and agent isolation

**Problem**: Agents were killing each other's bot processes. The LLM agents discovered they had shell access and started running `ps`, `grep`, `xargs`, `kill -9` to terminate processes they thought were stuck -- including other agents' bots. This caused cascading failures where bots would go down, restart, get killed again, and so on.

**Root cause**: Hermes agent subshells had full access to system commands. An agent trying to "fix" a problem would find processes with `ps aux | grep node` and kill them indiscriminately.

**Solution (layered)**:
1. Expanded the `restricted-bin` PATH blocklist in `landfolk-control.sh` to include: `ps`, `xargs`, `pgrep`, `top`, `htop`, `fuser`, `nohup`, `tee`, `wc`, `sort`, `uniq`, `dd` -- anything useful for process discovery or termination.
2. Disabled the bash `kill` builtin by setting `BASH_ENV` to source a script containing `enable -n kill`. This forces any `kill` command to go through the restricted PATH (which blocks it), even though `kill` is normally a shell builtin that bypasses PATH.
3. Added a bot auto-restart loop with proper signal handling: `trap '' HUP` to survive parent script exit, `trap '_bot_stop=true; kill %1' TERM INT` for clean shutdown. Bots now automatically restart after crashes but can still be stopped cleanly by `landfolk-control.sh stop`.

**Status**: Resolved. Agents can no longer interfere with each other's processes.

---

### 2. Crafting recipe variant selection

**Problem**: Mason could not craft sticks. The `craft_plan` command reported "missing: pale_oak_planks" even though Mason had `oak_log` in inventory. The bot was selecting a recipe variant requiring `pale_oak_planks` instead of `oak_planks`.

**Root cause**: Mineflayer's `recipesFor()` returns multiple recipe variants for items like sticks (one per plank type). The code was using `recipes[0]` as default, which happened to be the `pale_oak_planks` variant. With no `pale_oak_planks` in inventory, the craft failed -- even though `oak_log` was available and could be crafted into `oak_planks`.

**Solution**: Implemented `bestRecipeForInventory()` in `bot/lib/shared/recipe-ingredients.js`. This function:
- Scores each recipe variant against the bot's current inventory
- Considers raw materials that can be sub-crafted (e.g., `oak_log` -> `oak_planks` via the `LOG_TO_PLANKS` map)
- Picks the variant with the highest coverage score
- Falls back to `recipes[0]` only when all variants score equally (empty inventory)

The function was extracted into the shared module along with `recipeIngredientMap()` and `buildCraftPlanFromRecipes()` so they can be unit tested independently.

**Testing**: 20 unit tests cover recipe ingredient extraction, inventory-aware variant selection (including log-to-plank inference), craft plan generation with missing/have/chest data, and edge cases. All pass.

**Status**: Resolved. The logic is proven correct by tests. When a bot has `oak_log`, it will select the `oak_planks` recipe variant for sticks.

---

### 3. Smelting failures

**Problem**: Agents would drop items in a chest, walk to a furnace to smelt, and discover the items weren't in their inventory anymore. Separately, furnaces would get blocked by finished output, preventing new smelting jobs.

**Solutions**:
- Enhanced `smelt` action with wider furnace search radius, pathfinding to the furnace, and pre-smelt clearing of output/input slots.
- Added furnace output + storage protocol to agent prompts: check furnace output before starting new smelt jobs, take output immediately, deposit to chests.

**Status**: Improved. Agents now handle furnaces more reliably, though the occasional "walked away from items" issue can still happen if the agent deposits at a chest and then travels to a distant furnace.

---

### 4. Agent communication

**Problem**: Agents worked in silence. They didn't announce what they were doing, didn't report blockers, didn't ask for help, and didn't respond to other agents' chat messages. This led to duplicated work and missed coordination opportunities.

**Solution**: Added a "Team communication protocol (required)" section to all 8 agent prompts (`prompts/landfolk/*.md`). The protocol enforces:
- **Announce** what you're doing before each task (one short `mc chat` line)
- **Report** results and blockers after completing or failing
- **Ask for help** when stuck on something another agent could provide
- **Read and respond** to chat every planning cycle (`mc read_chat`)
- Keep style short and factual -- one line, no fluff

Each agent's protocol section includes role-specific examples (mining for Flint, defense for Mason, food for Gatherer, etc.).

**Status**: Implemented in prompts. Takes effect on agent restart.

---

### 5. Agent priority misalignment

**Problem**: Agents were chasing the wrong priorities.

- **Mason** was over-focused on crafting arrows (which require feathers from chickens, string from spiders, flint from gravel) while the base had no walls, fences, or doors. He'd burn through wild chickens unsustainably.
- **Flint** would hunt for diamonds while the base had no iron or coal supply. He'd spend rounds looking for exposed diamond blocks instead of building productive tunnels.
- **Gatherer** had no specific food strategies and would do generic "gather trips" without understanding that fishing is trivially easy or that wheat farms are low-maintenance.

**Solutions**:

**Mason prompt rewrite** -- explicit priority order:
1. Base defense structures (walls, moats, fences, doors, lighting)
2. Melee weapons (stone/iron swords -- cheap, no rare materials)
3. Ranged weapons (only after setting up a chicken farm for feathers)
4. Patrol and maintenance

Added a full "Chicken farm" section teaching breeding mechanics: build a fenced pen, lure chickens with seeds, breed, never kill below 6, harvest excess. This replaces the unsustainable "hunt chickens" approach. Also added moat-digging, kill zones, and prioritized sword crafting over bows.

**Flint prompt rewrite** -- explicit priority order:
1. Iron and coal (always first)
2. Cobblestone and gravel (naturally produced)
3. Mine infrastructure (tunnels, stairs, lighting, chests)
4. Copper/redstone/lapis (mine when encountered, don't hunt)
5. Gold/diamond/emerald (mine when exposed, not top priority)

Key rule: "When the base chest has less than 32 iron ingots or 32 coal, that's your top priority."

Added "Mine infrastructure" as a major section ("this is half your job") with a setup checklist, maintenance schedule, and the principle "build tunnels, ore comes to you" instead of hunting individual blocks.

**Gatherer prompt rewrite** -- food strategies ranked by effort:
1. Fishing (lowest effort -- craft rod, find water, fish)
2. Simple crops (plant wheat, craft bread)
3. Animal hunting (only when encountered during other trips)
4. Berry bushes (grab when passing by)

**Status**: Implemented in prompts. Takes effect on agent restart.

---

### 6. PaperMCP integration

**Problem**: Needed server-side commands (`/spawnpoint`, `/kill`, `/setworldspawn`) for respawn mechanics and home-setting that aren't available through Mineflayer alone.

**Solution**: Implemented `bot/lib/bot/paper-mcp.js` for WebSocket communication with the PaperMCP plugin. Added `set_home` (sets individual respawn point) and `respawn` (kills player to trigger respawn) actions. Authentication uses a token stored in `.env` (not checked into git).

**Caveat**: PaperMCP requires explicit command whitelisting. Commands were whitelisted via PaperMCP's `edit_file` tool, but changes require `papermcp reload` on the server to take effect.

**Status**: Working. Token secured in `.env`, added to `.gitignore`.

---

### 7. Dashboard improvements

**Problem**: Dashboard mixed information between agents (wrong model, wrong position), showed "wrong user" for agents on an open LAN server, and spammed console with `ERR_CONNECTION_REFUSED` for offline agents.

**Solutions**:
- Dynamic agent discovery based on which ports respond to `/health`
- Trust agent name from the bot (no account verification on open LAN)
- Added uptime, equipped item, movement rate, and current state to agent cards
- Richer action summaries ("dig 23 blocks" instead of just "dig")
- Compact activity feed
- Rate-limited dead port rescans to reduce console noise

**Status**: Working.

---

### 8. Goal engine "goal was changed" errors

**Problem**: Bots frequently got stuck with "goal was changed" errors when background pathfinder tasks conflicted with synchronous API actions.

**Solution**: Introduced `ctx.syncActionInFlight` flag, guarded watchdog logic to not cancel during sync actions, and ensured background pathfinder goals are explicitly cleared before executing synchronous API actions.

**Status**: Improved. Occasional conflicts still possible but much rarer.

---

### 9. LLM model performance

**Findings from testing various OpenRouter models**:

| Model | Observations |
|-------|-------------|
| DeepSeek V4 Flash | Best overall. Good tool calling, follows instructions, affordable. |
| Nemotron 120B (free) | Decent but sometimes runs commands without thinking text. Slower. |
| Tencent HY3 Preview (free) | Occasional hallucinations. Works for simple roles. |
| Small/free models | Struggle with crafting sequences, hallucinate ports and coordinates. |

**Current assignments** (in `data/agent-models.json`):
- Gatherer, Mason: `deepseek/deepseek-v4-flash`
- Flint, Barley: `nvidia/nemotron-3-super-120b-a12b:free`

**Minimum requirements**: 64K context, reliable tool calling. Free-tier rate limits can cause stalling with multiple agents on the same provider.

---

### Current challenges

1. **Prompt compliance**: Agents don't always follow prompt instructions precisely. Priority orders, communication rules, and safety protocols are sometimes ignored, especially by weaker models. More structured prompts help but don't guarantee compliance.

2. **Recipe edge cases**: When a bot has zero relevant materials, all recipe variants score equally and the system falls back to `recipes[0]`, which may be an exotic plank type. This is correct behavior (can't prefer what you don't have) but can produce confusing `craft_plan` output.

3. **Furnace logistics**: The deposit-then-smelt pattern still has a gap where agents deposit materials to a chest and then walk to a distant furnace empty-handed. Better spatial awareness of furnace-near-chest setups would help.

4. **Pathfinder reliability**: Mineflayer's pathfinder occasionally fails in complex terrain (caves, multi-level structures, water). Agents have `stair_up` and `pillar_step` as manual fallbacks, but some still get stuck in loops trying `goto` repeatedly.

5. **Inter-agent coordination**: Chat-based communication is now prompted but it's advisory -- agents may still ignore messages or fail to read chat. A more structured request/response system (beyond the current `commandQueue`) could improve reliability.

6. **Model costs**: Running 4 agents simultaneously on paid models adds up. Free-tier models work for simple roles but struggle with complex multi-step tasks like crafting chains or building structures.

---

### Code structure changes this session

- `bot/lib/shared/recipe-ingredients.js` -- extracted `recipeIngredientMap`, `bestRecipeForInventory`, `buildCraftPlanFromRecipes` from server.js for testability
- `bot/server.js` -- main entry; crafting helpers imported from `lib/shared/recipe-ingredients.js`
- `bot/mason-server.js` -- imports `server.js` so profile launchers can use a second script name without duplicating the entrypoint
- `bot/test/crafting.test.js` and `bot/test/recipe-ingredients.test.js` -- unit tests for recipe planning helpers
- `scripts/landfolk-control.sh` -- expanded restricted-bin blocklist, bash builtin disabling, bot restart loop with signal handling
- `prompts/landfolk/*.md` -- all 8 agent prompts updated with communication protocol; Flint, Mason, Gatherer substantially rewritten with priority orders and detailed strategies
- `bot/lib/bot/paper-mcp.js` -- PaperMCP WebSocket integration
- `bot/dashboard.html` -- dynamic agent discovery, richer metrics, reduced console noise

---

## Session: May 10-18, 2026

### Overview

Two weeks of single-player focus: Steve became "re44's helpful Minecraft buddy" alongside the user (re44). Multi-agent (Mason / Barley / Gatherer) work paused. Most of the effort went into mining/navigation primitives that kept failing in subtle ways during real play, and into a serious context-bloat investigation that dominated the back end of the period.

The pre-existing devlog ended at the post-refactor stabilisation of multi-agent operations. From there, the agent-experience layer was the bottleneck — Steve's plans were fine, the primitives kept letting him down.

---

### 1. PaperMCP craft fallback (issue #98)

**Problem**: `mc craft oak_fence` would silently no-op on Paper 1.21 even with full ingredients. mineflayer's `b.craft` returns delta=0 (or sometimes throws "missing ingredients") for some 3×3 recipes; a race in the click sequence vs. the open-window packet.

**Solution**: When `paperMcpConfig()` is set and ingredients ARE present, fall through to a PaperMCP server-side craft (`execute as <bot> run ...`). Wired into both the delta=0 path and the throw-with-"missing" path in `bot/lib/actions/crafting.js`. Token (`PAPERMCP_TOKEN`) is now sourced from the repo-local `.env` by `hermescraft.sh` (it was only being read from `~/.hermes/.env` before, which made the fallback silently dormant).

**Status**: Verified in-game: `Crafted oak_fence x3 (server-side fallback)`.

---

### 2. Vertical movement: pillar_down + on_pillar awareness (#99)

**Problem**: Steve would `pillar_step` up to reach a treetop or ledge and then get stuck at the top — pathfinder refused to plan because every cardinal neighbour was a cliff. The agent kept looping `mc move` with no progress signal that would help it self-correct.

**Solution (three parts)**:
1. New `'on_pillar'` classification in `standingState()` (`_nav-helpers.js`): all 4 cardinals are cliffs.
2. `mc move` / `goto` / `goto_near` preflight refuses early with `BOT_ON_PILLAR` and a `next_action_hint: mc pillar_down N`.
3. New `mc pillar_down` action in `actions/excavation.js` — mines block-underfoot, drops one, repeats until ground (3+ cardinal cells with solid floor) or until lava/void/bedrock stops it.

Also reordered the `pillar_step` block cascade to prefer dirt/sand/gravel/netherrack first, falling back to cobblestone. Saves the agent from pillaring up with cobble when dirt is available and easier to re-mine.

---

### 3. Autonomous chores (#89)

**Problem**: Steve was idle whenever re44 wasn't directing him.

**Solution**: New `minecraft-chores` skill — preloaded in `hermescraft.sh -s minecraft-goals,minecraft-navigation,minecraft-chores`. Defines a priority cycle for idle time: source food (hunt / breed / fish / harvest), cook, smelt ore, stock crafting staples (planks/sticks/torches), plant saplings, organize chests. The soul prompt (`prompts/landfolk/steve.md`) was expanded with bootstrap rules ("from zero: chop wood with hands → planks → sticks → wooden_pickaxe → cobble → stone_pickaxe"), tree-cutting rules ("never chop a sapling, never chop fewer than 4 stacked log blocks"), and a "goal scoreboard caveat" clarifying that `mc goals` is BASE stockpile (inventory + chests) not personal inventory — so chest withdraws are for USE only, not for satisfying a stockpile gap.

---

### 4. Mining-primitive cleanups (the punch list from session #1)

After watching Steve mine, four recurring failures surfaced:

- **Y-grace fallback in mc goto/goto_near/move (#102)**: agent's coord guesses for Y were often a few blocks off (aiming at a hill top, ending up inside the hill). Now: ±5 same-XZ vertical search; on success the response carries `observed_state.y_adjusted: {from,to,dy,reason}` so the brain learns the right Y next time. Replaces premature `NAV_TARGET_UNSTANDABLE` / `NAV_TARGET_OCCUPIED` refusals.
- **recentPlaces exemption (#101)**: bot couldn't tear down its own chicken-pen fences ("chop it down, make it bigger" → 7 straight `PROTECTED_BLOCK` refusals). New `ctx.runtime.recentPlaces` ring buffer (15-min TTL, capped at 64) — agent-placed cells in `PROTECTED_DIG_BLOCKS` are now exempt from `isDigProtected`. Wired into all 6 placement verbs and all 7 isDigProtected call sites.
- **auto-mark crafting tables (#100)**: agent kept placing new tables instead of reusing existing ones. `mc craft` now auto-saves a `craft_table_X_Y_Z` mark on every successful craft AND on every `mc place crafting_table`. The existing `/craft/i` regex in the marks fallback picks them up from any distance. Idempotent within 3 blocks.
- **mc inspect / mc place hints (carryover from earlier)**: `is_diggable` on inspect now reflects the recentPlaces exemption so the agent knows it CAN re-mine its own builds.

---

### 5. Context-bloat postmortem (May 17 → 18)

**Symptom**: Steve sessions ballooning to 311k tokens with no compression event ever firing.

**Investigation summary** (full details in this devlog's git blame):

| finding | impact |
|---|---|
| deepseek-v4-flash context window = 1,048,576 tokens; `compression.threshold: 0.3` → fires at 314,572 | confirmed compression IS configured correctly |
| `Auxiliary auto-detect` was healthy for the live session — compression fired exactly once at ~417k | not a config-broken issue |
| Session resumed and grew back to 311k before we killed it — would have triggered next compression at 314k | trim, not bug |
| **`<available_skills>` block in system_prompt = 2,889 tokens per call** — Hermes injects all 101 globally-available skills | **biggest fixable bloat** |
| MEMORY block 98% full (2,165/2,200 chars) with stale Flint-era iron-ingot quest notes | small but trivially purgeable |
| Tools schema 13.7KB ≈ 3,416 tokens per call (fixed overhead) | unfixable here — Hermes-level concern |
| `mc terrain_top` shipped a `columns` array (radius=4 → 81 cells × 35B ≈ 2.8K per call) | **fixable; default-off now** |
| `mc goals` payload had verbose per-goal fields (strategies_available, constraints, metric, time_in_deficit_s) — ~50% of payload | fixable; lean shape default now |
| `player_requests` carried a 100B `hint` string per request, capped at 5 entries | fixable; lifted hint once, capped 3, truncate 140 chars |
| `cli/results.mjs` double-emitted `state` when server returned a flat shape (`equip` etc.) | bug; fixed |

**Quick wins applied (May 18 evening)**:
1. Memory purge: `~/.hermes/memories/MEMORY.md` 2183 → 1071 chars (−278 tokens/call).
2. Skills scoping: `skills.platform_disabled.hermescraft` in `~/.hermes/config.yaml` disables 90 non-Minecraft skills; activated via `HERMES_PLATFORM=hermescraft` exported by `hermescraft.sh` (−2,800 tokens/call).
3. Compression threshold 0.3 → 0.2: compress at ~210k instead of ~315k.
4. Code-side trims: `terrain_top` drops `columns` by default, `mc goals` lean shape, `player_requests` cap + truncate, `cli/results.mjs` state-dup fix.

Combined: ~3,100 tokens/call saved × ~700 calls/session = ~2.2M tokens of avoided traffic per long Steve run.

---

### 6. Code structure changes this period

- `bot/lib/actions/_nav-helpers.js` (new) — `findClosestStandable`, `findStandableSameXZ`, `standabilityReason`, `standingState`, `computeReachability`, `annotateReachability` extracted from `movement.js`. Single home for navigation queries used by movement, find, find_blocks, inspect.
- `bot/lib/actions/excavation.js` — `pillar_down` added; `stair_up` now clears the head cell before each step.
- `bot/lib/runtime/dig-tools.js` — `isDigProtected(name, cell?, ctx?)` accepts optional cell + ctx for the recentPlaces exemption; new `recordRecentPlace(ctx, cell, blockName)`.
- `bot/lib/server/state.js` — new `recentPlaces` slice in `runtime`.
- `bot/lib/runtime/observation.js` — `briefState` trimmed (no nearby_utilities, no spawn_point); `player_requests` capped + truncated.
- `bot/lib/server/http-app.js` — `/goals` lean by default, `?full=true` for the dashboard.
- `bot/cli/results.mjs` — flat-shape envelope no longer double-emits `state`.
- `bot/lib/actions/crafting.js` — `autoMarkCraftingTable` helper exposed on services; wired into both normal-craft and PaperMCP-fallback success paths.
- `bot/lib/actions/building.js` — `mc place crafting_table` auto-marks; every successful placement records to `recentPlaces`.
- `skills/minecraft-chores.md`, `skills/minecraft-navigation.md` — new + revised skill docs.
- `prompts/landfolk/steve.md` — substantially rewritten (priority order, autonomous chores, mining bootstrap, tree rules, goal-scoreboard caveat).
- `hermescraft.sh` — sources repo-local `.env` (for `PAPERMCP_TOKEN`), preloads `skills` toolset (so `skill_view` works), exports `HERMES_PLATFORM=hermescraft`, persists `SESSION_ID` to a file for proper `--continue` rounds.

---

### Carry-overs / open items

1. ~~**mc collect "Digging aborted" cascade**~~ — RESOLVED in `3abfd40`. Root cause was *not* mineflayer's "Digging aborted" (the existing anti-cascade catches that); it was `guardSlowDigEstimate` in `equipForDig` throwing *before* the dig starts ("Refusing to dig stone with empty hand — ~375s break time ≥ 280 ticks"). The previous catch branch treated this as a per-candidate dig failure and burned every candidate in the pool. Now detected via `digStartedAt === 0 && /^Refusing to dig/` and bailed with `TOOL_INADEQUATE`. Test: `bot/test/actions/mining.test.js: pre-dig tool refusal bails`.
2. ~~**F72 short-circuit**~~ — AUDITED, correct by design. F72 is structurally narrow: requires both `recentPickups[item] >= count` AND `currentInventory[item] >= count`. Agents only call `mc collect` when they're short, so the inventory guard is rarely true at call time → F72 stays dormant in normal play. The functional-test logs (`bot-flint.log`, `bot-Tester.log`) confirm it fires when conditions are met. Insurance against a goal-engine-driven redundant call (when `mc goals` BASE stockpile counts inventory + chests), not a primary fast-path.
3. ~~**Strip-mine ordering**~~ — DONE in `623cd80` (initial), hardened in `6656215` (strip-plane + perp anchor lock) and `1262d0f` (contiguity over thin-strip ratio). `stripSort` in `mining.js:445` sorts by Y plane → signed perp offset → bot-following strip-axis march, with perp anchor locked at the bot's initial integer block so refreshPool doesn't drift the order. Unit test: `mining.test.js:340 "non-trunk sort follows the bot row before stepping to next row"`. Functional test: `tests/functional/mining/test_strip_flatten.py`.
4. **Hermes-side bloat (out of scope for this repo)**: `<available_skills>` listing is now trimmed via `platform_disabled`; tools schema (13.7K) is the remaining unfixable-from-this-repo per-call cost.

All session #1 mining-primitive punch-list items are now resolved or documented. Next mining-primitives session should focus on observation: re-launch Steve with the trim + cascade fixes in place and watch for new failure modes rather than chasing the now-resolved ones.


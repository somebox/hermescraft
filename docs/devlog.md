# HermesCraft Dev Log

Running log of design decisions, bugs encountered, and solutions applied while developing the multi-agent Minecraft system.

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

1. **mc collect "Digging aborted" cascade** (mining.js): same-second clusters of instant rejections (~10ms each) — inner-loop candidate burn from stale pathfinder state. Not yet root-caused.
2. **F72 short-circuit** (recent-dig pickup): logs show it never fires in practice. Probably the guard is just narrow by design — verify before changing.
3. **Strip-mine ordering**: `mc collect` sorts candidates by 3D euclidean distance, producing a "star pattern" of holes around the bot near the base. Should prefer same-y-level strip layout. Punch-list item from session #1, still open.
4. **Hermes-side bloat (out of scope for this repo)**: `<available_skills>` listing is now trimmed via `platform_disabled`; tools schema (13.7K) is the remaining unfixable-from-this-repo per-call cost.
5. **28 uncommitted files** from this period still in working tree: dashboard/, prompts/landfolk/steve-steward-mode.md, skills/minecraft-chores.md (already integrated into the soul but un-staged), READMEs, start-dashboard.sh, landfolk.sh, scripts/run-landfolk-bots.sh. Worth a sweep to either land or discard.


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

# Flint iron-mining postmortem — deep-shaft entrapment

**Date:** 2026-05-24
**Task:** `t_f3cd625c` — *Craft a hoe and water bucket if missing from base storage*
**Worker:** Flint kanban-worker (run #12, PID 76226)
**Outcome:** Self-blocked at iteration 90/90; user teleported back to base; task `blocked`.

## What happened

1. Survey parent (`t_af41736a`) finished. Decompose-linked craft card unlocked.
2. Worker spawned, took stock: base chests had no `iron_ingot`. Water-bucket recipe needs 3.
3. Crafted a stone_pickaxe on-site (no prior mining tools available).
4. Searched for surface iron — `mc find_blocks iron_ore 50` returned hits at deeper Y.
5. Worker dug a **1-wide manual staircase** from y=64 down to y=15 with `mc dig --force` (5 steps: 19→18→17→16→15).
6. Found `iron_ore` at `(349, 11, -626)` — visible via `mc nearby`.
7. **Got wedged in the 1×1 shaft at (351, 15, -630):**
   - Could not `mc dig` sideways because line-of-sight checks failed (`Cannot see stone — block between you and target`).
   - Could not `mc escape`/pillar-up: ran out of placeable blocks in inventory.
   - `mc goto` to adjacent cells returned `NAV_TARGET_UNSTANDABLE` (cave walls = solid).
8. Worker burned remaining iterations trying `mc dig` / `mc escape` / `mc goto` permutations.
9. At iteration 90/90, worker self-blocked with `Iteration budget exhausted`.

## Root causes (ranked)

1. **Pre-mining checklist was not enforced.** Steve's SOUL (`prompts/landfolk/steve.md`) has a hard "big-four checklist" — wood, food, tools, **torches**, *and implicitly enough blocks to pillar*. The Flint SOUL/skills do not bake this in for the kanban-worker code path. Result: descended with 0 dirt/cobble, no recovery options.
2. **No "if-stuck-mining" pivot heuristic.** Once the line-of-sight error fires a few times, the worker should recognize "I am in a 1×1 shaft and cannot make progress sideways" and either widen the shaft (dig 3-wide) or pillar back up. Instead it iterated the same failing primitive.
3. **`mc collect iron_ore N` was never tried.** That primitive has its own embedded pathfinder which can navigate through cave terrain to reach a known ore. The worker hand-rolled the descent instead. (Reminder: `mc collect` was Steve's life-saving workaround for the const bug last session — same principle applies here.)
4. **No "abort-and-block-up" deadline.** Worker had no time/iteration-share budget for "if I'm not making progress on a sub-goal after N attempts, surface and report." It kept trying until the global cap killed it.
5. **`mc dig --force` is too easy to escalate to.** Bypassing the LOS / protection checks felt like the way out but each `--force` step burned an iteration without checking whether the *next* step would be reachable.

## Concrete skill improvements

### A. Mining-prep checklist (SOUL change)

Add to `SOUL-landfolk.md` under a new **"Underground discipline"** section:

> Before descending below your spawn Y by more than 5 blocks:
> - **64+ cobblestone or dirt** in inventory (for pillaring, bridging, walling off).
> - **Torches ≥ 16** (light the descent + mark the way back).
> - **2 pickaxes** (or 1 pickaxe + sticks/cobble for a backup craft).
> - **Food ≥ 8** cooked.
>
> If any of these aren't met, surface first. A bot that can't get out is a bot that dies; a dead bot loses all the cobble anyway.

Steve's `prompts/landfolk/steve.md` already has lines 114-124 with this content (the "big three" / "big four"). Hoist into the shared SOUL so Flint/Mason/Gatherer inherit.

### B. "Stuck mining" recognition + pivot (SOUL or skill)

Add to the chores/mining skill:

> If you hit 3 consecutive `mc dig` or `mc goto` errors at the same target, **stop digging** and do ONE of:
> 1. `mc collect <target_block> N` — let the body's pathfinder route there.
> 2. Widen the shaft to 3 blocks before continuing.
> 3. Surface (`mc stair_up`) and re-plan.
>
> Do NOT re-try the same failing primitive 5+ times — that's how the iteration budget gets burned.

### C. Prefer high-level primitives over hand-rolled descent

Add a "primitives ladder" note: for mining, `mc collect ore_name N` > `mc stair_down dir N` > `mc dig <each block>`. The bot already has these — the worker just needs reminders to use them.

### D. Iteration budget hint in worker SOUL

Surface the budget. Add early in the SOUL or kanban-worker skill:

> Your iteration budget is 90 turns. Every `mc` call counts. **Spend the first 5 on planning** (read chat, check inventory, mc marks, mc craft_plan), and **keep 10 in reserve** for completion + reporting. If a sub-goal is eating > 20 turns without progress, surface a `kanban_comment` describing what's stuck and either abandon or escalate via `kanban_block`.

### E. Optional: add `mc safe_descent N` primitive

A higher-level body primitive that:
1. Checks the pre-mining checklist (errors out if missing materials).
2. Digs a **3-wide** stair-down with auto-torch placement every 6 blocks.
3. Records the entry coord as a `mc mark return_to_surface`.
4. Returns success only when standing on the target Y in walkable space.

Single primitive replaces the 5+ `mc dig --force` + manual torch + manual return-mark sequence. Future mining tasks become one call instead of an iteration-burning hand-roll.

## Quick wins (do first)

1. **Hoist Steve's mining checklist into `SOUL-landfolk.md`** so Flint sees it. 10-line edit.
2. **Add "stuck mining = use `mc collect`" to the skill.** 5-line edit.
3. Re-dispatch `t_f3cd625c` against the updated SOUL.

## Open questions

- Does `mc collect iron_ore N` reliably navigate cave terrain to a known ore from y=64 surface? Worth a smoke test before relying on it.
- Should kanban-worker iteration cap be higher for ops cards involving mining (currently 90 — maybe 150-200 for `[SUPPLY]` cards)?
- Should the gateway / kanban-worker spawn a `[SUPPLY]` precursor task automatically when a craft card's recipe needs an item the bot doesn't have? (e.g. "before crafting water_bucket, supply 3 iron_ingot")

## Telemetry

- Session: `~/.hermes/profiles/flint/sessions/session_20260524_004547_29d81e.json`
- Workspace: `~/.hermes/kanban/boards/landfolk-ops/workspaces/t_f3cd625c/`
- Final position: `(350.5, 15, -629.5)` — y=15, ~50 blocks NW of base, in a 1×1 shaft
- Block reason: `Iteration budget exhausted (90/90)` at 2026-05-24 01:00

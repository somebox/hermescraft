---
name: minecraft-planning
description: "Plan and execute complex multi-step Minecraft projects — farms, infrastructure, builds, resource chains. Covers research, decomposition, plan persistence in memory, player confirmation, and recurring maintenance. Load when the task has 4+ steps, involves unfamiliar mechanics, or requires infrastructure."
triggers:
  - build a farm
  - complex build
  - infrastructure
  - multi-step
  - project plan
  - recurring maintenance
  - wheat farm
  - chicken farm
  - build plan
  - set up base
version: 1.0.0
---

# Minecraft — Planning complex tasks

Use this workflow for any task with 4+ steps, unfamiliar mechanics, or infrastructure that needs maintenance after construction.

## Phase 1: Research

Before building anything you haven't done before:
- **Load the relevant skill** — `skill_view("minecraft-survival")` (mechanics, recipes, farming, animals), `skill_view("minecraft-building")`, etc.
- **Web search** (if available) — look up the Minecraft wiki for specific mechanics, layouts, or recipes you're unsure about.
- **`mc help`** / **`mc commands`** — list available verbs and their signatures.
- **`mc recipes ITEM`** and **`mc craft_plan ITEM`** — check crafting dependencies.

Do not guess at mechanics. A 30-second lookup prevents 10 minutes of wrong work.

## Phase 2: Plan

Write a numbered plan to memory before starting. Include:
1. **Goal** — what you're building and why (e.g. "9x9 wheat farm for food supply")
2. **Materials list** — with quantities and `mc craft_plan` for anything non-obvious
3. **Tool prerequisites** — what tools you need (hoe, bucket, axe, pickaxe)
4. **Location** — where to build; use `mc mark` to save the site
5. **Build order** — numbered steps from site prep through completion
6. **Maintenance** — what needs periodic checking after it's done

### Surveys drive plan adaptation, not assumption

For any task that shapes terrain (level, fill, clear, road, large platform), do a **survey pass before locking the plan**. The relevant verbs emit a disposition map you can read:
- `mc level_ground X1 Z1 X2 Z2 target=Y` (no `execute=true`) — returns `data.dispositions = { level, cut, fill_shallow, fill_deep, no_floor, preserved, unknown }`, `data.dip_spans[]`, and `data.recommended_actions[]`. Read these BEFORE deciding execute is safe.
- If `summary.deck_required_n > 0` or `summary.reroute_required_n > 0`: the rectangle has gaps level execute can't honestly fill. Adapt the plan: split the rectangle, shift the corridor, or defer that section.
- If only `fill_shallow + cut + level` are present: execute is safe; proceed.

Don't issue an `execute=true` over deck/reroute spans hoping it'll work — the level primitive can only cap the surface, leaving a hollow shell. The survey output tells you when that would happen; respect it.

Example memory entry:
```
PLAN: wheat farm at mark:farm_site
Materials: stone_hoe(1), water_bucket(1), wheat_seeds(18+), oak_fence(24), oak_fence_gate(1), torches(4)
Steps: 1) clear 11x11 area 2) dig center for water 3) place water 4) till 9x9 farmland 5) plant seeds 6) fence perimeter 7) gate + torches 8) mark location
Status: step 0 — gathering materials
```

## Phase 3: Confirm

For builds that affect the shared base or take significant resources:
- `mc chat "I'm going to build a 9x9 wheat farm near base. Need hoe, seeds, water bucket, fencing. Sound good?"`
- Wait for player response before placing blocks.
- If the player suggests changes, update your plan in memory.

Skip confirmation for small tasks (crafting tools, gathering runs, combat prep).

## Phase 4: Execute

Work through your plan steps in order:
1. **Gather all materials first** — don't start placing blocks until you have what you need.
2. **Update memory** after each major milestone: change "step 0" to "step 3 — farmland tilled".
3. **Use `mc inventory`** between phases to verify you have what the next step needs.
4. **If interrupted** (combat, player request, death), your plan in memory lets you resume.
5. **Batch related actions** — place all fence segments, then all torches, etc.

If a step fails (missing materials, wrong location, can't place):
- Don't retry the same failing action 3 times.
- Re-check with `mc recipes`, `mc craft_plan`, or `mc nearby`.
- Update your plan if needed.

## Phase 5: Maintain

After completing infrastructure:
1. **Mark the location**: `mc mark wheat_farm "9x9 farm, planted [date]"`
2. **Save a maintenance note to memory**: "Periodically check wheat_farm: harvest mature wheat, replant, check fences."
3. **On future game loops**: when you read memory and see maintenance notes, visit and act on them between other tasks.

Maintenance is not automated — you check these notes when you have downtime between goals or gather trips.

## Project sizing guide

| Complexity | Examples | Planning needed |
|------------|----------|-----------------|
| Simple | craft a tool, gather 16 logs | No plan needed — just do it |
| Medium | build a fence pen, set up furnace area | Quick 3-step mental plan |
| Complex | wheat farm, cabin, animal breeding pen | Full plan in memory |
| Major | multi-room base, nether portal, redstone | Plan + player confirmation + milestones |

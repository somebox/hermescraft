---
name: minecraft-goals
description: Goal engine, task leases, checkpoints, and deliberation for HermesCraft mc bots
triggers:
  - mc goals
  - goal directed minecraft
  - minecraft checkpoint
  - task lease
  - mc observe
  - mc checkpoint
version: 1.0.0
---

# Minecraft — Goals, tasks, and deliberation

Use this skill when the agent runs with the **goal engine** enabled (`bot/lib/goals/engine.js` + HTTP/CLI on the bot server).

## Read the scoreboard

- `mc goals` — all goals with **urgency**, **gap**, **current** vs **target_min** / **target_ok**, and metric id.
- `mc goal_status ID` — one goal in detail.
- `mc goal_presets` / `mc goal_load NAME` — load packaged goal sets (e.g. `gatherer`).

**Picking work:** sort by urgency descending. Goals with `constraints.preempt_class: critical` (e.g. survive, threat) should win when their gap is large or alerts spike, even if another goal has high priority.

## Observe vs checkpoint

- `mc observe` — full merged snapshot: world summary, inventory, top goals, active task + lease, alerts.
- `mc checkpoint` — deliberation snapshot (aligned with `GET /checkpoint`); use when the runtime indicates a lease checkpoint or when pausing to re-plan.

Use **one** of these after any major state change (combat, crafting dump, long walk) before committing to the next multi-step task.

## Task leases

- Start attributed work: `mc task_start ACTION JSON`
  - Include `lease_seconds` and **`goal_id`** (or `parent_goal_id`; both are accepted) in the JSON so the task ties to a goal and expires for review.
- `mc task_status` — current task, progress, lease expiry, checkpoint state.
- `mc task_pause` / `mc task_resume` — interrupt without losing the record.

When **checkpoint is pending** (lease expired):

1. Run `mc checkpoint` or `mc observe`.
2. Re-score goals mentally: is the current task still the best marginal use of time?
3. `mc checkpoint_respond continue|switch|adjust` — continue if progress is good and urgency leaders unchanged; switch if another goal dominates; adjust if parameters (lease length, action) should change.

**Anti-thrash:** do not flip tasks every tick; require a clear urgency or safety reason to switch. Honor `min_run_s` / cooldown hints in goal constraints when present.

## Discovery and crafting

- `mc discover NEED` — ranked options for a need category before blind searching.
- `mc craft_plan ITEM [COUNT]` — dependency tree from **current** inventory; resolve missing leaves with gather tasks or storage.

## Logistics

- `mc logistics` — ties inventory (+ known chest snapshots from `list_container`) to goal-shaped deficits when the server computes them.

## Trip planning for gatherers

Use explicit gather trips instead of one-off actions.

1. Pick one top deficit from `mc goals`.
2. Define a trip target (for example: `logs +16`).
3. Find source candidates (`mc discover`, `mc nearby`, `mc find_blocks`) and choose closest viable.
4. Travel to source and gather in batches (`collect/bg_collect` with count >1).
5. Return to base/chest, deposit, and re-evaluate.

Guidelines:
- Do not stop after collecting a single block unless danger or hard blocker.
- Avoid thrashing between goals; complete a meaningful chunk of work per trip.
- Only follow players when explicitly coordinating or regrouping, not as default fallback.
- For wood: run `mc discover logs` (or `mc nearby`) to see which `*_log` types exist, then `mc collect spruce_log N` / `oak_log` / etc. — there is **no** `mc collect_wood` command.
- Apply a tool gate before trips:
  - wood/logs trip => **`mc inventory`**; equip any **`…_axe`** or **`mc unequip`** (bare hand). **Never** use a pickaxe or hold building blocks for chopping trees.
  - stone/mining trip => equip a **pickaxe**
  - if tool prep fails, run `mc craft_plan` for the tool, gather requirements, retry.

## Resource memory and communication

- Maintain useful marks for recurring places (`base`, farms, resource zones) with `mc mark`.
- Use `mc anchors` for a compact map refresh (marks + nearby chest/table/furnace) before starting a trip when context is fuzzy.
- If a resource source is far but productive, mark it and reuse it on future trips.
- If blocked twice on the same action (path, visibility, missing tool), send one short status line and one direct question to the player, then continue with the next best goal.

## Player-driven goal changes

When the player asks for more of something (e.g. “we need more iron”):

1. `mc goal_add` with JSON for a new goal, **or** `mc goal_set` on an existing goal’s `target_min` / `target_ok` / `priority`.
2. Re-run `mc goals` and proceed from the new scoreboard.

## Alerts

- `mc alerts` — typed feed (hostiles, sounds, etc.). Treat high-threat alerts as a signal to preempt gathering and address safety (eat, flee, fight) even before re-scoring.

## Web UI

If the operator uses the browser, the bot serves `GET /dashboard` (polls observe/history). CLI: `mc dashboard` prints the URL.

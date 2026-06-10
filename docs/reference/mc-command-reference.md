# MC command surface (canonical)

> **Transition (2026-06):** Strategic direction is **registry as sole contract** + **generated agent surface** — see [`../architecture/embodied-control.md`](../architecture/embodied-control.md) (§ Two layers, § Delivery order). **Shipped (2026-06-10):** registry `surface` tier (`core` / `extended` / `microscope`), tier-grouped [`mc-cheatsheet.md`](mc-cheatsheet.md), `mc commands --tier`. This file remains **hand-maintained intent, chains, and argument vocabulary** until `intent` metadata and generators subsume § A. **Syntax** always follows the generated cheatsheet.

Hand-maintained specification for agents and developers until registry-driven generation replaces § A below. The generated inventory lives in [`mc-cheatsheet.md`](mc-cheatsheet.md) (from `bot/cli/registry.mjs`).

See also [`bot/handler-contract-adr.md`](bot/handler-contract-adr.md) for return envelopes. Navigation DSL, breadcrumbs, and per-round brief: [`../specs/nav/route-precompute-context.md`](../specs/nav/route-precompute-context.md).

## A. Command taxonomy (by intent)

| Intent | Examples | Notes |
|--------|----------|--------|
| **perceive** | `status`, `observe`, `nearby`, `map`, `scene`, `discover`, `scout`, `inspect`, `standing`, `reachable`, `find`, `terrain_top`, `is_empty`, `is_filled`, `health`, `advise`, `inventory`, … | CLI category **`perceive`** (`mc commands --category perceive`). The verb **`mc observe`** is unchanged — orchestration snapshot; may include **`nav_brief`** when `HERMES_NAV_BRIEF=1`. Read-only or advisory; `status` is **self**; world vision uses `scene` / `nearby` / `map`. |
| **movement** | `move`, `goto`, `goto_near`, `follow`, `look`, `jump`, `stop`, `deathpoint`, `sail_to`, `retrace` | **`move`** is canonical: `@mark`, bare mark name, `:region:[/site]`, `--near N`, `--raw`, `--force`. `goto` / `goto_near` remain during migration. `retrace --trail` prefers nav breadcrumbs. Long water crossings use `sail_to`. |
| **world** | `dig`, `safe_dig`, `collect`, `dig_area`, `tunnel`, `stair_*`, `pillar_*`, `place`, `place_fill`, `wall`, `fence`, `path`, `level`, `level_ground`, `build_stairs`, `dig_pit`, `till`, `plant`, `harvest`, `bonemeal`, `fish`, `bucket_*`, `through`, `escape`, `set_home`, `respawn`, `edit_sign`, `farm_status`, `verify_plot`, boat verbs (`place_boat`, `board`, `sail`, `disembark`, …) | Placement/digging verbs use **`block`** in JSON bodies (see B) |
| **building** | `check`, `construct`, `repair`, `blueprint`, … | **`mc check`** — dry-run region policy for dig/place (no world edit); see [`../specs/world/designated-regions.md`](../specs/world/designated-regions.md). `construct` / `repair` are Phase 2c guided workflows. |
| **craft** | `craft`, `craft_plan`, `recipes`, `smelt`, `smelt_start`, `furnace_check`, `furnace_take` | Inventory/crafting verbs use **`item`** in JSON bodies |
| **combat** | `attack`, `fight`, `shoot`, `flee`, `mode`, `eat`, … | |
| **memory** | `mark`, `marks`, `go_mark`, `go_site`, `remind`, `regions`, `region_create`, `region_update_intent`, `region_remove`, `regions_reload`, `regions_terrain`, `site_add`, `site_remove` | Designated **regions** — see [`../specs/world/designated-regions.md`](../specs/world/designated-regions.md); `mc goto :id:/site` routes to `go_site`; preview policy with **`mc check dig`** / **`mc check place`** |
| **task** | `bg_goto`, `bg_collect`, `task_start`, `task_pause`, `task_resume`, `task_context`, `checkpoint_respond`, `complete_command`, `acknowledge_command`, `cancel_command`, … | Async task verbs |
| **goals** | `goals`, `goal_add`, `goal_set`, `goal_remove`, `goal_status`, `goal_presets`, `goal_load` | Per-bot goal engine (distinct from base supply YAML) |
| **social** | `chat`, `team_chat`, `whisper`, … | |
| **platform** | `dashboard`, `batch`, `connect`, `commands`, `help` | Meta / fleet wiring |

## B. Argument schemas

Only shapes **observed in production callers** today. Handlers may accept **`block`** and **`item`** interchangeably where noted (domain-driven canonical docs, not a hard rejection).

### Point3

Coordinates of one block cell.

```json
{ "x": 10, "y": 64, "z": -3 }
```

All keys required; must be finite numbers. Parse failures → `INVALID_ARGS` at the normalizer layer.

### Box6

Axis-aligned box for region verbs (`dig_area`, `place_fill`, `scout`, …).

```json
{ "x1": 0, "y1": 60, "z1": 0, "x2": 10, "y2": 70, "z2": 10 }
```

### BoxXZ

Horizontal footprint (optional `y` / depth keys on some excavation verbs).

**Building style:** `{ "x1", "z1", "x2", "z2", "y"? }`

**Excavation `dig_pit` style:** `{ "x", "z", "w", "l", "y"?, "d"? }`

### GatePassage

Door/gate explicit pass: `{ "gx", "gy", "gz", "dx"?, "dy"?, "dz"? }` (see `mc through`, `mc move --door`).

### BlockRef / ItemRef

| Domain | Canonical key in docs | Accepted keys in handlers |
|--------|----------------------|---------------------------|
| Placement, digging, farming blocks | **`block`** | `block`, `item`, `name` (where implemented) |
| Craft, inventory, chests | **`item`** | `item`, `name` |
| `mc find` | **`resource`** | `resource`, … |
| `mc is_filled` | **`material`** | `material`, … |

### ItemStack

`{ "item"|"block": "<minecraft_name>", "count": <int> }` — `count` defaults to 1 where omitted.

### MarkRef

`{ "name": "<mark_id>" }`

## C. Return envelope

Every handler returns:

- **Success:** `{ "ok": true, "data"?: {}, "result"?: string, … }`
- **Failure:** `{ "ok": false, "error": { "code", "message", "retry_safe", "observed_state"?, "next_action_hint"? } }`

**Two-layer errors (argument normalization):**

1. **`INVALID_ARGS`** — shape/parse only (missing coord, NaN, wrong type) from `_args` helpers.
2. **Semantic codes** — `INVALID_COORD`, `UNKNOWN_BLOCK`, `NO_BOAT`, `BOAT_REQUIRED`, … unchanged at handler validation after args parse.

Always prefer the **`next_action_hint`** string when present; it is authoritative for the next `mc` command.

## D. Command-chain playbooks

### Water / ferry (canonical)

```
mc bg_goto|move|goto …  →  BOAT_REQUIRED  →  mc sail_to X Y Z
```

- **Do not** manually chain `place_boat` → `board` → `sail` → `disembark` as a first move.
- **`mc sail_to`** is resumable: call again with the same target after knock-off, interrupt, or partial progress.
- Low-level boat verbs are **recovery hatches** (or internal to `sail_to` via `_from_sail_to`); direct agent calls to `place_boat` / `board` / `sail` / `disembark` without going through `sail_to` may receive a deprecation refusal pointing at `mc sail_to`.

Runtime: BFS route in `bot/lib/runtime/water-route.js`; dense boat path in `bot/lib/runtime/boat-path.js`.

### Farming loop

`till` → `plant` → `bonemeal` → `harvest` → replant

### Furnace loop

`smelt_start` → `furnace_check` → `furnace_take`

### Stuck / submerged

`standing` / `escape` → `move` or `move … --near 2` → `inspect`  
After submerge during ferry: `escape` then **`mc sail_to`** again from dry land.

### Mark / region navigation (canonical)

```
mc move @chest_food
mc move base_anchor          # bare mark name
mc move :base1:/tower
mc move 100 64 -200 --near 2
mc move 100 64 -200 --raw    # raw pathfinder (legacy: mc goto …)
```

Legacy verbs `go_mark`, `go_site`, `goto_near` remain; prefer `move` forms for new prompts and skills. Fleet flag **`HERMES_MOVE_RESOLVE=1`** routes `go_mark` / `go_site` through the same stack as `move`.

### Route brief (observe)

When **`HERMES_NAV_BRIEF=1`**, `mc observe` returns **`nav_brief`** / **`nav_brief_text`**: precomputed movement lines for this standing cell. Pick a line; do not re-derive paths from `scene`/`map` unless the brief is stale or missing (`nav_brief_status`). Shadow mode: `HERMES_NAV_BRIEF=shadow` (log only).

## E. Refusal code → next command (selected)

_Snapshot as of 2026-05-29 — hand-maintained from `next_action_hint` in handlers; not auto-synced._

| Code / situation | Typical next step |
|------------------|-------------------|
| `BOAT_REQUIRED` (move/goto/bg_goto) | **`mc sail_to X Y Z`** (target coords from your goal) |
| `NO_BOAT` (sail_to) | `mc craft oak_boat` (5 planks) |
| `NO_NAVIGABLE_ROUTE` + `POND_DISCONNECTED` | `mc bg_goto <coast>` then **`mc sail_to`** again |
| `NO_NAVIGABLE_ROUTE` + shallow / no route | Walk to deeper water or `mc bg_goto` land approach |
| `SAIL_TO_RETRY_LOOP` | Follow hint: `mc bg_goto` to suggested shore/water, or `mc advise` |
| `WALK_TO_ENTRY_DROPPED_IN_WATER` | `mc escape`, then **`mc sail_to`** |
| Phase `MOUNT_FAILED` / `SAIL_FAILED` with re-plan hint | **`mc sail_to`** same target (resumable) |
| Direct `mc place_boat` / `board` / `sail` / `disembark` (agent) | **`mc sail_to X Y Z`** (deprecation refusal) |
| `NAV_BLOCKED` (move) | Use `observed_state.nearby_doors` or `mc dig` / `mc tunnel` |
| `BOT_ON_PILLAR` | `mc pillar_down` before navigating |

Regenerate this table after handler changes: grep `next_action_hint` under `bot/lib/actions/`.

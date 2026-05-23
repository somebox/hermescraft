# MC command surface (canonical)

Hand-maintained specification for agents and developers. The generated inventory lives in [`mc-cheatsheet.md`](mc-cheatsheet.md) (from `bot/cli/registry.mjs`). When they disagree on **syntax**, trust the registry; when they disagree on **intent, chains, or argument vocabulary**, trust this document.

See also [`design/action-contract.md`](design/action-contract.md) for return envelopes.

## A. Command taxonomy (by intent)

| Intent | Examples | Notes |
|--------|----------|--------|
| **observe** | `status`, `observe`, `nearby`, `map`, `scene`, `discover`, `scout`, `inspect`, `standing`, `reachable`, `find`, `terrain_top`, `is_empty`, `is_filled` | Read-only or advisory |
| **movement** | `move`, `goto`, `goto_near`, `follow`, `look`, `jump`, `stop`, `through`, `escape`, `sail_to` | `move` scans doors; long water crossings use `sail_to` |
| **world** | `dig`, `safe_dig`, `collect`, `dig_area`, `tunnel`, `stair_*`, `pillar_*`, `place`, `place_fill`, `wall`, `fence`, `path`, `level`, `build_stairs`, `dig_pit`, `till`, `plant`, `harvest`, `bonemeal`, `fish`, `bucket_*`, low-level boat verbs | Placement/digging verbs use **`block`** in JSON bodies (see B) |
| **craft** | `craft`, `craft_plan`, `recipes`, `smelt`, `smelt_start`, `furnace_check`, `furnace_take` | Inventory/crafting verbs use **`item`** in JSON bodies |
| **combat** | `attack`, `fight`, `shoot`, `flee`, `mode`, `eat`, … | |
| **memory** | `mark`, `marks`, `go_mark`, `remind`, `set_home`, `deathpoint` | |
| **task** | `bg_goto`, `complete_command`, … | Async task verbs |
| **social** | `chat`, `team_chat`, `whisper`, … | |
| **platform** | `health`, `dashboard`, `advise`, `goals` | Meta / fleet |

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

`standing` / `escape` → `move` or `goto_near` → `inspect`  
After submerge during ferry: `escape` then **`mc sail_to`** again from dry land.

## E. Refusal code → next command (selected)

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

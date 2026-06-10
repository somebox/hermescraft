# Handler response contracts

Section 8 of the Phase 2 architecture. The required response shape for every `mc <verb>` action handler. Heavily referenced (P9 in docs/reference/engineering-patterns.md cites this).

Strategic context: consistent envelopes let agents and scripts compose **output → input** without prose parsing — [`../architecture/embodied-control.md`](../architecture/embodied-control.md).

## 8. Primitive action reliability contract

This is the **gate**: no L1+ test can pass until the action it depends on meets this contract. Sprint 1 fixes them.

### Required response shape (all `mc <verb>` actions)

```yaml
{
  "ok": <bool>,
  "command": "<verb>",
  "data": { <action-specific structured fields> },
  "error": {                            # only when ok=false
    "code": "<UPPERCASE_ENUM>",
    "message": "<human readable>",
    "observed_state": { ... },
    "next_action_hint": "<what to try>",
    "retry_safe": <bool>
  }
}
```

### Per-primitive contracts (L0–L4 hot path)

#### `mc dig X Y Z`
- `ok=true` only if a block was actually broken at the target coord
- **Does NOT auto-pickup**: the dropped item entity stays at the target coord. Tests or sequences that need the item in inventory must follow up with `mc pickup` (or `mc collect` which dig+pickups). Verified in L3.1 fixture: `mc dig 1 65 0` returned ok=true with the dirt block removed but inventory unchanged.
- `ok=false` for these cases, with `error.code` in:
  - `NO_BLOCK_AT_COORD` — target is air/cave_air; `observed_state.block_at_target == "air"`
  - `OUT_OF_RANGE` — distance > 4.5 and pathfind unsuccessful
  - `TOOL_INADEQUATE` — guardSlowDigEstimate fired; `next_action_hint` names the right tool
  - `PROTECTED_BLOCK` — building protection (crafting_table, chest, etc.)
  - `INTERRUPTED` — task cancelled or bot died mid-dig
- `data` includes: `{ block_name, dropped_items: [{name, count, position}], position_after }`

#### `mc collect <name> <count>`
- **Phase 1 bug to fix**: `ok=true` with `mined_count == 0` is forbidden by this contract
- `ok=true` only if `mined_count > 0`
- `ok=false` cases:
  - `NO_VISIBLE_BLOCKS` — no blocks of `name` found within fair-play range
  - `ALL_PATHFIND_FAILED` — found candidates but couldn't reach any
  - `ALL_DIG_FAILED` — found and reached but every dig errored (timeout, tool, interrupt)
  - `MIXED_PARTIAL` — collected `mined_count > 0` but `< count` AND every remaining attempt failed; this is `ok=true` with a `partial_failure` flag, not `ok=false`
- `data` includes: `{ mined_count, requested_count, started_inventory, ended_inventory, dropped_items_collected }`

#### `mc place <block> X Y Z`
- `ok=true` only if block is now at target coord
- `ok=false` cases:
  - `NO_SOLID_NEIGHBOR` — all 6 face neighbors are air/liquid; `observed_state.neighbors` enumerates them
  - `TARGET_OCCUPIED` — block already at coord; `observed_state.existing_block`
  - `INVENTORY_MISSING` — block not in inventory
  - `OUT_OF_RANGE` — distance > 4.5 and pathfind unsuccessful
- `data` includes: `{ placed_block, face_used, position_after }`

#### `mc craft <item> [count]`
- `ok=true` only if `crafted_count >= 1`
- `ok=false` cases:
  - `NO_RECIPE` — recipesAll returned empty
  - `MISSING_INGREDIENTS` — `error.observed_state.missing` lists shortfall
  - `TABLE_REQUIRED` — recipe needs crafting_table; `next_action_hint` includes nearest table mark/coord if known
  - `TABLE_OUT_OF_RANGE` — table is just outside 4-block search; `observed_state.nearest_table` includes its coords
- `data` includes: `{ crafted_count, recipe_used, ingredients_consumed }`

#### `mc chest @mark` (or `X Y Z`)
- `ok=true` only if a chest container is at the location and was successfully opened
- `ok=false` cases:
  - `NO_CONTAINER` — block at target is not a chest/barrel/shulker; `observed_state.block_at_target`
  - `NO_MARK` — `@mark` doesn't exist in marks file
  - `OUT_OF_RANGE` — distance > 4.5 and pathfind unsuccessful
- `data` includes: `{ container_kind, slots: [...], item_counts: {item_name: count, ...} }` for read; deposit/withdraw return `{ inventory_delta: {...}, container_inventory_after: {...} }`

### Sprint 1 must ship these contracts

The bot HTTP server's response shape changes are non-breaking (additive fields, ok=false where it was ok=true with empty data). Fixing each primitive lives in `bot/lib/actions/*` per the explore-agent's file:line refs.


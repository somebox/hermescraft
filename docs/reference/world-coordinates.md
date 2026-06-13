# Coordinates convention — `block_y` and `surface_y`

> Status: convention adopted 2026-05-27; migration complete 2026-06-13 (clear_strip and deck were the last holdouts). Every Y-taking primitive accepts `y` or `surface_y` and returns both fields. Older callers can keep passing `y` — only the return shapes still vary by primitive (see the outputs table).

Every Y coordinate in the bot's universe is one of two things. Naming them once and using the names everywhere removes the off-by-one ambiguity that has shown up repeatedly in live-fleet runs (`docs/planning/session-devlog.md:250`, `:318`, `docs/archive/experiments/1.4-kanban-minecraft.md:95`).

## The two terms

**`block_y`** — the Y coordinate of a solid block. The block occupies the cube from `block_y` to `block_y + 1`. When you `mc dig X Y Z`, the `Y` you pass is a `block_y`.

**`surface_y`** — the Y where the bot's feet stand when standing on top of a block at `block_y`. Always:

```
surface_y = block_y + 1
```

When you ask "where is the ground I walk on?" the answer is a `surface_y`. When `mc terrain_top X Z` returns the topmost solid block, its Y is a `block_y`; the bot's feet would land at `surface_y = block_y + 1`.

That's it. No third concept, no eye-Y, no air-Y. Bot eye height (`pos.y + 1.62 ≈ pos.y + 1.38` after camera offset) is an internal mineflayer detail, not part of the convention.

## Rules every primitive follows

### Input

Handlers that take a Y parameter accept either `y` (= `block_y`, legacy) or `surface_y` (new). When both are passed, `surface_y` wins. When only `y` is passed, it means `block_y`.

```
mc level x1 z1 x2 z2 y=64           # fill blocks at block_y=64, walk surface ends up at 65
mc level x1 z1 x2 z2 surface_y=65   # same operation, surface-perspective
mc level x1 z1 x2 z2 y=64 surface_y=65   # explicit; surface_y wins → block_y=64
```

### Output

Any primitive whose `data` contains a Y returns BOTH `block_y` and `surface_y` together, plus `block_name` when the block at `block_y` is known:

```json
{
  "ok": true,
  "data": {
    "block_y": 64,
    "surface_y": 65,
    "block_name": "grass_block"
  }
}
```

For multi-point returns (bounds, paths, plans), each Y-bearing object gets both fields:

```json
{
  "bounds": {
    "x1": ..., "z1": ...,
    "block_y": 64, "surface_y": 65,
    ...
  }
}
```

### Documentation

Each primitive's CLI help text and JSDoc names which fields it reads/writes. Help text uses the canonical names:

```
mc level X1 Z1 X2 Z2 (y=BLOCK_Y | surface_y=SURFACE_Y) [block=NAME] [up=N]
  After execution the topmost solid block in each column is at block_y;
  bots stand on top at surface_y (= block_y + 1).
```

## Per-primitive Y semantics

The table below names every primitive that reads or writes a Y and lists what it returns after the phase C refactor. Until the refactor lands, primitives marked `(pending)` still use their legacy fields — verify against current code.

### Inputs

| Primitive | Y inputs | Semantic |
|---|---|---|
| `mc level` | `y` or `surface_y` | target Y for fill block (block_y) |
| `mc level_ground` | `target` or `surface_y` | explicit target Y; auto-median if absent |
| `mc dig_pit` | `top_y` or `surface_y` | pit surface Y (block_y) |
| `mc path` | `y` or `surface_y` | path tiles' Y (block_y) |
| `mc build_stairs` | `y` or `surface_y` | starting Y (block_y) |
| `mc fill` | `y1, y2` or `surface_y1, surface_y2` | inclusive Y range (block_y) |
| `mc wall` | `y1, y2` or `surface_y1, surface_y2` | wall Y range (block_y) |
| `mc fence` | `y` or `surface_y` | fence Y (block_y) |
| `mc dig_area` | `y1, y2` or `surface_y1, surface_y2` | inclusive Y range (block_y) |
| `mc tunnel` | `y` or `surface_y` | feet-level Y for the tunnel (surface_y is more natural here — bot walks through it) |
| `mc clear_strip` | `y` or `surface_y` | road-bed block (block_y); cleared volume is the feet+head cells above it |
| `mc deck` | `y` or `surface_y` | deck-layer block (block_y); bots walk on top at block_y + 1 |
| `mc goto`, `mc goto_near`, `mc bg_goto`, `mc sail`, `mc sail_to`, `mc lure`, `mc set_home` | `y` or `surface_y` (goto/goto_near only) | destination/foot block Y to stand on (= block_y of floor below feet) |
| `mc reachable` | `y` or `surface_y` | tested cell Y (block_y) |
| `mc dig`, `mc place`, `mc interact`, `mc bucket_fill`, `mc bucket_empty`, `mc till`, `mc till_area`, `mc plant`, `mc bonemeal`, `mc harvest`, `mc place_torch`, `mc place_named_sign`, `mc place_boat`, `mc is_empty`, `mc is_filled`, `mc chest`, `mc deposit`, `mc withdraw`, `mc furnace_check`, `mc furnace_take`, `mc waypoint` | `y` | block Y of the specific block being operated on (no surface_y dialect — the cell is the target, not a stand-on surface) |
| `mc terrain_top`, `mc nearby`, `mc scout` | (none — surveys) | — |
| `mc stair_down`, `mc stair_up`, `mc pillar_step`, `mc pillar_down` | (none — uses current bot position) | — |

### Outputs

| Primitive | Y-bearing fields in `data` | Notes |
|---|---|---|
| `mc terrain_top` | `block_y`, `surface_y`, `block_name` | `feetYHint` kept as back-compat alias until next release |
| `mc reachable` | `target.block_y`, `target.surface_y`, `best_stand.block_y`, `best_stand.surface_y` | |
| `mc goto`, `mc goto_near` | `end_position.block_y`, `end_position.surface_y` | already returns `end_position` post 2026-05-27 |
| `mc level`, `mc level_ground` | `bounds.block_y`, `bounds.surface_y`, `target_y` (= block_y for back-compat) | per-column entries get `top_block_y`, `top_surface_y` |
| `mc dig_pit` | `floor_block_y`, `floor_surface_y`, `bounds.{block_y1,...}` | |
| `mc fill`, `mc wall`, `mc fence` | `bounds.{block_y1, surface_y1, block_y2, surface_y2}` | |
| `mc dig_area`, `mc tunnel`, `mc stair_*`, `mc pillar_*` | `start.{block_y, surface_y}`, `end.{block_y, surface_y}` | position objects also include `block_y` / `surface_y` |
| `mc dig`, `mc place` | `position.{block_y, surface_y}` | |
| `mc clear_strip`, `mc deck` | `block_y`, `surface_y`, `bounds` | canonical bed/deck pair |

## Why two fields, not one (with one canonical perspective)

It would be tempting to pick one perspective (say, always `surface_y`) and force all callers to translate. We don't, for two reasons:

1. **Mineflayer is `block_y`-native.** Internally every block lookup uses `block_y`. Forcing all CLI calls to `surface_y` means an internal `-1` on every input — a constant friction.
2. **Different agent questions want different answers.** "Where do I stand?" wants `surface_y`. "Which block do I dig?" wants `block_y`. Returning both lets the agent copy-paste the right one for the next call without arithmetic.

The cost of two fields is one extra Number per Y-bearing object in the return — negligible. The benefit is zero off-by-one ambiguity.

## Migration notes

- New code: always use `block_y` / `surface_y` in returns; accept both names in inputs.
- Old fields (`y`, `topY`, `feetYHint`) stay readable for one release as back-compat; new readers prefer the canonical names.
- Tests: round-trip property — for every primitive that takes Y input and returns a Y in its `data`, `parseYInput(returnedData) === parseYInput(originalInput)`.
- Helper module: `bot/lib/runtime/coordinates.js` exports `surfaceFromBlock`, `blockFromSurface`, `withYBoth`, `parseYInput`. Primitives import these; nobody recomputes `+1` / `-1` inline.

## Examples — full request/response

A worker asks "what's the surface I'd walk on at (365, -592)?":

```
mc terrain_top 365 -592
→ { ok: true, data: { block_y: 64, surface_y: 65, block_name: "grass_block" } }
```

A worker fills holes in a cleanup tile so bots walk at Y=65:

```
mc level 360 -590 363 -587 surface_y=65 block=cobblestone execute=true
→ { ok: true, data: {
    bounds: { x1: 360, z1: -590, x2: 363, z2: -587, block_y: 64, surface_y: 65 },
    placed: 8, dug: 2, ...
  } }
```

A worker just walked somewhere; they want to know where they are:

```
mc goto_near 386 65 -601 1
→ { ok: true, data: {
    end_position: { x: 386.5, block_y: 64, surface_y: 65, z: -600.7 },
    ...
  } }
```

In every case the answer is unambiguous in both perspectives, and the agent picks the field that matches its next question.

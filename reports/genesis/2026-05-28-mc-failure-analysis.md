# `mc <verb> <material>` failure analysis — corrected finding

**Date:** 2026-05-28
**Question asked:** "find the most common mc commands that fail due to incorrect materials recognized by the agent"
**Tool:** `scripts/analyze-mc-failures.py` (re-runnable; reads `/tmp/hermescraft/cognition/*.jsonl`)
**Sample:** 3,438 `mc <verb> <material>` invocations across flint + mason + steward over ~6 hours, 4 genesis runs.

## Headline

**Material-name recognition is NOT the dominant failure mode.** Of 1,519 failures observed, only **7 (0.5%)** are name-recognition errors (`unknown_item` / `no such block`). Agents pick correct Minecraft names — `oak_log`, `cobblestone`, `iron_ore`, `stone_pickaxe` — at very high reliability.

The 44% failure rate of `mc <verb> <material>` calls is dominated by **spatial / geometric / state errors that share a `mc place cobblestone` signature regardless of whether `cobblestone` is the right name**.

## Real failure categories

```
 838  other            (mostly mc CLI usage errors + discovery-loop misuse)
 185  pathfind_failed
 134  already_block    (target cell already has X)
 131  view_blocked     (line-of-sight obstruction)
  64  no_solid_neighbor
  44  refusing_to_dig  (no tool equipped)
  30  nav_blocked
  27  region_protected (placing inside :base: protect)
  24  server_rejected  (race / timing)
  14  prev_move_failed (state guard)
  11  invalid_arg
   9  entity_in_way
   7  unknown_name     ← only 0.5% are actual name confusion
```

## Specific patterns worth addressing

### 1. `mc collect <X>` requires a visible target (NO_VISIBLE_BLOCKS pattern)

Example:
> `mc collect iron_ore` → "Can't see any iron_ore right now. Turn, move, or use mc scene/mc look before collecting."

**Fix shape:** worker SOUL doctrine — before any `mc collect`, run `mc scene` or `mc nearby` to confirm the target is visible. If `mc scene` shows it's nearby but not visible (behind a wall, around a corner), `mc move` first.

### 2. `mc place <X>` inside `:base:` region rejected (REGION_PROTECTED)

Example:
> `mc place furnace` (7/8 fail) → "Cannot place furnace — inside region :base: (protect)"

**Fix shape:** card body or worker SOUL — for furnace / persistent installations, `mc go_site :base:` to verify proximity, then place on the perimeter / outside the protected region.

### 3. `mc withdraw <X>` requires coords or mark (MISSING_COORDS)

Example:
> `mc withdraw iron_ingot 3` → "Need x,y,z or mark/at/at_mark. Usage: mc deposit/withdraw/chest ITEM COUNT X Y Z (or pass mark=NAME)."

**Fix shape:** SOUL — when teaching `mc withdraw`, always reference a chest mark explicitly: `mc withdraw iron_ingot 3 mark=chest_misc`. Agents drop the coord argument and trigger the MISSING_COORDS error.

### 4. `mc collect <X>` count-max-64 CLI usage error

Example:
> `mc collect sand` (8/10 fail) and `mc collect stone_slab` (5/5 fail) → "ERROR (cli): collect:count:max:64\n  Usage: mc collect BLOCK [COUNT]"

This is a CLI parser failure — either the agent passed a count >64 or the verb has an undocumented count-clamp. **Worth a [BUG] investigation** — the error wording suggests the CLI is rejecting valid call shapes, not the materials.

### 5. Placement geometry — the #1 spatial issue

For `mc place cobblestone` (167 calls, 70% fail), the top error categories:
- "No solid neighbor for cobblestone at X" — placing into air without an adjacent solid
- "Cannot place at X — view blocked" — line-of-sight obstruction
- "Cannot place at X: block is already cobblestone" — agent's plan thinks the cell is empty but it isn't

**Fix shape:** the placement loop in `mc place` could fail with a smarter hint that the agent can act on (e.g., "your previous mc place at X is the block now occupying X+1 — adjust your tile order"). Or worker SOUL doctrine: read `mc scene` between every 4-5 placements to refresh the target-cell state, not blindly march through a pre-computed list.

## What this means for prompt/SOUL work

- **Material naming guidance in SOULs is not load-bearing.** Don't spend prompt budget on "use `oak_log` not `wood`, use `cobblestone` not `stone`" — agents already do this.
- **Spatial-awareness doctrine IS load-bearing.** The current SOULs say "use `mc scene` before collecting" but don't enforce it; 87% of `mc collect iron_ore` calls fail with NO_VISIBLE_BLOCKS. Either the rule isn't sticking or the cost of a pre-flight `mc scene` is being treated as optional.
- **The `mc <verb>` CLI's error messages are good** (specific, actionable, "Hint: try X"). Workers don't reliably ACT on the hint — that's a different doctrine gap than naming.
- **One real CLI bug surfaced** — the `collect:count:max:64` error on `sand` and `stone_slab` is suspicious and worth a separate dig.

## Reproduction

```bash
scripts/analyze-mc-failures.py                  # default top 20, samples 2
scripts/analyze-mc-failures.py --top 5 --samples 0   # tightest summary
scripts/analyze-mc-failures.py --min-calls 20 --min-fail-ratio 0.5
```

Script is read-only against `/tmp/hermescraft/cognition/*.jsonl`. Safe to run anytime. Re-aggregates from scratch on every invocation.

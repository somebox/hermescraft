# Pilot — single resource-intent mine (`mine_dirt_hilltop_pilot`)

## Why this pilot exists

The coordinates+materials plan (`/Users/foz/.claude/plans/lets-now-make-a-witty-fern.md`) phases D1+D2 shipped the resource-intent region path in `bot/lib/runtime/regions/resolver.js` (commit `fe64913`). Phases D3+D5 shipped the Steward `[SITE]` card pattern and `designated_site` schema. None of that is validated end-to-end in production yet — the devlog validation flagged that marks-as-coordination is an unproven channel. This pilot runs the smallest possible end-to-end loop to find out whether workers actually consult `designated_site` when they hit a low-stock hint.

**Validation gate**: if workers ignore the mark and still mine wherever convenient, the fix is upstream of D3 (`mc collect` itself needs region-awareness — a Phase F). Don't roll out autonomous `[SITE]` designation in Steward until this pilot passes.

## Pre-flight

Before starting, confirm the code path is live:

```bash
scripts/landfolk version
```

The spawn commit must be ≥ `fe64913` for resource-intent regions, and ≥ `7682d03` for low-stock hints. If bots are drifted, restart first: `scripts/landfolk restart players`.

You also need a flat hilltop or dirt patch within ~100 blocks of base. Use `mc map 32` from Steward's position (or visually via the FPV viewer at `:4005`) to spot a candidate.

## Step 1 — operator creates the region (no Steward involvement)

Skip the [SITE] card pattern for the pilot. Edit `data/regions-world.json` directly and add:

```json
{
  "id": "mine_dirt_hilltop_pilot",
  "intent": "resource",
  "profile": "mine",
  "status": "active",
  "anchor": { "x": <scouted_x>, "y": <scouted_y>, "z": <scouted_z> },
  "shape": { "kind": "column", "radius": 8 },
  "resource": { "tier": 1, "blocks": ["dirt", "grass_block"] }
}
```

Replace `<scouted_x>`, `<scouted_y>`, `<scouted_z>` with the actual hilltop coord. Pick a spot that has obvious dirt/grass coverage and is well away from any base/hut1 region anchor (≥24 blocks).

Then reload the region store on each bot:

```bash
for port in 3002 3003 3005; do
  curl -s -X POST http://localhost:$port/regions/reload
done
```

Verify the region is loaded:

```bash
curl -s http://localhost:3005/regions | jq '.data.regions[] | select(.id == "mine_dirt_hilltop_pilot")'
```

Expected: a region row with `intent: "resource"` and the `resource: { tier: 1, blocks: [...] }` field.

## Step 2 — also set the designated_site

In `data/base-goals.yaml`, add the field to `stone` or create a new `dirt` resource pointing at the pilot mine. Simplest: add a `dirt` resource so the link is unambiguous:

```yaml
dirt:
  items: [dirt, grass_block, coarse_dirt]
  target_min: 32
  target_ok: 128
  assignee: flint
  designated_site: mine_dirt_hilltop_pilot
```

(No bot restart needed for `base-goals.yaml` edits — `base-goals.js` loads at module init, but each new worker spawn re-loads.)

## Step 3 — trigger the low-stock hint

Make sure the base `chest_dirt` (or whichever chest holds dirt) is at or below 32. If it isn't, drain it via test: pick a worker, run `mc go_mark chest_dirt && mc withdraw dirt 64`. The withdraw response should include something like:

```
⚠ dirt stock low: dirt at 12/32 (target_ok 128). Consider [SUPPLY] from mine_dirt_hilltop_pilot.
```

**This is the first validation point.** Confirm the hint text actually names `mine_dirt_hilltop_pilot`. If it doesn't, the path between `base-goals.yaml.designated_site` and the response hint is broken — investigate `bot/lib/runtime/base-goals.js` → `bot/lib/actions/containers.js`.

## Step 4 — observe whether the worker uses the hint

This is the unproven-channel test. After the worker reads the hint, do they:

- **Option A (success)**: `mc go_mark mine_dirt_hilltop_pilot` then `mc collect dirt 32`, and the dig happens inside the marked region's radius.
- **Option B (failure)**: `mc collect dirt 64` from current position, ambient pathfinding to wherever there's dirt — ignoring the mark entirely.

You don't have to script this — just watch the chat + logs. The worker is reading the hint in their primitive response; their next action is the answer to the test.

## Step 5 — verify region enforcement

Independent of worker behavior, prove the resource intent enforces correctly. Pick a coordinate inside the region (say, the anchor) and a coordinate just outside the radius. From any active bot's port:

```bash
# Inside — dig allowed (block in resource.blocks list)
curl -s "http://localhost:3005/regions/check?verb=dig&x=<anchor_x>&y=<anchor_y>&z=<anchor_z>&block=dirt" | jq '.data.region_decision.reason'
# Expected: "REGION_OVERRIDE"

# Inside — dig denied (block NOT in resource.blocks list)
curl -s "http://localhost:3005/regions/check?verb=dig&x=<anchor_x>&y=<anchor_y>&z=<anchor_z>&block=cobblestone" | jq '.data.region_decision.reason'
# Expected: "REGION_RESOURCE_RESTRICTED"

# Outside (e.g. anchor_x + 20) — standard protect/wild rules apply, not the resource filter
curl -s "http://localhost:3005/regions/check?verb=dig&x=<anchor_x+20>&y=<anchor_y>&z=<anchor_z>&block=dirt" | jq
```

## Verdict

- **Pass**: low-stock hint named the pilot mine, AND worker followed the mark, AND region enforcement matched expectations. → Proceed to D3 rollout (Steward emits `[SITE]` cards autonomously when a resource has no `designated_site`).
- **Hint missing**: fix the `base-goals.yaml` → `evaluateStock` → response wiring before doing anything else.
- **Region wrong**: fix `bot/lib/runtime/regions/resolver.js` resource branch; revisit D1 tests.
- **Worker ignored the mark**: do NOT proceed to autonomous Steward designation. Open a Phase F card: `mc collect` needs region-awareness (consult `paletteForRegion` / `designated_site` rather than its global block-search).

## Tear-down

After the pilot:

- Remove the `mine_dirt_hilltop_pilot` region from `data/regions-world.json` (or leave it as a real mine).
- Remove the `designated_site` line from `base-goals.yaml.dirt` if you don't want Steward eventually pointing future workers there.
- `POST /regions/reload` on each bot to pick up the deletion.

If the pilot passed, you may also want to leave the region in place and run a second [SUPPLY] card to confirm the steady-state behavior holds.

## Notes

- The pilot uses `dirt` as the resource because it's tier_1, freely diggable bare-handed, and the demand is high (cleanup cards consume a lot). Cobblestone is a fine second pilot if dirt passes.
- The pilot region has radius 8 → 256 cells of dig surface, enough for 4 fill cards before re-population is needed (natural regen via grass spread).
- If the hilltop has more than dirt/grass on top (e.g. trees, flowers), those will be untouched by the resource filter — only the listed `resource.blocks` are diggable inside the region.

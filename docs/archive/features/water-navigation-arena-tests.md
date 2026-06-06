# Water-navigation arena tests

Status: planning. No fixtures written yet.

## Problem

Every bug we've shipped in the v25→v36 fix-pass (cave-pool
suggestions, pathfinder-into-water, MOUNT_FAILED in deep water,
nearest_water_candidate returning underwater coords) is the kind of
thing that **only manifests against the real mineflayer + Paper +
pathfinder stack**. The mocked integration tests in
`bot/test/integration/boat-workflow.test.js` lock in the code logic
but cannot exercise the actual world physics, chunk loading, or
pathfinder edge cases. We've been catching these regressions
expensively — by burning a circuit-v* run, reading logs, then
patching.

A small library of live water-navigation fixtures would have caught
every one of the F9 / F10 / F12 bugs before they shipped.

## Concept

Reuse the existing fixture infrastructure
(`scripts/run-fixture.sh` + `data/test-fixtures/L*/`) — DO NOT
scaffold new test runners. Add a new fixture category for water
navigation (W0 — boat scenarios) under `data/test-fixtures/W0/`.

Each fixture is a self-contained YAML with `world: landfolk-test`,
`prep:` (RCON commands to build the scenario), and `cleanup:`. The
assertion portion (calling `mc sail_to` and checking the envelope)
is the new bit — fixtures today are world-state setup only, with
external runners calling `/health`, `/scene`, etc. and asserting via
existing test harnesses.

## What needs building

### 1. Water-test fixture category — `data/test-fixtures/W0/`

YAMLs in the existing fixture shape, with `prep:` blocks that
build small water scenarios in `landfolk-test` (away from other
test regions). One per scenario.

### 2. Tiny runner: `scripts/run-water-fixture.sh` (new)

A thin wrapper around `run-fixture.sh prep`, then `mc` CLI calls,
then assertions on the JSON envelopes, then `run-fixture.sh
cleanup`. Output: pass/fail per scenario. Doesn't need to be a
full test framework — bash + `jq` + `bin/mc` should suffice for
~10 scenarios.

Each scenario YAML extends the fixture shape with one optional
section the runner consumes:

```yaml
# W0.3 — bot_in_water_rescue.yaml
world: landfolk-test

prep:
  - "execute in landfolk-test run fill 200 60 200 220 64 220 minecraft:air"
  - "execute in landfolk-test run fill 200 60 200 220 61 220 minecraft:stone"
  - "execute in landfolk-test run fill 200 62 200 220 62 220 minecraft:water"
  - "execute in landfolk-test run fill 220 62 200 220 64 220 minecraft:stone"  # east shore
  - "mvtp Flint landfolk-test"
  - "execute in landfolk-test run tp Flint 210 62 210"  # bot dropped in middle of pond
  - "clear Flint"
  - "give Flint oak_boat 2"

# NEW: assertions section consumed by run-water-fixture.sh
expect:
  commands:
    - cmd: "sail_to 221 63 210"
      envelope:
        ok: true
        data.phases_executed_contains: ["in_water_rescue"]
  final:
    bot_within: { x: 221, y: 63, z: 210, radius: 4 }

cleanup:
  - "execute in landfolk-test run tp Flint 52 65 52"
  - "execute in landfolk-test run fill 200 60 200 220 64 220 minecraft:air"
```

### 3. Initial scenarios (W0.1–W0.7)

| # | Scenario | Catches |
|---|---|---|
| W0.1 | Bot on shore A, target on shore B, simple lake between | sail_to happy path on real server |
| W0.2 | Lake with island; BFS must route around it | y+1 obstruction handling |
| W0.3 | Bot dropped mid-pond, target on shore | F9 in_water_rescue |
| W0.4 | Bot in desert, ocean shore 30b east | F10 nearest_water_candidate |
| W0.5 | Cave water pool nearby + ocean farther away | F12 surface-only filter |
| W0.6 | Pier deck at y=63 spans a channel | y+1 head-clearance check |
| W0.7 | Long sail (200b) across continuous open water | multi-leg waypoint follow |

Add W0.8+ when new bugs surface.

## What this does NOT need

- **No new world.** `landfolk-test` already supports `/fill`-based
  scenario building. Pick a region (e.g. (5000, 60, 5000)) far from
  spawn so other tests don't collide.
- **No new bot launcher.** Use the existing Flint / Tester / Steve
  bots that already connect to `landfolk-test` via `mvtp`.
- **No new HTTP harness.** `bin/mc` returns JSON and exits non-zero
  on `ok: false`. `bash` + `jq` can assert on `.data.phases_executed`
  / `.error.code` / `.error.observed_state.nearest_water_candidate`.

## Implementation order

1. **One scenario end-to-end** (W0.5 — F12 regression). Builds the
   runner skeleton, proves the assertion pattern works.
2. **W0.1 + W0.3** — happy path + F9. These are the two highest-
   value scenarios.
3. **W0.4 + W0.6** — F10 + the y+1 pier obstruction.
4. **W0.2 + W0.7** — island detour + long sail.

## Test region

Use the area `(5000, 60, 5000)` to `(5100, 70, 5100)` in
`landfolk-test`. Far from the existing `(0..52, 65, 0..52)` primitive
fixtures. `cleanup:` blocks should `/fill` the region back to air to
keep the world tidy.

## Risks

- **Chunk-load races.** Bot may take 1-2 ticks to "see" freshly
  `/fill`-ed water. Mitigate with a `sleep 2` after prep, before
  asserting.
- **Boat physics flake.** Boats sometimes refuse to mount on first
  try (covered by existing v8-v22 fixes). Each scenario should
  allow 1 retry of the asserted command.
- **Bot state pollution between scenarios.** Always `clear` + re-tp
  + re-give in `prep:`. The existing fixtures already follow this
  pattern.

## Maintenance

When a new water-nav bug surfaces in a circuit-v* run, write the
regression as W0.N before fixing. The fixture stays as documentation
of what should never break again.

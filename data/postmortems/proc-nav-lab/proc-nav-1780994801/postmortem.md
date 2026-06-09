# Postmortem — proc-nav-1780994801 — PASS

**Date:** 2026-06-09
**Outcome:** **PASS** — 13/13 cards complete, 0 manual interventions, 88 min wall time. First end-to-end road tier run without operator unblock/babysitting. Validates every architectural fix from the prior trial's postmortem.
**Trial graph:** `proc-scout-road` (4 segments, 3-wide, 48 blocks centerline, Mox + Pip).

## Headline numbers (from scorecard.json)

| Metric | Value |
|---|---|
| Band | **pass** |
| Cards done | 13/13 |
| Wall time | 5282s (88 min) |
| mc_cli_invocations | 1193 |
| Manual interventions | **0** ← first time ever |
| nav_escape_count | 12 |
| mc_dig_count | 560 |
| mc_build_stairs_count | 4 |
| mc_scene_count | 75 |
| mc_go_mark_count | 3 |
| anchors_reached_ratio | 1.0 |

## Architectural fixes validated under live load

### 1. W2-NAV-009 mutex enforcement (gate-check Step 3 + 5b) — ✓

Prior trials required manual `hermes kanban block` to prevent two `[bot:mox]` or `[bot:pip]` cards from claiming concurrently. This trial: **0 manual interventions**, mutex held across the full run. When the segment-table planner completed and `recompute_ready` promoted all 4 measure cards in one shot, gate-check Step 3 parked siblings cleanly. Monitor's `MUTEX_VIOLATION` filter never tripped.

### 2. Scout-layer target_y from terrain_top median — ✓

Scout output: `elevation_median=78`, `elevation_delta=3`. Explicit rejection of catalog Y (overlook=67, return_post=68) noted in the worker session. Same shape as prior trial — this fix is now battle-tested twice.

### 3. **NEW** Planner target_y discipline in `_segment_plan_body()` — ✓

This was the bug from the previous trial's postmortem. With the new card body language:

> "**NEVER** copy `placements.overlook[1]` or `placements.return_post[1]` from `data/runtime/last-scenario-map.json` into `road_plan.target_y_default`… **DO** set `road_plan.target_y_default = corridor_profile.elevation_median`"

The planner produced `road_plan.target_y_default = 78 == elevation_median`. No regression to catalog Y. Pinned by `test_segment_table_planner_enforces_target_y_from_elevation_median`.

### 4. **NEW** Persistent road_plan path (W2-NAV-008) — ✓

Planner wrote `data/runtime/proc-nav-road-plan.json` (in repo). Downstream measure + clear cards successfully read it after the planner's ephemeral workspace was GC'd. Prior trial's "workspace GC'd, downstream blind" problem fully resolved.

### 5. **NEW** Literal `mc terrain_top` commands in `_meas_body()` — ✓

All 4 measure cards ran the 9 hardcoded sampling commands. Worker reasoning shows the literal verbs being executed in order — no procedural skip, no "I'll just trust the planner's target_y" shortcut (the failure mode that bit Pip in the prior trial).

### 6. **NEW** Builders use new road-tier primitives — ✓

Pip seg 1 + Pip seg 3 both issued `mc clear_strip -1 0 1 12 surface_y=<X> road_mode=true`. Mox + Pip combined ran ~40 `mc level_ground` calls (mix of dry-run + execute). Doctrine adapted: when 3×12 exceeded the 16-col cap, agents split into 3×4 sub-tiles. The new `mc deck` and `mc fell_tree` weren't needed (no deep dips, no individual trees flagged).

## Issues that surfaced

### A. SYNC_STUCK_ACTIONS regression (FIXED mid-trial)

**Symptom**: Mox observed wedged on a block edge for ~2.4 min during a `level_ground execute` call. Pathfinder animating but not advancing.

**Root cause**: The reactive stuck-detection + recenter-nudge in `manager.js:~1080` only fires for actions in `SYNC_STUCK_ACTIONS`. That set was **missing 8 verbs**: `level`, `level_ground`, `dig_pit`, `build_stairs`, `clear_strip`, `deck`, `fell_tree`, plus the older shapers had never been registered. So while `level_ground execute` ran (~25s), the stuck-nudge code never executed.

**Fix**: Hoisted `SYNC_STUCK_ACTIONS` to module-level export. Added all 8 missing verbs. Three new contract tests in `bot/test/bot-manager.test.js`:
- `SYNC_STUCK_ACTIONS includes all movement-bearing road-tier verbs` — fails if a future road verb is added without registering
- `SYNC_STUCK_ACTIONS preserves the original movement verbs` — regression guard
- `SYNC_STUCK_ACTIONS does NOT include pure-look / pure-inventory verbs` — prevents false-positive logs

Future road trials get the nudge fix automatically. Mox in this trial escaped via natural pathfinder retry — confirmed by his y=75 → y=79 transition between my samples.

### B. Per-segment target_y mismatch creates ±1 boundary steps

**Symptom**: Road surface at z=20 sits at y=79, while z=16 and z=24 are at y=78. The user observed "+/- 1 block floating on the paths".

**Root cause**: Each measure card computed its OWN segment median, not the corridor median:
- Seg 1 (z=0..12): target_y=78
- Seg 2 (z=12..24): **target_y=79**
- Seg 3 (z=24..36): target_y=78
- Seg 4 (z=36..48): target_y=78

The `_meas_body()` card body explicitly permits this: *"The measure card may revise per-segment based on its own samples; the planner just seeds the median."* That permission is the source of the variation.

**Live disposition check**: Running `mc level_ground -1 0 1 4 target=78` against the finished road right now returns `dispositions: {level: 7, cut: 8}` — 8 cells in seg 1 alone still need cutting because their actual y is 79 (matching seg 2's target).

**Recommendation (P1)**: In `_meas_body()`, tighten the rule to *"target_y MUST equal corridor_profile.elevation_median unless the local median diverges by ≥2"*. The "may revise" language was too soft.

### C. Sub-tile timeouts during `level_ground execute=true`

**Symptom**: Multiple `level_ground execute=true` calls returned `[exit 1]` after 25.3s (HTTP long-action timeout). Agents retried with smaller rectangles, but some cells were left unleveled.

**Root cause**: The bot's HTTP layer caps long actions at 25s by default (`MC_HTTP_LONG_ACTION_MS`). `level_ground` with execute=true does serial pathfind+dig+place across up to 16 cells, often exceeding 25s.

**Recommendation (P2)**: Either (a) raise the timeout to 60s for `level_ground execute`, or (b) chunk execute into 4-col batches with intermediate progress reporting so the HTTP response returns within 25s and the agent re-invokes. Option (b) is cleaner.

### D. Verify card doesn't re-run dispositions across the full corridor

**Symptom**: Verify card passed (`all 3 road_bound_* marks satisfied`) despite the ±1 cell variations above.

**Root cause**: The `[VERIFY] road corridor` card body walks anchors and runs `mc verify at_mark`, but does NOT re-run `mc level_ground target=<corridor_median>` across the full corridor to assert `dispositions.level == columns_n`. So leveling failures pass through silently.

**Recommendation (P1)**: Add a `mc level_ground` dispositions sweep to the verify card body. If `dispositions.cut + dispositions.fill_* != 0`, fail the verify or emit a `[CLEANUP]` follow-up card.

### E. Biome regen (snowy taiga)

**Symptom**: Snow_layer accumulating on the road at y=79-80. Grass_block spreading laterally to expose-dirt cells. By the time we sampled the road, biome regen had visibly modified the surface.

**Root cause**: This is Minecraft biome physics; snow falls and grass spreads. Not a builder bug.

**Recommendation (P2)**: For snowy biomes, use `cobblestone` for the road bed instead of `dirt`. No grass spread, snow_layer still falls but is visually consistent with a stone road.

## What didn't happen this trial (but should next)

- **`mc deck` was never called** — no segment hit the "deep dip" threshold (the terrain was uniformly flat). Worth a stress trial in cratered terrain to validate deck in production.
- **`mc fell_tree` was never called** — `mc clear_strip road_mode=true` handled trees in bulk. The single-tree primitive remains validated only by unit tests.
- **`catalog_y_drift` obstacle entry** — the planner card body requires this when catalog Y vs elevation_median differs by ≥4. Delta was 11; entry was not produced. Soft compliance gap — doctrine bite was strong enough on target_y itself that the audit-trail entry didn't change behavior, but worth checking in next trial.

## Comparison to prior trial (proc-nav-1780989125, FAIL)

| Concern | Prior trial | This trial |
|---|---|---|
| Stopped mid-trial | Yes (host reboot) | No — full completion |
| W2-NAV-009 mutex | Worked (Step 3) | Worked (Step 3) |
| Scout target_y | ✓ elevation_median=80 | ✓ elevation_median=78 |
| Planner target_y | ✗ wrote catalog Y=67 | ✓ wrote elevation_median=78 |
| Per-segment measure | Pip used catalog 67 | All used scout-derived per-seg median (varied 78-79) |
| Builder primitives used | Never reached | clear_strip + level_ground heavily used |
| Manual interventions | 2 (block dups, fix planner) | **0** |
| Cards complete | 3/13 (stopped) | 13/13 |
| Scorecard band | n/a (interrupted) | pass |

## Files saved

```
data/postmortems/proc-nav-lab/proc-nav-1780994801/
  postmortem.md            ← this doc
  scorecard.json           ← band=pass, 13/13, 5282s
  spatial-map.html         ← visual run map
  telemetry.jsonl          ← 32KB of run_proc_nav telemetry
  manifest.json            ← capstone card manifest at create-time
  feedback-*.md            ← (per-role agent reports, in flight)
```

## Open items (carried into next trial)

1. **P1**: Pin `target_y` to corridor median in `_meas_body()`; soft "may revise" → hard "must match within ±2".
2. **P1**: Verify card runs `mc level_ground` dispositions sweep; emit `[CLEANUP]` card on failure.
3. **P2**: Raise `MC_HTTP_LONG_ACTION_MS` for level_ground execute, or chunk into 4-col batches.
4. **P2**: Builder doctrine — use cobblestone in snowy/swamp biomes (no grass regen).
5. **P3**: Stress trial with cratered terrain to exercise `mc deck` in production.

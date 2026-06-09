# Builder feedback — proc-nav-1780994801

Post-trial report for the **builder** role (Pip bot) on road corridor segments 1 and 3.

## Problems hit

- **Parent survey `passage=deck` classification was consistently wrong.** Both segment 1 and segment 3 were tagged as needing deck spans. Segment 1 was inflated by a spruce tree canopy (snow on leaves at Y=97 vs actual ground at Y=78); after canopy removal all 3 sub-chunks were standard dig terrain with `deck_required_n=0`. Segment 3 was a target_y mismatch — the parent surveyed at terrain median Y=81, but the road_plan specified target_y=78, and at Y=78 the entire segment was cut with 0 deck cells. Wasted time debating whether to follow road_plan elevation or parent classification.

- **`mc level_ground` silently caps at 16 columns per call.** Segment calls had to be split into 3 sub-calls each (Z=0..12 → Z=0..3, 4..7, 8..12; Z=24..36 → Z=24..28, 29..33, 34..36). There's no `--batch` or `--force` flag to allow larger rects. The manual splitting adds overhead and the split boundaries are guesswork (no error says "max 16 columns", you just get a partial result).

- **Spruce trees inside the corridor band block movement.** At segment 3 the spruce at Z=36 had a dense canopy that broke pathfinding — couldn't `mc goto` through it. Had to detour outside the corridor (and then build stairs to climb back, then clean up the stair debris). The tree-felling tools (`mc clear_strip`) work fine for *lifting* the logs, but the foliage persists and remains a navigation obstacle long enough to stall a worker.

- **Navigation edge-case on segment 3 caused collateral excavation.** When pathfinding failed around the tree at Z=36, I fell back to `mc dig_area` which over-shot and created a hole at (1,78,24) that needed manual repair. An "undo last dig" or patch-fill primitive would have saved several turns of cleanup.

- **Env var discovery pattern:** Road plan at `$HERMESCRAFT_REPO/data/runtime/proc-nav-road-plan.json` worked after finding the var, but the card body didn't link directly to the plan path — had to discover it via `find`.

## Tooling improvements

1. **`mc level_ground` batch-mode flag** — a `--max-columns N` or `--force` option that lets the caller override the 16-column limit in one call. The splitting is mechanical and wastes turns.

2. **Post-canopy foliage sweep** — after `mc clear_strip` fells a tree inside the corridor, auto-remove leaf blocks in the band or provide `mc clear_leaves x1 z1 x2 z2` that clears leaf blocks (which break by hand instantly) within a bbox. The logs are gone, but leaves make the cell look "occupied" to pathfinding.

3. **Parent survey hint: `target_y` used in survey** — the parent SCOUT card's body should record which `target_y` it used. Currently the survey schema says the metrics (`deck_required_n`, `terrain_top[]`) but doesn't note the elevation assumption. If segment 3 had been surveyed at target_y=78, it would have shown `deck_required_n=0` on day one and saved the whole deck-debate loop.

## Bundle / skill gaps

- The `minecraft-roadbuilding` skill covers road planning and corridor clearing, but doesn't document the `mc level_ground` 16-column cap or the `passage=deck` overturn pattern. Would be worthwhile to add a pitfalls section about target_y mismatches between parent survey and road_plan.

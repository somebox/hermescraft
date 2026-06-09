# navigator FEEDBACK — proc-nav-1780994801 (bot:mox)

Cards worked: t_e009ee92 [SCOUT], t_7327ef41 [MEASURE seg 1], t_648102c0 [MEASURE seg 3], t_0ed9ae7e [VERIFY]

---

## Problems hit

1. **Catalog anchor Y vs surface Y mismatch (every card)** — Overlook=67, return_post=68, but the actual walkable terrain is Y=78-80. Every card's first turn was "why is the anchor in the air / below ground?" This cost 3-5 turns of `mc scene` + `mc terrain_top` sampling per card just to find the real surface. The SCOUT card computed `target_y=78` in its handoff metadata, but downstream MEASURE and VERIFY cards don't inherit it — each worker independently rediscovers the surface height.

2. **`mc verify at_mark` returns "satisfied" but distance 0.89-1.57 blocks** — The verify passes but the bot isn't on the exact mark cell. A builder consuming the handoff needs the precise standable coordinates (e.g. `0,79,13` not just "road_bound_1 at Z=13"). The dist range means "you're in the right column but may be one cell off laterally."

3. **No surface-aware `goto` for unreachable marks** — VERIFY card hit `return_post` mark at Y=68, but the road surface is Y=79 with a sheer cliff face between them. No smooth primitive to say "go to the surface above mark X." Had to manually probe with `mc reachable` + navigate to an adjacent cell 11 blocks higher, then confirm the mark's lateral position from above.

4. **Segment 2 (Z=13→24) was never explicitly measured** — The corridor was split into segments 1 (overlook→road_bound_1, Z=0→13), 2 (road_bound_1→road_bound_2, Z=13→24), and 3 (road_bound_2→road_bound_3, Z=24→37). Cards only existed for segments 1 and 3. No worker surveyed the middle third of the corridor.

5. **`mc scene` terrain_top sampling is tedious across 3-wide cross-sections** — For each of 9 stations, I called `mc scene` 3 times (X=-1, 0, +1) to build the cross-section. That's 27 `mc scene` calls just for one corridor. A `mc terrain_profile X1,Z1 X2,Z2` verb that samples a line in one call would save ~20 calls per scout card.

## Tooling improvements

1. **`mc goto_surface_at <mark>`** — Navigate to the walkable surface Y above a named mark, rather than the mark's stored (potentially airborne/subterranean) anchor coordinates. This would have saved 3-5 turns per card on this run.

2. **`mc terrain_profile X1,Z1 X2,Z2 --width 3`** — Batch terrain-top sampling along a line corridor. Returns an array of `{x, z, surface_y}` samples at 1-block intervals. Would collapse 27 individual `mc scene` calls into a single verb across the corridor centerline, then a `--width` flag for the lateral cross-section.

3. **Cross-card `target_y` handoff** — When SCOUT computes `corridor_profile.elevation_median`, downstream cards (MEASURE, VERIFY, CONSTRUCT) should receive it as a precondition hint. Currently `kanban_show` metadata isn't read by the dispatched worker automatically; each card has to rediscover. A `target_y` field on the board card body that the SCOUT worker writes and downstream workers read would save the rediscovery loop.

## Skill / profile / SOUL issues

- **minecraft-roadbuilding skill was accurate** about the catalog Y drift — it warns that anchor Ys may be 10+ blocks above the road floor. That warning was correct and saved me from confusion on first contact. No stale content found.
- **No playbook protocol (stage 2a)** was active on this board. The SOUL dispatched the right cards in order (SCOUT → MEASURE/VERIFY), but the handoff between them was unstructured — each worker landed cold. A structured `[run_state]` comment on the SCOUT card with `target_y: 78` would have helped downstream workers skip surface discovery.

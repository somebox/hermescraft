# FEEDBACK — navigator on proc-nav-1780989125 (t_1b7a669b "scout road corridor")

**Worker session**: 20260609_091735_04d605
**World**: proc-nav / snowy_taiga / seed 1001
**Bot**: mox

---

## Problems hit

1. **Bot spawned standing on top of another bot (Pip).** First `mc status` showed
   `situation: "Standing on Pip at -19,78,28 (an entity, not solid ground)"`
   with a **5.7-minute stuck_warning**. Had to resolve the sticky entity situation
   before any corridor work — consumed 4 turns on orientation and movement before
   reaching the overlook anchor.

2. **Catalog Y = 67/68 was 12+ blocks below live surface.** The card correctly
   warned about this, and the skill backed it up, but the *planner* (`t_eb406642`)
   had already emitted `road_plan.json` with `target_y: 67 (seg 1-3) / 68 (seg 4)`.
   The scout's corridor_profile came back with elevation_median=80 and delta=11
   (79→90). That means every downstream segment-measurement card inherits a
   target_y that is 12 blocks too low — they'll dig trenches. The planner has no
   feedback loop to update target_y from scout output.

3. **`mc move` is pathfinding-bounded to ~1–2 blocks per call with `--near 1`.**
   Walking the full 48-block corridor required 24+ individual `mc move` calls
   (or batched loops of ~5 moves per script). There is no "walk corridor" verb
   (`mc walk_path`, `mc traverse`, `mc goto_path`) that takes a sequence of
   waypoints and walks them in one invocation.

4. **`mc scene` at every 2-block interval floods the context window.** Each
   `mc scene` call returns ~0.5–1 KB of rich block/entity data. For 20+
   interval points that's 15–20 KB of scene data that the agent must parse.
   The scene call could not be suppressed — it's the only verb that gives
   a full block-level picture of the bot's surroundings at a point.

5. **No batch terrain_top for cross-section sampling.** The scout needed 3-wide
   cross-sections (X=-1,0,+1) at 5 Z positions — 15 individual `mc terrain_top`
   calls. A `mc terrain_top --rect X1 Z1 X2 Z2` that returns surface_y per
   cell in one go would have reduced these to 5 calls, and for a 3-wide strip
   it would have been 5 calls instead of 15.

6. **Stale marks from prior sessions.** The world had `death_4/5/6` marks from
   earlier runs that were not relevant to the corridor. `road_bound_1/2` existed
   from a prior scout (04:22 run) and were overwritten with updated coords.
   Without a session-scoped or task-scoped mark namespace, the mark list fills up
   with stale entries.

7. **`execute_code` batching — effective but verbose for downstream readers.**
   Piping `mc move`+`mc scene` through a Python script saved round-trips but
   produced output with tool_calls_made=14 per batch, and the scene output
   was interleaved with terrain_top JSON in the same output buffer. Hard to
   separate.

---

## Tooling improvements that would help

1. **`mc corridor_sample <start_x> <z1> <z2> [width=3] [step=2]`** — A single verb
   that walks a corridor (or simulates walking it), runs `terrain_top` at each
   step interval for the full cross-section width, and returns a compact array
   of `[{z, surface_y_at_x_center, cross_section: {x:-1:y, x:0:y, x:+1:y}}]`.
   Would eliminate ~40 individual tool calls (moves + scenes + terrain_tops).

2. **Corridor planner → scout feedback loop.** After the scout computes
   `corridor_profile.elevation_median`, that value should propagate back to the
   planner's `road_plan.json` as the updated `target_y`, with downstream segment
   measurement cards inheriting the corrected value. Currently the planner emits
   Y=67/68 and the scout discovers Y=median=80 with no path for the delta to
   correct the plan.

3. **`mc terrain_top --rect X1 Z1 X2 Z2`** to batch-sample a rectangle's
   surface_y in one call. When the corridor is axis-aligned, 3-wide × N-long,
   a single call gives the entire grade profile without 3N individual calls.

4. **Task-scoped marks (namespace or ephemeral).** A way to scope marks to
   "this session / this task id" so that stale marks from unrelated prior
   tasks don't clutter `mc marks` output and aren't accidentally resolved by

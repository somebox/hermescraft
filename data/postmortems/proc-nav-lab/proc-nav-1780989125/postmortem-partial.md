# Partial postmortem — proc-nav-1780989125 (interrupted)

**Date:** 2026-06-09
**Outcome:** Stopped early — ubuntu-host (MC server) needed a reboot. Trial ran ~18 minutes; 3/13 cards reached `done` (RESEARCH playbook, scout, segment-table planner); 2 measure cards were running when killed; the rest in todo/ready.
**Status of validation fixes:**

| Fix | Verdict | Evidence |
|---|---|---|
| W2-NAV-009 mutex (Step 3 + 5b) | ✓ **WORKS** | Both `t_8ff49367` (Mox seg 3) and `t_d59b9351` (Pip seg 4) carry `mutex_parked` events with `reason=per_key_mutex` and the right `lock=mutex_park:bot:<name>`. Zero concurrent same-bot cards observed across the entire run. |
| Scout target_y discipline | ✓ **WORKS** | Scout `t_1b7a669b` summary explicitly noted: "Catalog Ys (overlook=67, return_post=68) are 10+ blocks below actual walkable surface (median 80). Using terrain_top median as instructed." Output `corridor_profile.elevation_median = 80`. |
| Planner target_y discipline | ✗ **FAILS** | Segment-table planner `t_40f71914` produced `road_plan.json` with `target_y_default: 67`, `target_y_final: 68`, and `dig_depth_start: 12, dig_depth_end: 13` per segment — i.e. dig 12+ blocks down THROUGH the live surface to reach the catalog Y. The scout's `elevation_median = 80` was carried forward in `corridor_profile.elevation_median` but **ignored when computing per-segment target_y**. |
| Measure card target_y discipline (variable) | ◐ **PARTIAL** | Mox (measure seg 1) explicitly rejected the planner's bad target_y: *"I need to derive target_y from terrain samples, not copy the catalog Y"* → ran `mc level_ground 0 1 2 4 target=80` correctly. Pip (measure seg 2) accepted the planner's output uncritically: *"target_y=67 per catalog"*. Same skill installed; different worker judgment. |
| Mutex fix observed under real load | ✓ | Per the mutex_parked events, gate-check Step 3 caught the race when the segment-table planner completed and recompute_ready (inside that worker's complete_task) promoted all 4 measure cards simultaneously. Two became ready+unlocked (seg 1 + seg 2), two became ready+mutex_parked (seg 3 + seg 4). |

## What we wanted to learn

This was the first end-to-end run of the new doctrine + primitives + mutex fix from the previous postmortem (`data/postmortems/proc-nav-lab/proc-nav-1780970837/postmortem.md`). The hypothesis: with `clear_strip`, `deck`, `fell_tree`, `level_ground` dispositions, scout-layer target_y, and the W2-NAV-009 mutex fix all in place, the road tier would compose without manual mutex babysitting or target_y=67 trenching.

## What we learned

### 1. The mutex fix is solid.

When the segment-table planner completed, `recompute_ready` (inside its `complete_task`) promoted all 4 measure cards simultaneously — exactly the race that hung the previous trial. The next gate-check tick saw 4 ready cards, grouped them by mutex key, picked one head per key, and parked the other two. Both parked cards have `mutex_parked` events with `reason: per_key_mutex` and `lock: mutex_park:bot:<name>`. The dispatcher then claimed only the 2 unlocked siblings.

**Diff from the previous trial**: previously we had to manually `hermes kanban block` siblings to prevent collisions. This time, zero manual intervention. The Step 3 path in `gate.py` already caught it; Step 5b (the pre-park) is the belt-and-suspenders fallback.

### 2. The scout-layer target_y fix is solid.

`t_1b7a669b` scout output:
- `elevation_median = 80`
- `elevation_delta = 11` (79 → 90)
- 15 surface_y samples: `79,79,79,80,80,80,80,80,80,81,81,81,86,89,90`
- Explicit rejection of catalog Y in the comment: *"Catalog Ys (overlook=67, return_post=68) are 10+ blocks below actual walkable surface (median 80). Using terrain_top median as instructed."*

This is the W2-NAV-001 root cause finally fixed at the source. The skill doctrine + the explicit "Target Y discipline (CRITICAL)" section in `_explore_body()` worked.

### 3. The PLANNER (`_segment_plan_body`) does NOT carry the same anti-catalog-Y discipline.

This is the bug that surfaced. The planner card body (`_segment_plan_body()` in `proc_scout_road_graph.py`) says:

> "Read **`corridor_profile`** + **`data/runtime/last-scenario-map.json`**. Emit **`road_plan`** JSON with exactly **4** segments… Merge elevation + obstacles; tooling per bot…"

There is NO instruction to use `corridor_profile.elevation_median` as `target_y`. The planner reads both inputs, sees the `road_plan` schema with a `target_y` field, and apparently defaults to the catalog endpoint Y from `last-scenario-map.json` (Y=67 at overlook, Y=68 at return_post). The scout's elevation_median is faithfully copied into `corridor_profile.elevation_median: 80` in the output, but the per-segment `target_y: 67` ignores it.

### 4. Per-segment measure card doctrine works for some workers, not others.

The measure card body (`_meas_body()`) **does** carry the target_y discipline (4-step procedure: terrain_top → median → level_ground dispositions → passage choice). Mox applied it correctly:

> *"I need to derive target_y from terrain samples, not copy the catalog Y. Let me check the workspace and road_plan first, then resolve the marks."*

→ then ran `mc level_ground 0 1 2 4 target=80` (using scout's median).

Pip did not:

> *"From the parent metadata: segment 2 is the even segment (Pip measures, Mox clears), 11 blocks long, centerline along +Z, road_bound_1 @ Z=12, road_bound_2 @ Z=23, target_y=67 per catalog."*

Both workers have identical skill installs. The difference is reasoning: Mox spotted the discrepancy between the planner's target_y=67 and what the scout said; Pip accepted the planner's output at face value.

## Root cause ranking for the resume

1. **Planner card body lacks target_y discipline.** Same root cause as the scout fix from the previous postmortem, just one card tier up. Fix: `_segment_plan_body()` needs an explicit "Target Y discipline" section requiring `target_y = corridor_profile.elevation_median`, prohibiting catalog Ys.

2. **Measure card body's target_y procedure isn't being applied uniformly.** Mox spotted the planner's bad target_y; Pip didn't. The doctrine in the card body needs a STRICTER bite — perhaps a literal command-line instruction (`mc terrain_top X Z` × 9 explicitly) rather than a procedure description.

3. **`road_plan.json` workspace ephemerality (W2-NAV-008 still open).** Measure cards couldn't read the planner's `road_plan.json` from `t_40f71914`'s workspace because the workspace was deleted on planner completion. Mox tried: `read /Users/foz/.hermes/kanban/boards/proc-nav-lab/workspaces/t_eb406642/road_plan.json` → File not found. Worker adapted by re-deriving from scout summary, but the orchestration isn't clean.

## Action items for resume (post-reboot)

| # | Fix | Where | Priority |
|---|---|---|---|
| 1 | Add target_y discipline to `_segment_plan_body()` | `prototypes/agent-arch/capstone/proc_scout_road_graph.py` | **P0** — blocks all downstream segments |
| 2 | Pin the planner discipline with a test (mirror `test_explore_card_enforces_target_y_from_terrain_top`) | `prototypes/agent-arch/tests/test_proc_nav_road_graph.py` | P0 |
| 3 | Tighten `_meas_body()` so the terrain_top sampling is a literal `mc` command in the card, not a procedure description | same file | P1 |
| 4 | Resolve W2-NAV-008 — write `road_plan.json` to a persistent path or persist via kanban metadata | same file or workflow | P1 |
| 5 | Re-launch trial after reboot | — | (depends on the above) |

## What survived the kill

- Scout output (corridor_profile, elevation_median=80, obstacles) — in the kanban DB under `t_1b7a669b`, also reproduced in `t_40f71914`'s `road_plan.json` corridor_profile section.
- Segment-table planner output (road_plan.json with the bug) — in `~/.hermes/kanban/boards/proc-nav-lab/workspaces/t_40f71914/` if not yet cleaned.
- Mox + Pip partial measure work — in the per-card logs `~/.hermes/kanban/boards/proc-nav-lab/logs/t_87a4e2d6.log` (Mox) and `…/t_3433d65a.log` (Pip).
- Dispatcher log — `/tmp/proc-nav-dispatcher-proc-nav-1780989125.log`.
- Agent feedback — recovered via grep on the worker session diffs (the feedback files themselves were lost to W2-NAV-008 ephemeral workspaces; the diffs in `~/.hermes/kanban/boards/proc-nav-lab/logs/t_a3e5e3c7.log` and `…/t_1ef71a61.log` captured the markdown content). Saved here as `feedback-navigator.md` and `feedback-navigator-pip.md`.

## Agent-reported findings (cross-check)

The Mox navigator feedback (filed *during the trial*, before this postmortem) independently identified the planner target_y bug:

> "every downstream segment-measurement card inherits a target_y that is 12 blocks too low — they'll dig trenches. The planner has no feedback loop to update target_y from scout output."

And the top tooling suggestion was:

> "Corridor planner → scout feedback loop. After the scout computes corridor_profile.elevation_median, that value should propagate back to the planner's road_plan.json as the updated target_y."

Pip's navigator-pip feedback flagged:
- **Duplicate dispatch artifacts** referencing cards from the PRIOR trial (t_2d789197, t_7beebe00, t_2a060b28, t_7e650cb4). Pip's feedback worker pulled context from board archives, conflating runs. Suggests the feedback card body should explicitly scope to "this run_id only".
- **road_plan.json workspace GC** confirmed by Pip too (re-statement of W2-NAV-008).
- **Stuck_warning inheritance across sessions** — worth investigating; Pip claims a stuck_warning from a previous worker session showed up in the current session's startup state.

Both navigators independently flagged the catalog-Y vs surface-Y gap — confirming the planner doctrine bug is observable from the worker side AND would have been caught by the worker if the worker had been allowed to override the planner's target_y (Mox did; Pip didn't).

## Diff from the prior trial (proc-nav-1780970837)

| Concern | Prior trial | This trial |
|---|---|---|
| Catalog Y propagation | scout output had Y=67 baked in | scout outputs elevation_median=80 explicitly ✓ |
| Mutex same-bot serialization | Manual `kanban block` babysitting required | Automatic via Step 3 + 5b ✓ |
| Planner→builder pipeline | Builder cards prose-only, no literal verbs | Same: builder card bodies still need literal verbs (untested here — never reached) |
| `level_ground` dispositions | Did not exist | Existed; Mox used `mc level_ground target=80` correctly |
| `clear_strip` / `deck` / `fell_tree` | Did not exist | Existed; never reached in this trial (stopped at measure phase) |
| Trial-time issues | mid-trial mutex collisions, bad target_y | One bug found: planner doctrine gap |

## Bottom line

The mutex fix and the scout fix both held under live load. The next bug is one tier up — the segment-table planner. Same shape of fix as the scout (instructive doctrine in the card body), trivial to apply, easy to pin with a test.

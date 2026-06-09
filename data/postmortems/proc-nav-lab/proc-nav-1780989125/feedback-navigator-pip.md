# FEEDBACK: navigator-pip on proc-nav-1780989125

**Run:** proc-nav-1780989125
**Board:** proc-nav-lab
**Cards worked:** t_2d789197 (seg 2), t_7beebe00 (seg 2 retry), t_2a060b28 (seg 4), t_7e650cb4 (seg 4 × 3 dispatches)
**Bot:** Pip (navigator-pip)

---

## Problems Hit

1. **Duplicate measurement cards dispatched for the same segment.** Segment 2 was dispatched twice (t_2d789197 → t_7beebe00) and Segment 4 was dispatched at least 3 times under t_7e650cb4 across multiple respawns. Each dispatch measured the same stretch from scratch — no mechanism to detect "already measured" and skip. The third seg-4 worker (04:35 UTC) discovered it by checking kanban_show mid-run and finding a prior completed run, but the first two both burned full measurement loops.

2. **Parent workspace (scratch, GC'd) → road_plan.json gone.** The road plan lived in `t_699233ce`'s scratch workspace, which was garbage-collected by the time segment workers needed it. Workers had to fall back to hardcoded coords from the card body and memory — the authoritative plan document was unreachable. Scratch GC is correct for disk hygiene, but the plan should have been duplicated into each child card's body or persisted in a `dir:` workspace.

3. **Direct SQLite write to complete a task (anti-pattern).** In the 04:27 UTC seg-4 run, the worker wrote `sqlite3` UPDATE statements directly to the kanban DB to force-mark the task done. This bypasses the `kanban_complete` tool and leaves no structured handoff. The worker appeared to be working around a "task already completed" issue, but shelling into the DB is the wrong fix.

4. **Stuck_warning on session start (seg 2, t_2d789197).** The bot spawned at (-19, 80, 28) with a stale `stuck_warning` from the previous worker's position. The probe protocol (read_chat, reachable, scene) handled it well, but the warning cost ~4 orientation turns. The navigation system doesn't clear the stuck flag when a new worker claims the card and inherits the same position.

5. **Cliff depth not explicitly flagged in card body.** Segment 2 had a 4-block cliff drop at road_bound_2, and Segment 4's start had a 12-block vertical shoulder. These were discovered via `mc scene`/`mc inspect` during measurement — neither card body pre-flagged them. A "terrain_anomalies" field in the parent card or road plan would save the worker from surprise.

## Tooling Improvements

1. **`mc segment_status <id>` or equivalent idempotency check.** A verb that answers "has this segment already been measured?" — checking for measurement files, kanban run status, or a world mark — would prevent duplicate measurement loops. Currently the only way to detect this is noticing the card's prior runs manually.

2. **Persist road plan to child card bodies.** Either (a) embed the segment-specific plan snippet directly in each child card's body at dispatch time, or (b) use a `dir:` workspace for the common road plan so it survives GC. Scratch GC is correct cleanup; the fix is to not rely on scratch for shared reference data.

3. **`mc marks` should survive re-dispatch.** Between runs, the marks are in-world and fine — this worked. No issue here, just noting that marks-on-the-ground were the most reliable reference across dispatches.

4. **Stuck_warning should be clearer per-worker.** If a new worker spawns at a position where a prior worker was stuck, the warning is inherited. The flag should reset on new worker claim, or the warning should include "inherited from previous run" context so the worker doesn't waste turns on stale orientation.

## Skill / SOUL / Profile Issues

1. **No stale/missing bundle items noticed.** The `minecraft-navigation` skill, nav measurement workflow, and profile config all loaded correctly. The probe protocol from `kanban-worker.md` worked as documented for the stuck_warning case.

2. **Memory continuity proved valuable.** Workers that wrote memory checkpoints at completion (pos, coords, context) enabled subsequent runs to orient faster. The memory replace/update pattern used across the seg-4 dispatches worked cleanly.

3. **`mc chat` narration was present but thin.** Workers used `mc chat "done t_xxx: ..."` at completion but rarely narrated mid-work progress. Per the kanban-worker skill guidance, ~1 chat per 3-5 mc verbs is expected; actual ratio was closer to 1 chat per 20+ verbs. The fleet would benefit from more frequent progress narration.

4. **Clear bot convention noted but not enforced.** Each measurement card ended with "clear bot is Mox (I only measure)" — this is a convention from the card body, not a framework-enforced role. It worked but relies on both Pip and Mox reading each other's card bodies.

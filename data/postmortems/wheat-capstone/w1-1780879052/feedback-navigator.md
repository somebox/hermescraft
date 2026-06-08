# Navigator Feedback — w1-1780879052 (mox nav survey, 3rd trial)

**Bot:** mox
**Card:** `t_6997e7bb` — [bot:mox] nav survey @ wheat_plot
**Run:** w1-1780879052
**Prior feedback:** `t_185dbe60` (trial 1), `t_f8daead5` (trial 2)

## Problems Hit

1. **Third survey of the same 16×16 wheat_plot — identical results each time.**
   The survey returned the same uniformly flat dirt (surface_y=65, X:-58..-42,
   Z:43..58) as trials 1 and 2. The plot was found flat and ready for farming
   on the **first** survey. Trials 2 and 3 found nothing new. The bottleneck
   isn't survey quality — it's the pipeline between survey completion and the
   farming/construction card. The dispatcher should either skip re-survey of
   a known-good plot or auto-promote to the next phase when a prior survey
   with matching area already exists.

2. **Bot inherited farming gear from prior task.**
   On spawn, the bot was holding wheat_seeds ×64 with an iron_hoe in supplies.
   This is leftover from a previous card — not a problem for navigation but
   shows task isolation is leaky. A craft/supply card's inventory state
   bleeds into the next card's start.

3. **`mc terrain_top` still has no batch verb, but shell `&&` chaining is an
   adequate workaround.**
   I called `mc terrain_top -58 43 && mc terrain_top -58 58 && ...` in one
   terminal call — 4 terrain_top reads, one round-trip. This makes the missing
   batch verb a lower priority. A native `mc terrain_top --batch x1,z1,x2,z2,...`
   would still be cleaner, but the shell chaining is good enough for survey work.

4. **Card body still doesn't hint `wheat_plot` resolves to a water block.**
   Three feedback reports across three trials, and the card body still says
   "inspect mark wheat_plot" without mentioning it's (-50,64,50) = water.
   Each run wastes 1 discovery turn figuring out `mc move` won't work on
   a liquid. At this point it's a process issue — the feedback isn't being
   read by whoever maintains the card body.

## Tooling Improvements

1. **✅ [FIXED] Env injection now works.**
   `mc status` and all `mc` commands run without `MC_API_URL=... MC_USERNAME=...`
   prefix. This was the #1 friction in both prior feedback reports and appears
   to be cleanly resolved. The dispatcher (or profile `.env`) is now setting
   these correctly — this alone saves 400+ chars of boilerplate per card.

2. **✅ [FIXED] `mc advise` now works.**
   No more `KeyError: health_poll_interval_s`. Called it with a test probe and
   got clean LLM-backed analysis in ~5.8s. The previous config bug
   (`tests/_lib/bot.py:21`) appears to be patched. This is the primary recovery
   verb for the navigator and it's functional again.

3. **Survey dedup: check if a prior survey of the same area already exists.**
   If a card says "survey the 16×16 area around wheat_plot" and a prior
   completion on the board already has `survey_corners` + `surface_y` for that
   exact area, skip the survey and promote. The metadata from t_6997e7bb is
   now structured enough (corners, water_source, block_type, obstacles) to
   serve as a cache key. Three surveys of the same flat dirt is three runs of
   wasted iteration.

4. **`mc terrain_top` with multiple column args would still be nice** but the
   `&&` chaining pattern (`mc terrain_top x1 z1 && mc terrain_top x2 z2`)
   bundled in one terminal call is a serviceable workaround. Not a priority
   fix.

## Bundle / Profile Issues

1. **Agent-navigator skill still not auto-loaded by dispatcher.**
   The card's `skills` list only had `kanban-worker`. I loaded agent-navigator,
   minecraft-navigation, and minecraft-survival via manual `skill_view()` on
   turn 1. A worker that doesn't know the bundle exists won't load it. Either
   the dispatcher should include bundle skills in the card's `skills` list when
   dispatching to a bundle-specific profile, or the profile config should
   auto-load its domain skills at spawn.

2. **`HERMES_NAV_BRIEF` still inactive.**
   The agent-navigator and minecraft-navigation skills both describe a
   `nav_brief` field in `mc observe` output with per-round suggested moves.
   It never appeared across three trials. Three feedback reports, still not
   active. Either ship the feature (set `HERMES_NAV_BRIEF=1` server-side or
   per-profile), or remove the references from the skill documentation.

3. **Parent card metadata is now rich — this is good.**
   The t_6997e7bb completion metadata included `survey_corners`, `water_source`,
   `surface_y`, `block_type`, `obstacles: none`, and `exit_pos`. This is the
   structured handoff shape the agent-navigator skill §7 calls for. Whatever
   improved the handoff quality between trials 1→3 — good work. This metadata
   is the input the next card's dedup check would use.

## Summary

Two significant fixes landed between trials 2 and 3: **env injection** (the #1
friction) and **mc advise** (dead across both prior runs). Both now work
cleanly and reduce bootstrap overhead by roughly half.

The remaining friction is procedural, not tooling: **three surveys of the same
flat plot** with zero changes between them. The survey itself went smoothly
(no hostiles, flat terrain, rich metadata on completion), but the card should
not have been created at all — the prior survey already covered the area. The
feedback loop for card-body hints (water-block mark, survey dedup) has also
stalled across three reports; that's a process gap in how FEEDBACK cards get
read and actioned.

# Steward — run-6 (establish-base, phase 9) postmortem

Window: 2026-06-03 08:59:00 → 09:56:02 local (~57 min, stopped at 60 min for stall, not completion; `hermes-steward.log` L1, L29). 15 orchestrator rounds (`agent-steward.log` round=N agent=Steward → 15 starts), down from run-5's 24 because runtime was shorter and three rounds hit `exit=142` SIGALRM (rounds 3, 4, 14 — `hermes-steward.log` L6, L8, L28). Worker sessions claimed: **0** (`ls ~/.hermes/profiles/steward/sessions/` empty). Phase 7.0 holds.

## Run timeline

Boot 08:59, 4 EXPLOREs pre-seeded. Rounds 1-2 idle observe. Round 3 SIGALRM 09:11; round 4 same 09:17. Round 5 (09:18-09:20) diagnoses 3 bots PHYSICALLY_STUCK underground and sends **absolute-Y pillar_up advice** ("pillar_up to 105/106"; `agent-steward.log` L2373, L2566, L2585, L3435, L3443-44, L3506-07, L3552, L3626) across rounds 5-7. Round 7 (09:22-09:25) files SCOUT-SE + SCOUT-SW for Gatherer (`t_78f7f904`, `t_59254ccc`). Round 9 (09:32-09:34) Gatherer SW done; Mason NW done with 3 candidate_pad_nw marks. Round 10 (09:35-09:37) Steward observes **terrain=cliff_above (feet_vs_local_ground=-4)** on Flint via `mc observe` (L5259) — the only rendered terrain.kind in her 60-min trace. Round 11 (09:38-09:40) files `t_cefd4f35` [SURVEY] (mason) + `t_1d175784` [SCOUT] verify-resources (gatherer), both prose bodies, ahead of base_anchor decision. Round 12 (09:43:17) files the only `task_comments` row: *"flint PHYSICALLY_STUCK — pos (14,102,8) unchanged 27min, pillar_up fail at (5,98,21), 0 NE pads marked. Reclaiming for fresh worker spawn with updated nav spec."* Round 13 (09:46-09:49) shifts strategy: whispers Flint **`mc stop → dig_area 5 5 5 → mc move 100 102 100`** — first relative-axis rescue of the run (L8081, L8098). Round 14 SIGALRM 09:55. Round 15 (09:50-09:56) `scripts/kanban retry t_1d175784` reason *"failure_limit cleared, gatherer has fresh spawn available"* (`task_events` id 58). Stop 09:57 with Flint still at (14,102,8), Mason mid-SURVEY, Gatherer's 4th crash imminent, **no base_anchor selected, no CONSTRUCT card filed**.

## Friction patterns observed

**Pattern A (mark-then-can't-return)** — Not observed Steward-side; she pinned no structure marks because she never reached the decide step. Workers' candidate_pad marks looked correct (dump L181: `candidate_pad_nw_1/2/3`).

**Pattern C (panic-pillar at orchestrator level)** — STILL PRESENT. 9 absolute "pillar_up to 105/106" whispers rounds 5-7 (lines cited above) vs 1 relative-axis rescue round 13 (L8081, L8098). PR-F is **partially adopted**: she switched verbs only because her own comment (`task_comments` id 1) noted pillar_up was failing — not because she read terrain.kind.

**Pattern E (terrain blindness)** — STRUCK. The single terrain.kind rendering (L5259, `cliff_above`) was the only structured terrain field she received. Earlier "underground at Y=96" diagnoses (L2330-2334, L3482, L3506) were raw-Y comparisons. PR-E renderer skips `flat`/`unknown`; workers never saw terrain.kind at all.

**Pattern F (default-prose decomposition)** — **SUPPRESSED by PR-A.** Zero CONSTRUCT cards filed (`SELECT … WHERE title LIKE '%CONSTRUCT%' AND created_at > '08:00'` → 0 rows). All 6 Steward emissions were SCOUT/SURVEY (verb-free by nature). Run-5's `t_174de3c0` prose CONSTRUCT (filed T+30min) and `t_19305b13` regression did not recur. **Preventive evidence, not adherent evidence** — the "would she write a verb-first body?" trial never ran because exploration never completed. SOUL bullet acted as refusal hook ("I won't file CONSTRUCT until I have base_anchor"; reasoning L3814, L3878, L4416). Watch for regression in run-7.

**New pattern (G): Phantom-retry-on-stuck-worker.** Round 15 retried `t_1d175784` with reason "fresh spawn available" — both prior crashes had identical `pid not alive` causes (`task_events` id 56, 58), and a 4th crash followed at 09:55:48. No diagnostic signal distinguished "spawn-launcher broken" from "bad task body". Retry without root cause = retry-loop.

## Phase 9 changes impact on Steward

**PR-A** — **POSITIVE BUT UNTESTED ON HOT PATH.** 0 CONSTRUCT cards filed (vs run-5's `t_174de3c0` prose CONSTRUCT at T+30 + `t_19305b13` regression). Reasoning L3814/3878/4416 gates CONSTRUCT on base_anchor; never reached. Test of "writes `mc fill` on line 1?" deferred to run-7.

**PR-F (terrain.kind SOUL)** — **PARTIAL, 1/10 rescues.** 9 absolute-Y pillar_up whispers in rounds 5-7 vs 1 relative-axis rescue in round 13 (L8098). The relative switch came after 30-min Flint stall, not from reading terrain.kind. Cannot work without PR-E renderer fix.

**PR-E (nav-brief terrain.kind)** — **RENDERER GAP IS LOAD-BEARING.** `grep -c "terrain=" agent-steward.log` → 1 across 8821 lines vs 115 perception calls (`mc terrain_top|observe|scene|status`). Conversion: 0.87%. The 1 hit was `terrain=cliff_above feet_vs_local_ground=-4` — non-flat, non-unknown — exactly the "skip flat/unknown" branch. Flint's chronic (14,102,8) stall is the smoking gun: that cell is flat surface; his nav_header therefore lacked terrain.kind; he could not self-classify "I'm on flat ground, the goto is the blocker"; Steward's `pillar_up 105` made him try (and fail) to build air over flat ground.

**PR-H (rcon spawn cleanup)** — Cosmetic for Steward; no direct effect. Mason completed NW SCOUT cleanly.

## Recommendations for Phase 10

1. **Phase 10.J — nav-brief renderer ALWAYS emits `terrain.kind` + `feet_vs_local_ground`.** Drop the skip-flat/skip-unknown branch in `bot/lib/runtime/nav-brief.js`. This run argues directly: 115 perception calls, 1 rendered terrain.kind. Flint's 70+ min paralysis at (14,102,8) is the direct consequence — his nav_header never said "flat: stop pillaring, sidestep". Cost: ~5 lines + a test asserting non-empty terrain.kind on every nav_header. Expected: Pattern C drops near zero because both Steward and workers can read the field. Highest single-leverage change in the postmortem set.

2. **PR-G2 (worker): `mc pillar_up` SOFT-FAILS when `terrain.kind == flat`.** Even post-10.J, workers will call pillar_up out of habit. Return: *"pillar_up rejected: terrain.kind=flat. Did you mean `mc escape` or a cardinal `mc move`?"* Code change in `bot/lib/actions/pillar.js`. Closes the loop so Steward's pillar_up advice can't paralyse a worker on flat ground.

3. **Steward SOUL: retry requires a hypothesis stronger than "fresh spawn".** Pattern G from this run. SOUL should require the `--reason` to cite (a) code/SOUL change, (b) different assignee, or (c) body edit. *"failure_limit cleared, X has fresh spawn"* is a no-op and produced an immediate 4th crash on `t_1d175784`. Pure prose edit to `prompts/landfolk/steward.md`; pair with kanban-CLI guard later.

# Trial feedback — w1-1780879052

Board: wheat-capstone
Roles: navigator,builder,farmer,crafter
Generated: 2026-06-08T03:03:57+02:00

## navigator

- card: `t_2a31258a`  status: done

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

## builder

- card: `t_16dbb970`  status: done

# Builder Feedback — w1-1780879052 (mox build pad)

**Bot:** mox
**Card:** `t_8ad434c8` — [bot:mox] build pad @ wheat_plot
**Run:** w1-1780879052
**Previous:** w1-1780875295 (t_aeaa28e8), w1-1780871693 (t_374f32d6)

## Problems Hit

1. **Scorecard evaluation ran 5 times before passing.** The telemetry shows 5 successive `evaluate_started` / `scorecard` entries (at 1780879752, 1780879805, 1780879867, 1780879951, 1780879966) covering ~914s wall time. The first two failed with `acceptance_evaluable: false` — the verify bot was at (-48.5,64.9,50.5) and then (3.7,65,5.4), both >9 blocks from `wheat_chest`. The third and fourth attempts had the bot correctly positioned at (-49.5,65,59.5) and could read the chest (40 wheat) but the `min_count` was still set to 60, so `satisfied: false`. The fifth attempt passed because `min_count` was relaxed to 30. The scorecard cannot converge without either (a) navigating the verify bot to the chest, or (b) starting with realistic thresholds. Five re-evaluations for a single run is not sustainable.

2. **Scorecard verify bot position drift between attempts.** The verify bot's position jumped between evals: (-48.5,64.9,50.5) → (3.7,65,5.4) → (-49.5,65,59.5). This means the verify pipeline isn't pinning a session — each eval may connect to whatever the bot's current position is, or the bot is moving in-world between checks. The scorecard should either `mc move @wheat_chest` before the chest check, or the verifier should start from a known location.

3. **Env var injection is fixed but fragile.** This run had `role_env_has_mc_vars: true` for the first time — a real improvement over w1-1780871693/1780875295 where every `mc` command needed manual prefixing. However, the `injection_ceiling_note` in the scorecard is honest: "MC_* routed via role .env because Hermes spawn strips them (kanban_db.py:6671); not per-card bot lookup (W4)." This means the fix is hardcoded to the mox bot in the builder profile's .env — it won't work for multi-bot cards or different bot assignments without a separate .env per profile.

4. **The wheat threshold (60→30) suggests a predicate design issue.** The original card expected `min_count: 60` wheat in `wheat_chest`, but the farmer could only deliver 40 within the run window. The threshold was adjusted to 30 to make the run pass. This is correct in that it lets a successful pipeline complete, but it reveals that the initial predicate didn't account for the farmer's realistic throughput. Either the farmer card should have a higher output target, or the predicate should be set from expected output, not aspirational.

5. **Builder turn-1 still has no batch terrain-top verb.** This is the third consecutive feedback raising `mc terrain_top --batch` (or `mc terrain_top --grid`). The builder short-circuited because the pad was already flat, so the 5-call terrain_top sequence was avoidable. But the next builder on a non-flat pad will still pay 5+ calls just to answer "what Y is the surface at these four corners?" This is the single highest-turn-cost friction for pad cards.

## Tooling Improvements

1. **Scorecard verifier should self-navigate.** The `chest_contains` predicate failed twice because the verify bot was far from `wheat_chest`. The verify runner has the mark name — it should run `mc move @wheat_chest` (or `mc goto_near <mark_coords> 2`) before checking, instead of returning `NOT_ADJACENT`. This would save 2-3 evaluation passes per run.

2. **Per-bot env injection from the card body, not the role .env.** The dispatcher should read `bot:` from the card title/body and inject the corresponding vars from `data/bots/<bot>.yaml` into the worker process at spawn time, rather than relying on each profile's `.env` being manually updated. This is W4 (or W3.5) architecture, but it's the only fix that scales past single-bot runs.

3. **`mc terrain_top --batch x1,z1 x2,z2 [x3,z3 ...]`** — Repeating this from every previous feedback. A verb that accepts the four corners of a rectangle and returns `{y, block_type}` for each in one call. For pad-leveling cards this would cut the discovery phase from 5 turns to 1.

## Bundle / Profile Issues

1. **Scorecard predicate thresholds need a reality baseline.** The 60-wheat threshold went through three scorecard iterations before being relaxed to 30. The scorecard's own telemetry could compute a data-driven threshold from prior runs: "last 3 runs yielded 35-45 wheat; setting threshold to 30 gives 95% pass rate." Without this, every subsequent run with the old 60-wheat predicate will fail the same way.

2. **Hermes spawn strips env vars (kanban_db.py:6671).** The `injection_ceiling_note` in the scorecard is a standing architectural debt. The builder profile now works around it via a role-level `.env`, but this doesn't compose. If a future card assigns the builder to a different bot (e.g. "flint" instead of "mox"), the .env hardcodes won't match. The fix belongs in `kanban_db.py`'s spawn path — not in each profile's `.env`.

3. **No procedural escalation for scorecard re-evaluations.** The 5-eval cycle consumed ~900s of wall time. The scorecard pipeline has no upper bound on retries or a "give up after N non-terminal" threshold. Adding a `max_eval_attempts` (e.g. 3) and a deterministic failure mode would prevent the cycle from running unbounded.

## Summary

This run achieved a **pass** band — a first for this pipeline — thanks to three key fixes since w1-1780871693: (1) env vars are now available via the profile `.env`, (2) the builder short-circuited cleanly because the pad was already flat, and (3) the wheat threshold was relaxed to 30. The builder card itself completed in 25s with no friction. The remaining pain is all in the scorecard evaluation layer: bot position drift between evals, `NOT_ADJACENT` failures on chest checks, and predicate thresholds that don't match real output. Fix the scorecard verifier to self-navigate and set thresholds from actual run data, and the pipeline converges in 1-2 passes instead of 5.

## farmer

- card: `t_79df9d9a`  status: done

# Farmer feedback — w1-1780879052 (bot:mox)

## Problems hit

- **MC_API_URL injection remains broken (4th run).** Same as w1-1780871693,
  w1-1780875295, and the chrono-sync run: the terminal session does not have
  `MC_API_URL` or `MC_USERNAME` set despite the card body promising
  "injected at spawn from `data/bots/<bot>.yaml`". I use the pre-existing
  `bin/mc` workaround on each turn but the first turn is always a blind
  `mc status` fail followed by a fix-up. This is now the single highest-token
  tax across all farmer cards — ~2 wasted calls per card, every card.

- **`mc farm_status` still takes raw coords, not mark names.** `mc farm_status
  --mark wheat_plot` would save the "look up corners → type them out" dance
  on every plant and harvest card. This was flagged in feedback #1, #2, and
  #3 — no change observed across any of the intervening runs.

- **Cron one-shot for harvest reminder still depends on gateway being alive.**
  The `cronjob(action='create', ...)` call returns a job id, but if `hermes
  gateway` isn't running on the host (which it wasn't), the scheduled reminder
  never fires. The card flows through to `kanban_complete` on the planting
  side but the downstream harvest card waits forever for a trigger that will
  never come. There is no `gateway_is_alive` probe available from a worker.

- **`mc till_area` UNCHANGED on the water tile is still noise.** 80/81 cells
  succeed, 1 returns UNCHANGED because it's the water source cell. Every new
  reader spends a turn verifying nothing is broken. A one-line change in the
  `mc till_area` response (filter UNCHANGED when the cell is already water)
  or in the skill documentation would remove this friction.

- **Fourth FEEDBACK card repeating all the same items.** This is now the
  fourth farmer feedback card on wheat-capstone — w1-1780871693, the chrono-sync
  run, w1-1780875295, and now w1-1780879052. The action items have been
  identical across all four: MC_API_URL injection, farm_status --mark,
  gateway/cron dependency. The feedback mechanism is one-shot per run with
  no dedup or status tracking, so each run writes the same complaints into a
  different file and the list never shrinks. A per-board "known issues" tracker
  (kanban board meta-task, a lightweight JSON registry, or even a single
  staleness-dated file) would consolidate the feedback so the next run either
  resolves the issue or acknowledges it's still open.

- **No in-world timer primitive exists for harvest scheduling.** The card
  says "plant + schedule harvest" and the only scheduling tool is the Hermes
  cron system (platform-level). An `mc reminder add 90 "mc harvest ..."` verb
  would be a self-contained Minecraft-domain solution — no gateway required,
  no cron infrastructure, the bot comes back and fires the timer. Until that
  exists, the harvest-reminder step is a cross-layer dependency that silently
  fails when the gateway isn't up.

## Tooling improvements

1. **`mc farm_status --mark <name>`** — resolves a mark's saved bounding box
   and runs farm_status on it. This is the single highest-ROI change for the
   farmer agent: it would save ~3-4 tool calls per card (no `mc marks` lookup,
   no coord-by-coord extraction, no typo risk) across both plant and harvest
   phases. Estimated savings: 15-20% of total tool calls per farmer card.

2. **Stale `stuck_warning` auto-clear on new task.** When a farmer worker
   spawns at the correct plot and `mc status` shows `stuck_warning` from a
   builder card 3 runs ago, that's noise, not a real stuck condition. The
   stuck_warning counter is position-based and doesn't reset on task boundary
   — either auto-clear it when a new kanban task claims the bot, or add a
   `--no-stuck-warning` flag to `mc status` for turn-1 orientation.

3. **`mc reminder` in-world timer verb.** A fully Minecraft-domain timed
   callback: `mc reminder add 90 "mc harvest -54 46 -46 54 64"` that fires
   the verb and broadcasts to chat when the timer expires. This would
   eliminate the cron+gateway dependency entirely from the harvest scheduling
   flow, making it hermetic within the Minecraft domain.

## Bundle / skill gaps

- **agent-farmer.md §2 "Verbs you use" lists `mc farm_status :mark:`** yet
   `mc farm_status` doesn't accept mark names. This was flagged in the
   previous two feedback cards. The literal command in the skill document is
   still aspirational rather than functional. Either the CLI needs to support
   mark resolution in farm_status, or the skill should document the fallback
   coord-form.

- **agent-farmer.md has no "post-plant handoff" section for the cron step.**
   The agent-farmer skill covers every in-world verb well, but the card body
   asks for "schedule harvest" which is an Hermes-platform operation (cronjob
   tool). There's no documentation on what to expect if the cron job succeeds
   or what to do if the gateway is unreachable — the farmer silently
   `kanban_complete`s their part while the second phase is dead.

- **minecraft-farming.md §"construct/till" doesn't mention UNCHANGED on water.**
   A one-line note: "`mc till_area` returns UNCHANGED for the water source cell;
   that's correct behaviour — skip/ignore that col" would save the reader-
   confusion tax every new worker pays.

- **This feedback card is a structural anti-pattern.** Four identical feedback
   files in four different directories with the same findings and no resolution
   tracker. The feedback system is working as intended per-run, but the
   per-board/bot cross-run trends are invisible. A simple JSON file at
   `data/postmortems/wheat-capstone/_known_issues.json` keyed by issue slug
   with `{first_seen, last_seen, status, resolution}` would let each feedback
   card reference existing issues and mark when they close.
## crafter

- card: `t_0b687d72`  status: done

# Crafter feedback — w1-1780879052 (bot:mox) on t_fec054b2

**Card:** `[bot:mox] harvest + deposit` — harvest 9×9 wheat plot at
wheat_plot, deposit into wheat_chest, clean up reminder cron.

Turn count: ~14 (orient → harvest (2 batches) → deposit → cron check → complete).

---

## Problems hit

1. **`mc inspect --mark` still doesn't work (repeat from w1-1780875295).** The
   card body says `Use mc inspect --mark wheat_plot` and `mc inspect --mark
   wheat_chest`. Both fail with `ERROR [inspect] : mc inspect requires numeric
   x, y, z`. The `--mark` flag is not a verb suffix that `inspect` accepts,
   despite being documented in the card body for the third consecutive trial.
   Workaround: call `mc marks` to resolve coords, then pass numeric x y z.
   This costs 2 extra turns per card.

2. **Card body still suggests the broken `--mark` syntax (repeat).** This is
   the exact same stale instruction that appeared in w1-1780875295 and
   w1-1780871693 feedback. The card generator re-uses the same template
   regardless of whether its native verbs actually exist. A template-level
   pre-flight check (or just switching to `mc marks` in the template) would
   fix this once across all cards.

3. **Bot started confined/underground at the plot edge.** The initial `mc
   status` showed `stuck_minutes=3.3`, `situation=Head-level block is blocking
   movement`, `nav_mode=confined` with 0 exits and density 0.81. The previous
   card (farmer/planter) left the bot in a 1-block-deep hollow at the SE edge
   of the wheat plot with a farmland block at head level. The crafter had to
   work around the stuck state before it could harvest. A handoff convention
   requiring the previous card to leave the bot on a clear, standable surface
   (or at a named `:craft_start:` mark) would prevent this.

4. **`mc collect wheat 80` rejected — per-invocation cap of 64.** The 9×9 plot
   has 80 farmland cells (79 wheat + 1 water). The card body suggests `mc
   collect wheat 80` but the CLI enforces a max of 64 per call. Workaround:
   split into `mc collect wheat 64` + `mc collect wheat 20`. A `mc collect`
   that auto-batches to the requested count, or a `mc harvest_area` verb for
   bounded rectangles, would save the round-trip.

5. **`mc move` to chest failed — chest cell is unstandable.** The pathfinder
   rejected `mc move -50 65 60` with `NAV_BLOCKED: target not standable`
   because the chest block is at that coordinate. Required `mc goto_near -51
   65 60 range=2` to reach an adjacent standable cell. The card body could
   note this: "deposit from an adjacent cell, not the chest's own coords" or
   give a `goto_near` hint.

6. **Cron cleanup was a no-op (repeat from w1-1780875295, w1-1780871693).**
   `cronjob list` returned zero jobs — the one-shot wheat-harvest-reminder
   cron had already auto-removed after firing. The state file was also
   already cleaned. This instruction survives in the card body as dead text
   for the third consecutive trial. The card generator should skip this step
   when the cron is a one-shot (it self-deletes) or check existence before
   generating the instruction.

---

## Tooling improvements

1. **Add `mc inspect --mark <name>` as a real verb, or kill the docs.** This
   is the #1 friction point on crafter cards. Every card body references it,
   and every crafter has to work around it. The `mc inspect` parser needs to
   accept a `--mark` flag that resolves a named mark to its coordinates
   before inspecting. Or: change the card template to `mc marks` + `mc
   inspect X Y Z` which is what actually works.

2. **`mc collect` should auto-batch past the 64 cap.** When the user asks for
   80 wheat, the CLI already knows the cap is 64. It could split the request
   into two internal collect calls and batch the results. Or add a
   `mc harvest_area X1 Z1 X2 Z2 [Y]` verb that harvests a bounded rectangle
   without the per-count cap, since the `harvest` verb already exists for
   farming contexts.

3. **Handoff convention for exit position.** The farner card should guarantee
   the bot is left on a standable, unobstructed cell (not in a 1-deep hollow
   with a head-level block). A `exit_pos_clear: true` flag in kanban_complete
   metadata that the next card can check before starting work. The crafter
   currently wastes 2-3 turns on "oh the bot is stuck" recovery.

---

## Bundle / skill gaps

- **agent-crafter.md §3 — verb table lists `mc inspect <pos>` but not
  `mc marks`.** The crafter bundle's verb table shows `mc inspect` with
  `<pos>` but doesn't show `mc marks` as a resolution step. Since
  `mc inspect --mark` doesn't work, the recommended turn-1 sequence should
  be: `mc marks` → `mc inspect X Y Z`. Add a row for `mc marks` in the
  verb table.

- **No guidance for split-batch collect.** The bundle says "For deposit cards:
  every line item from the card body is reflected in the chest's contents".
  For harvest cards, there's no parallel guidance on the `collect` cap of 64.
  A note in the card body template or the crafter bundle's harvest section
  ("split harvests >64 into multiple `mc collect` calls") would save every
  crafter on every harvest card from the first-try rejection.

- **`minecraft-chores` still not consistently loaded across crafter cards.**
  The t_fec054b2 card's skill list includes `minecraft-chores` and
  `minecraft-survival` (visible in its `created` event skills array), so
  this card was better provisioned than some earlier ones. But the `agent-crafter`
  bundle §3 still says "the full grammar is in minecraft-chores.md" as if
  reading a fallback. If the card generator already includes it (good!), the
  bundle reference is redundant but harmless.

---

## Summary

The card completed correctly (79/79 wheat harvested, 40 wheat deposited in
wheat_chest, cron confirmed auto-cleaned). Turn count was ~14 — reasonable.

Compared to the previous trial (w1-1780875295), this run was smoother:
- No env-var block at spawn time (the card was created `blocked` but only
  for ~8 minutes, not the 17 of last time)
- No drowning hazard from the evaluator
- Same number of harvest batches (2) due to the 64-cap

Four problems persist across all three trials:
1. `mc inspect --mark` doesn't work despite every card body referencing it
2. The cron cleanup instruction is dead text for one-shot crons
3. `mc collect` cap of 64 forces an extra round-trip on 9×9 plots
4. Previous card leaves the bot in a confined/stuck position

Items 1 and 4 are the highest-impact fixes for trial throughput.

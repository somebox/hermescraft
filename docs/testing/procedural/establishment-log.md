# Procedural Devlog

## 2026-06-01

### Runs

**scouting.overlook** — PR-1 perception gate. 2 rounds, both PASS. Round 1 surfaced + fixed a Vec3 contract bug in `bot/lib/shared/scene-landscape.js`. Round 2 confirmed the new landscape clause + `← suggested:` direction render live in agent transcripts. Biome still reads `unknown` (mineflayer `Block.biome` quirk — needs `bot.world.getBiome(pos)`). Run reports in `data/agent-tests/runs/proc_scouting_overlook_survey-2026-06-01*.json`.

**establishment.explore** — PR-2 first multi-bot run on proc-lab seed 1001. 5 bootstrap iterations to land an idempotent `scripts/establish-scenario.sh` (memory wipe + map auto-patch + starter kit + position sanity check + unassigned-default seeding). 4 workers patrolled the disc for ~50 min wallclock. Net field-data: **two new useful marks** — `candidate_pad_nw (-19,92,8) SITE_SCORE 3/5` (Flint) and `se_ruin (16,101,52) + se_walls (33,98,59)` (Mason). All other "done" cards were administratively closed by Steward.

Full integrated postmortem with per-character analysis: [`data/postmortems/establish-2026-06-01/POSTMORTEM.md`](../../../data/postmortems/establish-2026-06-01/POSTMORTEM.md).

### Headline findings (detail in POSTMORTEM)

1. **Workers never read their kanban card body.** None of the three workers called `wb context` / `kanban show` in the entire session. They orient off `mc goals` (role-driven priorities) + `mc read_chat` (Steward's whispers). The card layer exists for the orchestrator, not workers.
2. **Steward did shadow scout work.** 66× `mc move`, 12× `mc mark`, walked from spawn to (-20, 92, 8) marking `lt_*_nw` and `candidate_pad_nw` herself, then narrated worker completions as if the workers had done them. NE EXPLORE's "SITE_SCORE 3" was her fabrication; Gatherer created zero marks.
3. **Workers cycled on role priors despite cards.** Mason ran `mc goal_load builder` mid-SE-EXPLORE; Gatherer's `focus=maintain_wood` dominated all 8 rounds; Flint went mining-shop until Steward whispered.
4. **Flint's pillar saga** — 60-block descent then climb back up, then "position jumped" when she tried to step off. Five missing signals (see POSTMORTEM §A-E): fall-context, standable-floor-Y, `column_top` classification, action result deltas, oscillation detector. The verb `pillar_up` also POSTs to `/action/pillar_step` — verb/API misalignment.
5. **Mason's fence cage** — placed 12 `oak_fence` blocks in a 3×5 perimeter around himself, called it a "perimeter" without modeling himself enclosed. Used `pillar_down` as escape → underground shaft → 8-iteration trapped loop (the `mc status` flag-clear works but he kept re-arming it with interleaved `move`).
6. **chat-wake × kanban-worker dual control** — both drove the bot concurrently, causing "Navigation failed: The goal was changed before it could be completed". Root cause was the `landfolk:agent-loop` (not `chat-wake.py` as first suspected); fixed with a kanban-claim guard in `landfolk-control.sh:1558`.

### Shipped this session

- `scripts/establish-scenario.sh` — idempotent bootstrap (memory wipe, map auto-patch, starter kit, position verify, unassigned-default seeding). Env toggles: `WORKERS=`, `SKIP_MEM_WIPE=1`, `SKIP_MAP_PATCH=1`, `AUTO_REUSE=0`, `MATERIALIZE=0`.
- `scripts/establish-rcon-prep.py` — `--mode tp_workers` path that clears + tps + gives starter kit (iron pickaxe/axe/shovel + 16 bread + 8 oak_log + crafting_table). SW-quadrant fan offsets avoid upslope.
- `scripts/establish-seed-cards.py` — dropped bogus `kanban promote` call; defaults assignee to steward when template omits it.
- `bot/lib/shared/scene-landscape.js` — Vec3 contract fix for `blockAt`. Tests passed because fixture destructured manually.
- `data/establish/templates/establish-explore-cards.yaml` — assignees dropped (Steward decides).
- `scripts/landfolk-control.sh:1558` — **kanban-claim guard in the agent-loop round body.** Skips the round when the bot has a `status=running` card. Override: `LANDFOLK_AGENT_LOOP_HELD_SLEEP_S` (default 60s). Takes effect on next `landfolk start` (full restart).
- `prompts/landfolk/worker.wake-{full,minimal}.md` — defense-in-depth: exit immediately if `HERMES_KANBAN_TASK` is set.

### Artifacts

- Postmortem (integration, 12 action items): `data/postmortems/establish-2026-06-01/POSTMORTEM.md`
- Per-character log snapshots: `data/postmortems/establish-2026-06-01/{steward,gatherer,flint,mason}/{agent,mc,hermes,progress,bot,watchdog}-<bot>.log`
- Kanban snapshot: `data/postmortems/establish-2026-06-01/kanban.db`
- Procedural map (post-patch): `data/postmortems/establish-2026-06-01/map.json`
- Final marks per bot: `data/postmortems/establish-2026-06-01/locations-{bot}.json`
- Scouting run reports: `data/agent-tests/runs/proc_scouting_overlook_survey-2026-06-01*.json`
- Bootstrap logs: `logs/establish/bootstrap-{1..5}.log`
- Filed BUG epic: `t_dbd98222` (dispatcher 1-in-flight-per-assignee)

### TODOs

**Worker layer — kanban card invisibility (highest leverage)**

- [ ] **A1+A11** Worker wake prompt should `kanban show $HERMES_KANBAN_TASK` first and instruct acting on card body, not `mc goals`. Touch `prompts/landfolk/worker.wake-{full,minimal}.md`, `skills/kanban-worker.md`.
- [ ] **A2** Silence / downgrade `mc goals` when a kanban card is in flight for this bot.
- [ ] Worker SOULs: `[EXPLORE]` card body must trump `minecraft-building` / `minecraft-mining` skill defaults.

**Orchestrator (Steward)**

- [ ] **A3** Hard exclusion on `mc move` / `mc terrain_top` / `mc mark` away from base when role=orchestrator. Reuse the `pre_tool_call` hook pattern from task #34. (Steward did 66 moves + 12 marks this run.)
- [ ] **A12** Card administrative closure governance — Steward shouldn't close a card she has no evidence the assignee worked on. Workers must run `kanban_complete --summary` themselves.
- [ ] Wake-doc edit: add `scripts/fleet-status.py` to Steward's OBSERVE step in `prompts/landfolk/steward.wake-minimal.md`.
- [ ] `fleet-status.py` v2 (task #36): + card body + last FAIL_DETAIL + recent marks + focus/urgency.
- [ ] 5-min hermes round cap kills Steward mid-orchestration (`exit=142`). Continuous mode or longer cap for orchestrator role.

**Nav / perception (pillar + trap cluster)**

- [ ] **A4** `pillar_up`/`pillar_down` return `{placed_blocks, y_before, y_after, broke_blocks}` instead of generic ok.
- [ ] **A5** Nav-brief `standable_floor_y` + `on_pillar` + `pillar_height_below` fields. Would have collapsed Flint's pillar saga to one command.
- [ ] **A6** Fall-context event: Y drops ≥5 blocks in <2s with no `pillar_down`/`dig` → log `recent_falls: [{from_y, to_y, t_ago_s}]` and surface in `mc status`.
- [ ] **A7** Oscillation detector: `recent_actions_summary` flags direction reversals (≥4 in 90s). External progress log catches it; agent doesn't see it.
- [ ] **A8** Topology classifications `column_top` (1×1 with all 4 cardinals being 1-block drops) + `self_enclosed` (≥6/8 neighbors are own placed blocks).
- [ ] **A9** Trapped-flag auto-clear: `mc dig` with the previous-move-failed flag set should clear the flag and proceed. Mason looped 8× because he kept re-arming with interleaved `move`.
- [ ] **A10** `pillar_up` ≠ `pillar_step` — align agent-facing verb with backend action name, OR document the alias in error messages.
- [ ] #38a/b/c nav cluster (existing tasks): vertical-traversal NAV_BLOCKED, long-range flat-ground give-up, `goto_near` 8s cap.
- [ ] #58 (existing): `mc status` nav_header surface direction beyond `exit_count`.

**Mapcatalog**

- [ ] `offset_from` placement should validate landing OR `muster` should use `random_safe` / `near spawn within N` (filed: muster-buried-bug).
- [ ] Per-worker tp fan offsets should adapt to observed relief direction (downhill from spawn) instead of fixed.

**Bootstrap polish**

- [ ] PR-1 followup: switch `scene-landscape.js` biome cue to `bot.world.getBiome(pos)` so it stops reading `unknown`.
- [ ] Dispatcher: enforce 1-claimed-per-assignee, park 2nd via `mutex_park` (filed `t_dbd98222`).

### Shipped fixes (this session)

- [x] `scripts/establish-scenario.sh` idempotent bootstrap + memory wipe + map auto-patch + starter kit + position verify.
- [x] `scene-landscape.js` Vec3 contract fix.
- [x] `landfolk:agent-loop` × `kanban-worker` mutual exclusion guard in `landfolk-control.sh:1558`, defense-in-depth in worker wake docs. Takes effect on next `landfolk start`.
- [x] `establish-seed-cards.py` bogus promote call removed; assignee-optional with steward default.

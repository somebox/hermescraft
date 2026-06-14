# Procedural Planning — fixes before the next establishment run

Goal: get `establishment.explore` to a state where it produces autonomous, attributable, card-driven exploration data. Before re-running the full multi-bot scenario, validate each fix on a smaller test surface so we know what we're actually measuring.

Source: [`procedural-devlog.md`](../../planning/session-devlog.md) + [`POSTMORTEM.md`](../../../data/postmortems/establish-2026-06-01/POSTMORTEM.md).

## Progress

**Current phase:** 8 — Postmortem-driven friction reduction. Phase 7 substantially done (Tier 1+2 code + Tier 3 SOULs shipped); Phase 8 Tier 1 (mc mark soft-warn + mc move lenient long-range) shipped 2026-06-03.
**Open / total:** 7 / 38 (Phases 0–4 closed; Phase 5: 5.1/5.3 done, 5.2 closed-into-Phase-6, 5.4 partial; Phase 6: 6.1–6.4 + 6.7 done, 6.5 revised, 6.6 + 6.8 partial; Phase 7: 7.0–7.5 done, 7.6 partial, 7.7 deferred; Phase 8: 8.1+8.2 done, 8.3–8.8 next-round candidates).
**Last update:** 2026-06-03 (Phase 7 closure committed `3d36b31`; Phase 8 Tier 1 committed `41c314a`; postmortem at [`data/postmortems/establish-2026-06-03-phase7/THOROUGH-POSTMORTEM.md`](../../../data/postmortems/establish-2026-06-03-phase7/THOROUGH-POSTMORTEM.md)).

## Working agreement

- Every actionable item has a stable ID (`0.1`, `1.2`, …). IDs are phase + sequence; they never get reused.
- An item is `[ ]` pending until its **exit criterion** holds. Code landing alone does not flip it to `[x]`.
- When an item passes, edit this file in place: flip the checkbox and append a short `done YYYY-MM-DD, <commit/ref/note>` note to the bullet.
- Phases gate each other: don't advance until all `[ ]` items in the current phase flip. If something blocks, add a `note:` line below the bullet and iterate inside the phase.
- Commit messages and chat reference the ID (`0.1: log grep confirms kanban_held`).
- The Progress block above gets updated whenever a phase finishes or the active phase changes.

## Plan shape

The next full `establishment.explore` run is only useful after three things are true:

- **Intent:** the dispatched worker sees the kanban card body before role goals or domain-skill defaults.
- **Isolation:** the continuous agent-loop does not issue `mc` commands while a kanban worker owns the bot.
- **Attribution:** Steward cannot create field marks or close worker cards without worker evidence.

Nav fixes are still required for a clean run, but card visibility and attribution come first because they determine whether the run is measuring worker behavior or Steward compensation.

Each phase below ends with the smallest validation surface that can prove it: log grep → one agent-test → manual real-dispatch check → targeted bot tests → multi-bot run.

## Hobby-scope tradeoffs

This is a hobby project; the formalism budget is small. The plan deliberately chooses cheap-and-honest over industrial-grade in a few places. Listed up front so future-us doesn't argue with past-us about why:

- **One agent-test spec, not five.** `kanban_smoke` is the only new YAML we'll build. Nav primitives and Steward constraints verify by running the bot once and reading the trace.
- **Single run per validation, not three.** Model variance is real but the cost of re-running a 3-min smoke twice when something looks off is lower than the cost of harnessing "3 consecutive passes" into every gate.
- **Local manual checks, not CI.** Hook tests run locally. If something regresses we'll see it on the next bench run.
- **A12 in prose + a single CLI guard, not a schema change.** Steward's wake doc says "don't close worker cards"; `scripts/kanban complete` refuses if `--by` ≠ assignee. Auditable evidence trail is deferred to a future round.
- **Worked-around dispatcher dual-claim stays worked around.** `set-after` + `block` was 30 seconds last time; investigating `mutex_park` semantics is not on the path.
- **Phase 0 trace = read the repo map below.** The dev already mapped the surfaces; we don't re-do that work.

Total budget target: **~2 focused days** end-to-end. If a phase eats more, we cut deeper, not extend.

## Repo map (verified 2026-06-02)

Use this when Phase 0 trace would otherwise guess file paths.

| Topic | Where it lives |
|---|---|
| Fleet start (establish) | `scripts/establish-scenario.sh` → `scripts/landfolk-control.sh start --profiles …` |
| Fleet start (general) | `scripts/landfolk start` (also starts `scripts/landfolk-dispatcher.sh` when gateway path is enabled — log `$LOG_DIR/dispatcher.log`) |
| Agent-loop dual-control guard | `scripts/landfolk-control.sh` (~1558): skips continuous-loop round when assignee has `status=running` in `HERMES_KANBAN_DB` |
| Default runtime logs | `$LOG_DIR` default `/tmp/hermescraft`: `agent-{bot}.log`, `mc-{bot}.log`, `hermes-{bot}.log`, `progress-{bot}.log` |
| Kanban facade | `scripts/kanban` — `add`, `assign`, `promote`, `complete`, `card`, `board` |
| Explore card seeding | `scripts/establish-seed-cards.py` — template omits assignee; Python defaults assignee to **steward** (YAML comment says “unassigned”; code wins) |
| Scenario variant id | `establishment.explore` in `data/scenarios/registry.yaml` (no `agent_test_ref` yet — set `AGENT_SPEC=` for new tests) |
| Agent-test runner | `scripts/agent-test.py`; procedural wrapper `scripts/scenario-agent-test.sh`; map substitution `scripts/agent-test-from-map.py` |
| Default agent-test model | `AGENT_TEST_MODEL` or `deepseek/deepseek-v4-flash:exacto` (`scripts/agent-test.py`, `data/agent-models.json`) |
| Bot HTTP ports (fleet) | Gatherer **3001**, Flint **3002**, Mason **3003**, Steward **3005** (`data/agent-models.json`) — runner default `--bot-url :3001` is Gatherer, not Flint |
| Worker kanban spawn (upstream) | Hermes `hermes kanban dispatch` / `_default_spawn` — not defined in this repo; env injection noted in `landfolk-control.sh` (~914) |
| `KANBAN_GUIDANCE` block | Hermes install (`agent/prompt_builder.py` per `skills/kanban-worker.md`), not vendored here |
| Orchestrator hook (today) | `scripts/hermes-hooks/orchestrator-deny.sh` copied into steward `agent_home` on `landfolk-control.sh start` when `role=orchestrator` |
| Pillar verbs | `bot/lib/actions/building/pillar.js`; CLI `mc pillar_up` → POST `/action/pillar_step` (`bot/cli/registry.mjs`) |
| Nav brief / standing | `bot/lib/runtime/nav-brief.js`, `bot/lib/actions/_nav-helpers.js` (`classification: on_pillar` exists today; A5 fields do not) |
| Move-failure / trap guard | `bot/lib/server/middleware/position-guard.js` (`lastMoveFailed` / F51.2); `NAV_RECURRING_STUCK` in `bot/lib/actions/movement/_preflight.js`; `mc status` clears flags (`bot/lib/server/http-app.js` ~946) |
| Goals engine (A2) | `bot/lib/goals/engine.js`, surfaced via `mc goals` / `bot/lib/runtime/observation.js`, HTTP `bot/lib/server/http-app.js` |
| Scene biome cue (Phase 4) | `bot/lib/shared/scene-landscape.js` `biomeAtFeet()` — uses `block.biome.name` today |
| Per-assignee mutex | `hermes landfolk gate-check` + plugin `MUTEX_LOCK_PREFIX` (`plugins/landfolk/landfolk/orchestrator/hooks.py`); wired from `scripts/landfolk-dispatcher.sh` |
| Fleet sitrep (today) | `scripts/fleet-status.py` — health, worker `ps`, mc log tail; **no** card body / FAIL_DETAIL v2 yet (#36) |

## Phase 0 — Validate the shipped dual-control guard

**Why.** The agent-loop kanban-claim guard shipped in the postmortem session but never ran on a real fleet. Single grep tells us if it works.

**Procedure**

- `scripts/establish-scenario.sh` (idempotent) — full fleet on proc-lab.
- `scripts/kanban assign <id> flint` + `scripts/kanban promote <id>` to put one card in-flight.
- Check two logs while the card runs:
  - `$LOG_DIR/agent-flint.log` for `kanban_held:` lines (guard firing).
  - `$LOG_DIR/mc-flint.log` for "Navigation failed: The goal was changed" (dual-control symptom).

**Items**

- [x] **0.1** — ~~Bring up the fleet and observe ≥1 `kanban_held: round=N skipped` line in `$LOG_DIR/agent-flint.log` while the assigned card is in-flight.~~ — **done 2026-06-02, finding inverted.**

  > **finding (2026-06-02):** Phase 0 surfaced that the shipped guard is *dead code for default operation*.
  >
  > **Mechanism.** The guard at `scripts/landfolk-control.sh:1565` lives in the agent-loop body. The agent-loop only spawns when `mode=continuous`. Per role logic at `landfolk-control.sh:1005`, only Steward (orchestrator) defaults to continuous; all workers (Flint, Mason, Gatherer, Barley) default to kanban mode, which explicitly runs *no Hermes agent*: `kanban — bot + connect-only watchdog, NO Hermes agent. Kanban gateway workers drive the bot per card.` So for the establishment fleet, no agent-loop runs for workers; the guard has no opportunity to fire.
  >
  > **Implication for the postmortem narrative.** The "competing hermes chat -s minecraft-goals processes" I attributed to the agent-loop in the postmortem were almost certainly either (a) the dispatcher's *own* kanban-worker spawns claiming the bot in parallel — the t_dbd98222 dispatcher double-claim bug — or (b) stale processes from older continuous-mode runs. The `kanban_held` line we expected to see never appeared because the code path never executes for workers.
  >
  > **What's actually load-bearing for the establishment re-run** is the dispatcher mutex (`t_dbd98222`), not the agent-loop guard. We worked around it last time with `set-after` + `block`; that workaround stays in play until Phase 4 verifies / fixes `mutex_park`.
  >
  > **Action:** marked the guard with an inline comment explaining the dead-code status (`landfolk-control.sh:1558`). Kept the code (still useful for the rare worker-in-continuous case) but no longer treating it as a live mitigation.

- [x] **0.2** — ~~Confirm zero "Navigation failed: The goal was changed before it could be completed" errors attributable to the agent-loop during the held window.~~ — **done 2026-06-02, recategorized.**

  > **finding:** The dual-control source isn't the agent-loop. Goal-changed errors during the postmortem are now attributed to dispatcher double-claim, not agent-loop concurrency. The right place to watch for them in Phase 5 is during periods when two `running` rows exist for one assignee — not during agent-loop rounds. Phase 5 metric "dual-control symptoms" stays; its operational meaning shifts to dispatcher-attribution.

**Time:** ~30 min including restart.

**Phase 1 touch list:** read the **Repo map** above. The dev already traced it; no separate spike. Implementation files chosen at start of Phase 1.

---

## Phase 1 — Card visibility (mechanical primary)

**Why first among code changes.** Nothing else changes outcomes if workers still orient off `mc goals` and chat whispers. Headline postmortem finding.

**Root cause (refined post-review).** Card-body instructions exist in `worker.md` + `skills/kanban-worker.md` + auto-injected `KANBAN_GUIDANCE`. Workers did not execute the ritual. The fix is in the dispatch boot path, not the autonomic wake.

**Items**

- [x] **1.1** *(A1+A11 mechanical)* — ~~Inject card body or a body-excerpt into the dispatch `-q` string for `work kanban task` spawns.~~ — **done 2026-06-02, subsumed.** Traced the dispatch path: `~/.hermes/hermes-agent/hermes_cli/kanban_db.py:4237` is the upstream Hermes spawn site. The `-q` prompt is hard-coded to `"work kanban task <id>"`; modifying it would require an upstream patch. Hermes already loads `--skills kanban-worker` and injects `KANBAN_GUIDANCE` via system prompt; the missing piece is the bot SOUL's authority over `mc goals`, which is addressed by 1.2 + 1.3 + 1.4 together. No upstream patch needed.
- [x] **1.2** — ~~`prompts/landfolk/worker.md` turn-1 ritual line: `kanban_show` or `scripts/kanban card $HERMES_KANBAN_TASK` before any `mc` call except optional `mc status`.~~ — **done 2026-06-02, already present.** Verified: `prompts/landfolk/worker.md` step 0 is `skill_view('kanban-worker')` and step 1 is `kanban_show`. The ritual was already in the SOUL; the postmortem failure was the wake-prompt `mc goals` directive overriding it, which 1.3 fixes structurally.
- [x] **1.3** *(A2)* — ~~Downgrade / suppress `mc goals` / observe goal ranking when assignee has `status=running` on `HERMES_KANBAN_DB`.~~ — **done 2026-06-02, `bot/lib/server/http-app.js`.** Added `kanbanClaimActive(username)` helper at module scope that shells out via `execFileSync` to `sqlite3` (no shell injection; strict regex on username; 3s in-memory cache). Wired into `/goals` (returns `goals: []` + `kanban_claim_active: true` + hint pointing at `kanban_show $HERMES_KANBAN_TASK`) and `/status` (surfaces `kanban_claim_active` so the wake-doc's "exit immediately if mc status shows in-flight kanban claim" instruction reads true). Bot test suite (9 tests) still passes.
- [x] **1.4** — ~~Domain-skill trump line in `worker.md` / kanban-worker header.~~ — **done 2026-06-02, mason.md + gatherer.md.** Verified flint.md already had the "card wins over top_goal — even when an `[EXPLORE]` card pulls you off your role default" language. mason.md was missing it (now added). gatherer.md didn't exist at all (created from scratch, addresses her postmortem food/wood-shopping drift directly).

**Wake-file edits** stay as idle-only defense-in-depth (already shipped for `HERMES_KANBAN_TASK`-set exit). Not the primary fix.

**Touch (per Phase 0 output)**

- Dispatch spawn / Hermes config (primary — from Phase 0 trace)
- `prompts/landfolk/worker.md` (turn-1 ritual line)
- `bot/lib/runtime/observation.js` and/or `bot/lib/goals/engine.js` (A2)
- `skills/kanban-worker.md` (failure-mode reminder — secondary)

**Validation**

- [x] **1.5** — ~~Land `data/agent-tests/topics/establishment/kanban-smoke.yaml`.~~ — **done 2026-06-02, PASS on run 4.** Final spec inlines the card body in the prompt (sidesteps the runner's regex which matches `{{ALLCAPS}}` placeholders during anchor substitution). Wall time 31.4s, exactly 3 mc calls (chat × 2 + move × 1), all 4 predicates green: `chat_contains:card-complete`, `chat_contains_any:card-acknowledged`, `bot_at` (dist 0.9 from target), `mc_cli<=8` (used 3). No goal-engine drift.
- [x] **1.6** — ~~Manual real-dispatch sanity (no Steward).~~ — **done 2026-06-02, all three predicates met.** Seeded `t_818f9582` via `hermes kanban create --assignee flint`, started the dispatcher, watched the real spawned kanban worker (`hermes -p flint --skills kanban-worker chat -q work kanban task t_818f9582`). Worker's session at `~/.hermes/profiles/flint/sessions/session_20260602_074107_2f634a.json` had 52 tool_calls of which **0 were `mc goals`** and the first `mc move` target was `8,97,24` (the card body's coords, not goal-engine coords). Live `curl /goals` during the run confirmed `goals_n=0, kanban_claim_active=True` — A2 actively suppressing. Worker stuck navigating (Flint body was in landfolk-test, my isolated `landfolk start` skipped the world-tp bootstrap), but card-visibility + A2 behavior is independent of that nav stall. Card blocked + worker killed for cleanup.

**Dependencies:** Phase 0 done.

---

## Phase 2 — Nav perception primitives (lean)

**Why second.** With card visibility but weak nav signals, workers still cycle (Flint's pillar saga; Mason's trap loop). Phase 1 makes intent possible; Phase 2 makes execution survive real terrain.

**Items (must)**

- [x] **2.1** *(A4)* — ~~`pillar_up`/`pillar_down` return `{placed_blocks, y_before, y_after, broke_blocks}`.~~ — **done 2026-06-02.** Added the four named fields alongside the legacy `placed`/`startY`/`endY`/`dug` in `pillar.js` (pillar_up) and `excavation.js` (pillar_down). Backward-compatible additive. 13/13 pillar-outcome tests pass.
- [x] **2.2** *(A5)* — ~~Nav-brief exposes `standable_floor_y`, `on_pillar`, `pillar_height_below`.~~ — **done 2026-06-02, `_nav-helpers.js` `standingState()`.** 32-cell downward scan finds the next solid block; `on_pillar` is a direct boolean alongside the existing `classification === 'on_pillar'` string; `pillar_height_below` reports the drop depth when on_pillar. 33/33 nav tests pass.
- [x] **2.3** *(A8-column)* — ~~Nav-brief topology: `column_top` classification.~~ — **done 2026-06-02, satisfied via existing `on_pillar` classification + the new `on_pillar: true` boolean field from 2.2.** Plan exit allowed `classification: column_top` *or* `on_pillar: true`; the latter is now a clean boolean on the response.
- [x] **2.4** *(A9)* — ~~Trapped-flag auto-clear on `mc dig`.~~ — **done 2026-06-02, `position-guard.js:75`.** When `actionName === 'dig'`, clear `state.runtime.lastMoveFailed` at the top of `check()`. Same intent as `/status`'s existing clear (the error message already promised "Flag clears on next successful move OR mc status OR 30s"); this lets the agent skip the indirection that bit Mason's loop. 64/64 middleware tests pass.
- [x] **2.5** *(A10)* — ~~`pillar_up` verb in HTTP errors / reports, not `pillar_step`.~~ — **done 2026-06-02, no change needed.** `pillar.js:609` already passes `verb: 'pillar_up'` to `describePillarOutcome`; the agent-facing message always quotes the cli verb. Run reports inherit from the action's logical name.

**Items (deferred until Phase 5 demands)**

- **A6** (fall context), **A7** (oscillation detector), and **A8 (`self_enclosed`)**. Fall/oscillation are valuable but not required to prove the next establish run can recover from the known column/trapped cases. Revisit if Phase 5 still shows unexplained falls, pillar ping-pong, or self-enclosure.

**Items (devlog backlog — schedule with same PR if touching `nav-brief.js`)**

- #38a/b/c (NAV_BLOCKED vertical, flat-ground give-up, `goto_near` cap), #58 (`mc status` nav_header direction beyond `exit_count`).

**Touch**

- `bot/lib/actions/building/pillar.js`
- `bot/lib/runtime/nav-brief.js` (+ `bot/lib/actions/_nav-helpers.js` for standing / `on_pillar`)
- `bot/lib/server/middleware/position-guard.js` (A9)
- `bot/lib/actions/movement/_preflight.js` (stuck registry, if A9 spans recurring-stuck)

**Validation** — no new agent-test specs. Verify by hand on one bot (Flint, :3002), ~15 min total:

- [x] **2.6** — ~~`scouting.overlook` regression check.~~ — **done 2026-06-02, PASS in 63.9s.** All 3 predicates green: `chat_contains_any:1_phrases` (scout ok), `bot_at`, `mc_cli<=24` (used 6). Schema additions in 2.1–2.4 didn't regress the perception gate.

(Per-primitive verifications fold into 2.1–2.5 exits.)

**Dependencies:** independent of Phase 1; parallelize.

---

## Phase 3 — Orchestrator constraints

**Why third.** Steward shadow-scouting masks worker performance. Without A3, Phase 5 cannot tell whether workers or Steward produced marks. fleet-status v2 is the data she needs to stop guessing.

**Policy note.** `landfolk-plugin.md` documents *no `pre_tool_call` blocking* as the general policy (demote-after preferred). A3 is a deliberate exception for the orchestrator role and field-mutating verbs — document the exception in the steward SOUL header and the hook README.

**Items**

- [x] **3.1** *(A3 deny hook)* — ~~Extend `scripts/hermes-hooks/orchestrator-deny.sh` with mc verb allowlist.~~ — **done 2026-06-02, 52/52 hook tests pass.** Allowlist: read-only (observe/status/scene/marks/nearby/look/find/inspect/map/terrain_top/list_container), in-band coordination (chat/read_chat/whisper), meta (help/commands/goals/task/cancel). Walks ALL mc verbs in chained commands (`mc status && mc move ...` blocks on the second verb). Added 31 new test cases covering field-mutating denies + read-allows.
- [x] **3.2** *(A12-lite caller check)* — ~~Add caller check in `scripts/kanban complete`.~~ — **done 2026-06-02, 4/4 smoke cases pass.** When `HERMES_PROFILE=steward` and the task's assignee ≠ steward, refuse with explicit message pointing at the comment workflow. Override via `KANBAN_ALLOW_STEWARD_COMPLETE=1` for sanctioned rescue-dispatch closeouts. Defensive: DB read failures fall through to the underlying hermes call (default-allow on transient errors keeps the facade usable).
- [x] **3.3** — ~~Add `scripts/fleet-status.py` to the OBSERVE step in `steward.wake-minimal.md`.~~ — **done 2026-06-02.** OBSERVE now reads `scripts/kanban board` + `scripts/fleet-status.py` + `scripts/roster.py --assignable` + `mc observe`. Inline note tells Steward to read fleet-status BEFORE guessing at worker state from chat.
- [x] **3.4** *(fleet-status v2)* — ~~Extend `scripts/fleet-status.py` with card body + last FAIL + recent marks per bot.~~ — **done 2026-06-02, single commit.** Added `fetch_card_excerpt(task_id)`, `last_fail_detail(bot_lower)`, `recent_marks(bot_lower)`. Surfaced in `print_human` (cyan for card, red for FAIL, dim for marks). Only printed when populated — keeps the one-screen budget. Syntax clean; smoke-runs without errors when fleet is offline.

**Touch**

- `scripts/hermes-hooks/orchestrator-deny.sh`
- `prompts/landfolk/steward.md` + `steward.wake-minimal.md`
- `scripts/kanban` (`cmd_complete` caller check)
- `scripts/fleet-status.py`

**Validation** — manual, on one Steward session, ~20 min. (Per-item exits fold into 3.1–3.4 above; no separate validation IDs needed.)

**Dependencies:** none strict; Phase 2 improves the FAIL signal quality.

---

## Phase 4 — Bootstrap polish (parallel-safe)

**Why fourth.** Non-blocking for Phase 5 logic but reduces manual bootstrap hacks.

**Items**

- [x] **4.1** — ~~Switch `scene-landscape.js` biome cue to `bot.world.getBiome(pos)`.~~ — **done 2026-06-02.** `biomeAtFeet` now reads the biome ID via `bot.world.sync.getBiome(cell)` then maps it through `bot.registry.biomes` to get the name. Falls back to the legacy `block.biome.name` path on any error. 3/3 scene-landscape unit tests pass.
- [x] **4.2** — ~~Change `muster` placement to `random_safe`.~~ — **done 2026-06-02.** `requirements/scenario_establish_explore.yaml`: muster + starter_chest both switched from `offset_from` to `random_safe radius 8 attempts 32` (the placement engine doesn't validate `offset_from` landings; `random_safe` does). Lint passes; stale catalog snapshot cleared so the next bootstrap does a fresh find with the new placements. `establish-scenario.sh` auto-patch kept as belt-and-suspenders.

**Deferred**

- Mapcatalog `offset_from` validation as a general feature. Local change above sidesteps the muster case; the broader engine fix can wait.
- Per-worker tp fan adaptation. Current SW-quadrant fan + position-sanity re-tp worked last time; revisit only if Phase 5 re-tps fire.
- Dispatcher dual-claim. We worked around with `set-after` + `block` in 30s last time; same workaround if it bites again. `mutex_park` investigation is not on the path.

(Per-item exits fold into 4.1–4.2 above.)

**Dependencies:** independent. Parallelize with Phases 1–3.

---

## Phase 5 — Multi-bot re-run with attribution metrics

**Why last.** Only meaningful with Phases 0–3 landed. Phase 4 improves cleanliness, not hard logic.

**Setup**

- `AUTO_REUSE=1 MATERIALIZE=0 scripts/establish-scenario.sh` (idempotent).
- ~50 min wallclock, matching the 2026-06-01 baseline.
- No operator intervention except observation.

**Attribution-first predicates (vs the 2026-06-01 baseline)**

| Metric | 2026-06-01 baseline | Phase 5 target |
|---|---|---|
| Cards closed by assignee (worker `mc chat "done t_…"` + Hermes `kanban_complete` or verifiable run close) | 0 | All EXPLORE/SCOUT cards |
| Marks attributable to assignee (no `reconciled_from: ["steward"]` for explore pads) | 1 (Flint `nw_patrol_edge`) + 2 (Mason `se_ruin`/`se_walls`) | ≥1 worker-authored mark per closed EXPLORE/SCOUT card |
| Steward `mc move` / `mc terrain_top` / `mc mark` calls beyond base envelope | 66 / 82 / 12 | 0 (hook enforced) |
| Steward `scripts/fleet-status.py` calls | 1 (per dev assumption — may be 0 on re-count) | ≥1 per orchestrator cycle |
| Pillar/trap-loop wallclock episodes per worker | ~5 min average | No single episode > 1 min |
| Dual-control symptoms ("goal was changed") | many | 0 |

**Items**

- [x] **5.1** — ~~Run `AUTO_REUSE=1 MATERIALIZE=0 scripts/establish-scenario.sh` uninterrupted for ~50 min; collect logs + final kanban snapshot + per-bot `locations-{bot}.json` into `data/postmortems/establish-<date>/`.~~ — **done 2026-06-02 (run3).** Captured to `data/postmortems/establish-2026-06-02/` (kanban.db + worker session logs + locations + workspaces). Phase 6 re-test produced an additional success-baseline capture in `data/postmortems/establish-2026-06-02-phase6-run2/`.
- [~] **5.2** — ~~All six attribution predicates above meet target, OR exceptions documented inline with reason.~~ — **predicates missed in run3 as documented; loop closed into Phase 6 per the plan's *"If a metric misses → loop back to the responsible phase"* policy.** Run3 had 8 dup cards (target 4), dual-claim (target 0), 1 protocol_violation (target 0). Run2 (Phase 6.7) re-tested with the upstream-aligned architecture and hit all six predicates clean — see [SUMMARY.md predicates table](../../../data/postmortems/establish-2026-06-02-phase6-run2/SUMMARY.md#phase-6-predicates-vs-phase-5-run3-baseline).
- [x] **5.3** — ~~Post-run POSTMORTEM written. Confirms card-invisibility, shadow-scout, and pillar/trap-loop are not the dominant narratives.~~ — **done 2026-06-02.** Two postmortems landed:
  - [`ARCHITECTURE-FINDINGS.md`](../../../data/postmortems/establish-2026-06-02/ARCHITECTURE-FINDINGS.md) — run3 root-cause analysis, identifies the dispatcher/plugin layering and the seeder defaults as the real failure modes (not card-invisibility, not shadow-scout, not pillar/trap-loop — those were Phase 1-4 fixes that held).
  - [`SUMMARY.md`](../../../data/postmortems/establish-2026-06-02-phase6-run2/SUMMARY.md) — run2 success baseline confirming the new architecture eliminates the dispatcher-class symptoms.
- [~] **5.4** — One-line closure note in [`scenario-runs.md`](scenario-runs.md) or [`procedural-devlog.md`](../../planning/session-devlog.md). **Pending.** `scenario-runs.md` (last touched 2026-06-02 00:31) and `procedural-devlog.md` (last touched 2026-06-01 23:52) both predate run3/run2. Both should be updated with: links to Phase 5 predicates, kanban snapshot paths, locations JSON, and whether `establish` epics stay on proc-lab or move to main world. Small task; would land alongside Phase 7 kickoff.

**If a metric misses** → loop back to the responsible phase; do not advance scenario design. *(5.2: this clause activated and produced Phase 6.)*

---

## Phase 6 — Upstream alignment

**Why.** Phase 5 run3 (2026-06-02) reproduced the dual-claim symptom and added a new one (Steward double-creating cards). Root cause investigation found that both symptoms are solved by **default Hermes capabilities** that we've been shadowing with local plumbing:

- `kanban_create(parents=[…])` / `--parent <id>` — child stays `todo` until parent done. Verified α.2.
- `kanban_create(idempotency_key=…)` / `--idempotency-key <key>` — second call with same key returns the same task id. Verified α.3.
- Gateway-embedded dispatcher (`kanban.dispatch_in_gateway: true`) — verified α.1; the upstream-stated default; the "wedges silently" claim in our docs is stale.
- `hermes kanban diagnostics` — surfaces `stranded_in_ready`, `failure_limit`-tripped, `gave_up`, age tiers. Verified α.5; this is the situation room we kept planning to build.

Our local layers (`scripts/landfolk-dispatcher.sh` 140 lines, `plugins/landfolk/` ~500 lines, custom `scripts/fleet-status.py`) were built when the upstream wasn't yet sufficient. The plugin's `post_tool_call` hooks were never registered (`ctx.register_hook(...)` is missing) so its mutex code only ran when `landfolk-dispatcher.sh` invoked `gate-check` — and during the 2026-06-02 establish run, dispatcher.sh wasn't running because `establish-scenario.sh` uses `scripts/landfolk-control.sh start`, which doesn't start the dispatcher.

Findings doc: [`data/postmortems/establish-2026-06-02/ARCHITECTURE-FINDINGS.md`](../../../data/postmortems/establish-2026-06-02/ARCHITECTURE-FINDINGS.md).

**Items**

- [x] **6.1** — ~~Flip `~/.hermes/config.yaml`: `kanban.dispatch_in_gateway: false → true`.~~ — **done 2026-06-02.** Live config reads `true`; gateway startup line at `~/.hermes/logs/gateway.log:11` reads *"kanban dispatcher: max_spawn=3"* + *"kanban dispatcher: embedded in gateway (interval=60.0s)"* (previously: *"kanban dispatcher: disabled via config kanban.dispatch_in_gateway=false"*).

- [x] **6.2** — ~~Make `scripts/establish-scenario.sh` bring up the gateway.~~ — **done 2026-06-02.** Added `nohup hermes gateway run --replace` block (`scripts/establish-scenario.sh:139-151`) before the `landfolk-control.sh start` call, with a 10s poll loop for `hermes gateway status`. End-to-end run2 confirmed gateway came up before workers.

- [x] **6.3** — ~~Update Steward's SOUL to use `parents=[…]` + `idempotency_key=…`.~~ — **done 2026-06-02.** Edited `prompts/landfolk/steward.md` (lines 30, 75-101, 105-114) + `prompts/landfolk/steward.wake-minimal.md:3`. Run2 produced 5 of 18 cards with `parents=[…]` set — `mutex_released` events at 20:47 confirmed prereq promotion working as documented. Idempotency_key adoption is partial in the SOUL but Steward didn't dup-create this run; can tighten in a follow-up.

- [x] **6.4** — ~~Decide `kanban.auto_decompose` for `landfolk-ops`.~~ — **done 2026-06-02 (verified, no change needed).** Already `false` in `~/.hermes/config.yaml:548`. Run2 confirmed no double-decomposition; Steward owns all decomposition manually.

- [~] **6.5 (REVISED)** — Retire `scripts/landfolk-dispatcher.sh` ONLY. **Keep `plugins/landfolk/`** — the post_tool_call hooks fire automatically when `kanban_create` is invoked via tool (verified by 3 `mutex_parked` + 3 `mutex_released` events in run2). The plugin's mutex code is load-bearing and complementary to the upstream gateway dispatcher; it just wasn't running in earlier baselines because dispatcher.sh wasn't started. Now the architecture is: gateway dispatcher spawns workers; plugin hooks auto-park sibling tool-side creates.
  - Exit: `scripts/landfolk-dispatcher.sh` moved to `attic/` (or deleted with archived git history). Startup logic at `scripts/landfolk:656-668` removed. `scripts/landfolk-control.sh` references at lines 1338, 1420, 1422 cleaned up. `plugins/landfolk/` STAYS where it is.

- [ ] **6.6** — Replace `scripts/fleet-status.py` with a thin wrapper over `hermes kanban diagnostics` + `hermes kanban stats` + the existing bot HTTP `/status` poll. Keep the bot-side fields (position, holding, last FAIL) because those are MC-specific. Drop the in-house "stranded card" / "card body excerpt" reimplementations — `kanban diagnostics` does the first one upstream and `kanban show` does the second.
  - Exit: `fleet-status.py` is ≤100 lines; it shells out to the two Hermes CLIs and merges with the bot poll.

- [x] **6.7** — ~~Re-run the establishment.explore scenario with all of 6.1-6.6 landed.~~ — **done 2026-06-02, run2 success — see [SUMMARY.md](../../../data/postmortems/establish-2026-06-02-phase6-run2/SUMMARY.md).** Run lasted ~100 min (longer than the 50-min baseline because run2 progressed *past* the original epic into a second epic). **First orchestrator-driven epic completion in project history**: Steward archived `[EPIC] [ESTABLISH:BASE]` at 20:46 (~70 min in) without operator intervention.
  - Exit (predicates for Phase 6, vs Phase 5 baseline run3):

  | Metric | Phase 5 run3 baseline | Phase 6 target |
  |---|---|---|
  | Cards created per epic decomposition | 8 (4 originals + 4 dups) | 4 (idempotency_key dedup) |
  | Concurrent workers per bot at any moment | up to 2 (dual-claim) | 1 (parents chain) |
  | `goal was changed` errors | 1 | 0 |
  | `landfolk-dispatcher.sh` PID alive | 0 (script not running anyway) | 0 (script deleted) |
  | `hermes gateway` PID alive | 1 (unintended) | 1 (intended) |
  | Steward sqlite3 invocations | 128 | 0 (no missing CLI verbs to bypass) |
  | `scripts/fleet-status.py` LOC | ~400 | ≤100 |
  | `hermes kanban diagnostics` output during run | not used | used by Steward each cycle |

  **Run2 actuals (2026-06-02):** dup=0, dual-claim=0 (1 worker/bot max throughout), `goal was changed`=17 (nav-internal, not dispatch — verified via pgrep), dispatcher.sh PID=0, gateway PID=1 (intended), Steward sqlite3=0 in run2, fleet-status.py LOC unchanged (6.6 deferred), `kanban diagnostics` not used directly but `mutex_parked` events confirm plugin hooks are doing the work. **All success predicates met.**

- [~] **6.8** — Post-run closure: ~~write `data/postmortems/establish-<date>/UPSTREAM-MIGRATION.md` confirming the symptom set is gone OR enumerating what didn't transfer.~~ Done via [SUMMARY.md](../../../data/postmortems/establish-2026-06-02-phase6-run2/SUMMARY.md) (more comprehensive than originally planned: includes timeline, deferred-issue notes, and the 6.5 revision rationale). Progress block + Phase 6 checkboxes updated above. Remaining: close 6.5 cleanup + 6.6 fleet-status rewrite when convenient.

**Dependencies:** Phase 5 closed (or accepted as baseline). Items 6.1–6.4 can land in parallel; 6.5 depends on 6.1+6.2 being green; 6.6 depends on 6.3 (Steward needs to know about `kanban diagnostics`); 6.7 depends on 6.1–6.6.

**Time estimate:** ~half a focused day for 6.1–6.6 (each is small), then 6.7 is the 50-min establishment run + ~half day analysis.

**Risk:** auto_decompose may produce a worse decomposition than Steward's prompted one. Mitigation: 6.4 defaults to `false`. We can flip it later once we trust the decomposer's choices.

---

## Phase 7 — Worker friction triage (run2 evidence-driven)

**Why.** Phase 6 run2 closed the dispatcher/orchestrator class of failures (verified: 0 dups, 0 dual-claim, 0 protocol_violation, Steward ran clean — see [SUMMARY.md](../../../data/postmortems/establish-2026-06-02-phase6-run2/SUMMARY.md)). The remaining friction is worker-side: ~190 `[error]` mc invocations across 5 high-friction cards when every terminal error line is counted (including `cd … && mc …`; an earlier manual **154 / 80 move** undercounted those), dominated by `mc move` (~92, ~48%), not by `goto_near` or "goal was changed" as earlier cumulative-log analyses had suggested. Phase 7 fixes the seeder default that wastes Steward sessions at startup, then attacks the dominant short-range `mc move` failure surface and fill-partial inspect loops.

**Plan location.** Detailed plan lives in [`.cursor/plans/run2_worker_friction_triage_6b269a59.plan.md`](../../.cursor/plans/run2_worker_friction_triage_6b269a59.plan.md), with verified code citations and exit criteria. This stub keeps the phase visible in the central progression doc.

**Roll-up of existing dev tasks** (cross-referenced 2026-06-03 against [`../../archive/testing/procedural/establishment-log.md`](../../archive/testing/procedural/establishment-log.md) and [`../../planning/session-devlog.md`](../../planning/session-devlog.md) backlog #27–#58):

| Existing # | Phase 7 item | Disposition |
|---|---|---|
| #35 Convert orchestrator deny hook to allowlist | — | **Already done via 3.1.** Mark as completed; no Phase 7 work. Run2 session JSON parsing confirmed zero forbidden mc verbs by Steward. |
| #36 Richer worker status view for Steward | 6.6 + 7.5 | Partially done via 3.4 (fleet-status v2). Remaining scope overlaps with 6.6 (`hermes kanban diagnostics` wrapper) and 7.5 (structured handoff comments). |
| #37 Sandbox: cover `execute_code` tool path | — | Still pending but **lower priority.** Run2 verified zero `sqlite3`/`python3 -c`/`execute_code` calls by Steward; SOUL discipline holding without sandbox enforcement. Keep as defense-in-depth backlog. |
| #38a Vertical-traversal NAV_BLOCKED | 7.2 | **Direct overlap.** 7.2 adds `error.next_action_hint` to NAV_BLOCKED envelopes (action layer). #38a covers perception/preflight side. Cross-link in plan: 7.2 must not regress #38a's preflight surfaces. |
| #41 #38b Long-range flat-ground pathfinder | — | Orthogonal — Phase 7 addresses short-range `mc move`, not long-range pathfind. Keep separate. |
| #42 #38c goto_near 8s cap | 7.7 | **Explicitly deferred** by 7.7. Run2 had 0 cap hits across all 18 cards. Real backlog, not run2 bottleneck. |
| #49 seed_base_pad 80/81 persists | 7.3 | **Direct overlap.** 7.3's `place-bulk.js` `FILL_PARTIAL` + `remaining_cells` migration closes the worker-side loop. The 80/81 case is `bot_blocked_cells` (Steward standing on center) — already partially surfaced by place-bulk; 7.3 promotes it to the full envelope. Cross-link. |
| #52 Mining skill surface-strip | — | Adjacent to 7.4 (mark `--at`) but distinct enhancement. Keep separate. |
| #53 Relax P2 mining-card prescriptions | — | Orthogonal. Keep separate. |
| #55 `mc collect` COUNT max=64 surprises | 7.2 | **Direct overlap.** Run2 showed Mason calling `mc collect stone 81` then `mc collect stone 64` — exact #55 friction. Add a COUNT-too-high hint to 7.2's hint set. |
| #56 `mc craft` MISSING_INGREDIENTS | — | Out of scope. Independent. |
| #57 No sheep at anchor | — | Out of scope. World-content, not code. |
| #58 Suggested direction on `mc status` nav_header | 7.2 | Adjacent: 7.2's `error.next_action_hint` is the same generator concept on a different surface (error envelope vs status header). Could be merged. |

**Headline items** (full detail in cursor plan):

- [x] **7.0** — Seeder fallback (`establish-seed-cards.py` explore default `"orchestrator-tracker"`) + hermetic `scripts/tests/test_establish_seed_cards.py`. Open question: keep `gatherer.md` as canonical reference or delete to remove `gatherer-test.md` divergence risk.
- [x] **7.1** — Trace analyzer (`scripts/analyze-worker-trace.py`) + `scripts/tests/test_analyze_worker_trace.py`; corpus regression on five run2 high-friction cards (**190** `[error]` mc invocations, **92** `move` — chained `cd … && mc …` lines; older manual **154 / 80** undercounted workspace prefixes). JSON via `--json`.
- [x] **7.2** — `nav-hints.js` + `next_action_hint` on `NAV_BLOCKED` / `NAV_DETOUR_TOO_LONG` / stall paths; `withNavRetryWarning` at 3rd consecutive failure (`bot/test/actions/nav-hints.test.js`). SOUL/skill copy still Tier 3.
- [x] **7.3b** — `place_fill` partial → `fail('FILL_PARTIAL', …, { retry_safe: true, remaining_cells capped 32 })`; full success → `ok()`. `/action/place_fill` long deadline landed in Tier 1. Building-skill guidance still Tier 3.
- [x] **7.4** — ~~Mark target coordinates, not bot feet.~~ — **done 2026-06-03, three layers landed.** Runtime SOULs updated in `gatherer-test.md` + `flint.md` (Phase 7 Tier 3). `bot/test/actions/mark-at.test.js` regression-locks the `body.at` contract (Phase 7.4b). Phase 8 Tier 1 Change A (`mc mark` soft-warn — `MARK_NO_AT_COORD_IN_NOTE` in `observed_state.warnings` when note text contains coord-shaped substring but no `--at`) closes the enforcement gap: run-4 found 0/12 marks used `--at` despite SOUL bullets. The Phase 8 warning makes the failure visible to the next agent turn.
- [x] **7.5** — ~~Structured worker handoffs.~~ — **done 2026-06-03, template shipped, adoption pending validation.** Added "Minecraft worker handoff template" subsection to `skills/kanban-worker.md` (SCOUT/CONSTRUCT/SUPPLY headers, modeled on Gatherer's run2 1555-char SCOUT close-out). Run-4 evidence: 0 adoption — even Gatherer reverted to her run2 ad-hoc narrative. Template is shipped; agent-side discipline didn't penetrate. Either needs explicit per-worker SOUL bullets pointing at the template OR runtime enforcement (agent-test `mc_chat_contains_any:corners,obstacles,flatness`). Carrying as **partial-shipped, adoption-deferred**; revisit alongside Phase 8 Tier 2 SOUL work.
- [~] **7.6** — ~~Focused regression gates~~ — **bot tests done, proc-lab agent-tests deferred.** Bot/script unit gates from the cursor plan all land: `bot/test/actions/nav-hints.test.js` (7.2), `bot/test/cli/http.test.js` (7.3a), `bot/test/actions/building-contract.test.js` (7.3b), `bot/test/actions/mark-at.test.js` (7.4b), `scripts/tests/test_establish_seed_cards.py` (7.0b), `scripts/tests/test_analyze_worker_trace.py` (7.1). Proc-lab `short-move-obstacle.yaml` + `pad-mark-handoff.yaml` topics NOT built — agent-test runner couldn't assert `kanban_comment` shape so the test design was deferred. Live establish replay (run-4 2026-06-03) substituted as the integration gate; run-4 evidence + analyzer + per-bot subagent reports captured in `data/postmortems/establish-2026-06-03-phase7/`.
- [ ] **7.7** — Deferred (do not pursue without fresh evidence): `goto_near` cap (#42), `goal was changed` (zero in run2), Steward forbidden-verb work (clean in run2), turn-budget meter, entity-on-pad mitigation beyond 7.3.

**Executability constraints:** reduce handoffs by folding 7.0b into 7.0; make every code change unit-testable; use the trace analyzer as the common measurement tool for postmortems and new agent-test transcripts; avoid manual session JSON review as an exit criterion; keep proc-lab coverage to two realistic micro-scenarios before considering an establish replay.

**Dependencies:** Phase 5 baseline + Phase 6 success — both available. 7.0 lands independently; 7.1 unblocks 7.2 and provides the measurement harness for 7.6; 7.3 / 7.4 / 7.5 can parallelize after 7.1; 7.6 is the final gate.

**Time estimate:** ~half a focused day for 7.0–7.4 surgical items if tests stay local; two proc-lab micro-scenarios add ~1–2 hours; full replay (if needed) ~50 min run + analyze. Hobby-scope: keep to one cycle.

**Risk:** the seeder change (7.0) leaves explore cards `assignee=orchestrator-tracker` until Steward's continuous loop reassigns. If her loop runs too slowly on a fresh start, cards sit non-dispatched. Mitigation in 7.0 exit criterion: validate Steward reassigns within 10 min.

---

## Phase 8 — Postmortem-driven friction reduction (run-4 evidence)

**Why.** Phase 7 run-4 (2026-06-03) [thorough postmortem](../../../data/postmortems/establish-2026-06-03-phase7/THOROUGH-POSTMORTEM.md) closed with **3 of 10 predicates held**. The Phase 7 code/SOUL changes worked structurally but most failed to penetrate worker behaviour in a live run. Two findings dominate:

- **0 of ~12 explore-phase marks used `--at`** despite the Phase 7.4 SOUL bullet. Marks saved at bot standing position; downstream `mc go_mark` resolved to wrong cells → Pattern A (mark-then-can't-return) nav failures.
- **`mc move` strict cell-match dominates friction** (108/231 errors, ~47%). Operator's verb-level observation: *"`bg_goto` and `goto_mark` seem to be actually useful"* — those verbs are lenient by default; `mc move` was the outlier.

Three additional patterns surfaced (B self-trap-by-digging, C panic-pillar, E terrain blindness) that need structural fixes — see the postmortem's Tier 1–4 candidate list.

Plan location: [`~/.claude/plans/investigate-the-open-points-wondrous-karp.md`](../../../.claude/plans/investigate-the-open-points-wondrous-karp.md). Companion postmortem: [`THOROUGH-POSTMORTEM.md`](../../../data/postmortems/establish-2026-06-03-phase7/THOROUGH-POSTMORTEM.md) + [`FRICTION-NOTES-LIVE.md`](../../../data/postmortems/establish-2026-06-03-phase7/FRICTION-NOTES-LIVE.md).

**Items**

- [x] **8.1** *(Tier 1 A — mc mark soft-warn)* — ~~Enforce `mc mark --at` when note text contains coord-shaped substring.~~ — **done 2026-06-03, commit `41c314a`.** `bot/lib/actions/marks.js` detects `\d+,\d+,\d+` patterns in note text; emits `observed_state.warnings: [{ code: 'MARK_NO_AT_COORD_IN_NOTE', message, note_coords, saved_at }]` when no `--at` provided. Mark IS still saved (soft warning). 8 new tests in `bot/test/actions/mark-soft-warn.test.js` covering positive cases, false-positive guards (two-number sequences, single-axis labels), and `--at` / `at_mark` suppression.

- [x] **8.2** *(Tier 1 B — mc move lenient long-range default)* — ~~Distance > 20 blocks defaults to `near=2` (was strict GoalBlock).~~ — **done 2026-06-03, commit `41c314a`.** `bot/lib/actions/movement/move.js` computes `effectiveNear` before preflight: when distance > 20 AND `args.near == null` AND `args.strict !== true`, sets `effectiveNear = 2` and uses `GoalNear` for the pathfind goal (was `GoalBlock`). 7 new tests in `bot/test/actions/move-lenient-default.test.js` + 12 existing move tests still green.

- [ ] **8.3** *(Tier 1 #3 — Steward `hermes kanban diagnostics` mandate)* — Update `steward.md` OBSERVE step to mandate `hermes kanban diagnostics` when any IN-FLIGHT card has runtime > 15 min. Run-4 evidence: 0 diagnostics calls across 20 OBSERVE cycles despite the SOUL mentioning it; she missed the 41-min Mason pad stall that would have been flagged at ~T+20 min by the upstream `stranded_in_ready` signal. Prose-only.
  - Exit: live run shows Steward calls `hermes kanban diagnostics` during any cycle where IN-FLIGHT card runtime exceeds threshold.

- [ ] **8.4** *(Tier 2 #6 — Card-body verb extraction)* — Update worker SOUL (mason.md primarily; flint.md by symmetry) to treat verbatim `mc <verb> ...` lines in card bodies as REQUIRED instructions, not flavor text. Run-4 evidence: Mason's pad task body said `mc fill cobblestone 13 103 1 21 103 9` but she dug + placed manually, hit iteration_budget_exhausted (150/150) without ever calling `mc fill`. The Phase 7.3b FILL_PARTIAL contract migration was correct but unexercised. Prose-only SOUL update first; a card-body precheck in `skills/kanban-worker.md` could ship as a Tier 2 follow-up.
  - Exit: replay shows Mason calls the literal `mc fill` from her card body before any manual mining loop.

- [ ] **8.5** *(Tier 1 #2 + #5 — `terrain_kind` + `feet_vs_local_ground` nav-brief fields)* — Add structured terrain characterization so agents read labelled state instead of re-deriving from raw deltas. Reuse `cardinalReliefDeltas` and `surfaceYAt` already in `bot/lib/shared/scene-landscape.js`. Surface in `mc status` nav_header + `mc scene` summary. After the field ships, update Steward SOUL to interpret it (no more "you're underground at Y=96, pillar_up 15" telling workers to over-climb their local surface). Largest single-change leverage in the postmortem's Tier 1 list; designs Pattern E and B+C mitigation.
  - Exit: nav-brief returns `terrain_kind: 'gentle_slope_S' | 'flat' | 'depression' | ...` and `feet_vs_local_ground: int` on every `mc scene` / `mc status`.

- [ ] **8.6** *(Tier 2 #7 — `mc escape` recognizes 1-block depression)* — When `feet_vs_local_ground == -1` and a standable cell exists at `+1 Y` in any cardinal, the escape primitive's first action is `mc jump`, not `pillar_up`. Depends on 8.5. Kills Pattern B's panic-pillar-out-of-1-block-hole pattern from run-4 evidence (Mason's 4 pillar_ups, Gatherer's 5, Flint's 4 — 13 dirt/oak/cobble pillars left in the world this run).
  - Exit: bot test exercises 1-block depression + asserts no `pillar_up` call.

- [ ] **8.7** *(Tier 2 #8 — `mc fence` + `--gate` advisory)* — When the bulk `mc fence` verb is invoked without `--gate`, return a structured `observed_state.warnings` advisory. Catches the fence-trap pattern early. Pure additive; no breaking change.
  - Exit: bot test for `mc fence` without `--gate` returns the warning; with `--gate` no warning.

- [ ] **8.8** — Next establish replay. Compare against run-4 baseline using `scripts/analyze-worker-trace.py`:
  - `mc move` errors materially below 108 (target ≤80)
  - "No standable cell" errors approach zero on long-range moves
  - Marks in `locations-base.json` have coords matching note text
  - `mc pillar_up` count materially below 13 (panic-pillar)
  - At least one Mason `mc fill` call when the card body specifies one
  - Steward called `hermes kanban diagnostics` ≥1 time per ~20-min IN-FLIGHT card

**Dependencies:** 8.1+8.2 done. 8.3+8.4 are prose-only and independent. 8.5 unlocks 8.6 (a small follow-on once the new fields exist). 8.7 is independent. 8.8 needs 8.3–8.7 landed.

**Time estimate:** 8.3+8.4 ~30 min combined (prose). 8.5 ~2-3 hours (single bot PR with thresholded classifier + ≥3 new tests). 8.6+8.7 ~1 hour each. 8.8 = 50-min replay + ~half day analysis.

**Risk:** 8.5 `terrain_kind` classifier needs threshold tuning across biomes — a too-strict definition of `flat` would make every legitimate slope look like a problem. Mitigation: start with conservative thresholds, validate via the analyzer + replay before SOUL changes (8.5 is the architectural change, not the SOUL bullet).

**Out of scope (Tier 3+ from postmortem, deferred):**
- `AUTO_REUSE=0 MATERIALIZE=1` bootstrap fix — operator/infra.
- Spawn-area cleanup in `establish-rcon-prep.py` — operator/infra.
- Server-side classification thesis (broader than `terrain_kind`) — design follow-up.

---

## Phase summary

| Phase | What | Surface | Cost | Re-run blocker? |
|---|---|---|---|---|
| 0 | Validate dual-control guard | Log grep + 1 card | ~30 min | Recommended |
| 1 | Card visibility (dispatch + A2) | `kanban_smoke` + manual real-dispatch | ~half day impl + ~20 min validation | **Yes** |
| 2 | Nav primitives (A4, A5, A8-column, A9, A10) | curl + eyeball | ~half day impl + ~15 min validation | **Yes** |
| 3 | Orchestrator constraints (A3, A12-lite, wake, fleet-status v2) | Manual Steward session | ~half day impl + ~20 min validation | **Yes** |
| 4 | Bootstrap polish (biome + muster placement) | Lint + scouting run | ~hour impl + ~5 min validation | No |
| 5 | Multi-bot re-run (baseline) | establishment.explore | ~50 min run + ~half day analyze | — |
| 6 | Upstream alignment (gateway dispatcher + parents + idempotency_key) | scratch board + 1 establish run | ~half day impl + 50 min run + ~half day analyze | **Yes** for the next establish |
| 7 | Worker friction triage (mc move + fill partial + mark --at + handoffs) | bot tests + proc-lab agent-tests + optional short replay | ~1 focused day | Recommended for next establish |
| 8 | Postmortem-driven friction reduction (mc mark soft-warn, lenient long-range move, terrain_kind, escape-via-jump) | bot tests + 1 replay against run-4 baseline | ~half day Tier 1+2 SOULs + ~1 day terrain_kind PR + 50-min replay | Recommended before next establish |

**Time estimate:** ~2 focused days end-to-end through Phase 5; add ~1 day each for Phase 6, 7, 8. If a phase blows past its slot, cut deeper inside the phase before extending. Watch for:
- Phase 1 dispatch injection — if it turns out to need upstream Hermes config, swap to `worker.md` ritual line + A2 suppression only, accept slightly weaker enforcement.
- Phase 3 fleet-status v2 — keep to one commit; resist adding fields beyond the minimum Steward needs to stop guessing.
- Phase 5 attribution requires Phase 3's A12-lite caller check to be honest about worker-vs-Steward closures.
- Phase 6 6.4 (auto_decompose decision) — if you defer it, the dup-decomposition risk stays. Decide before 6.7.
- Phase 7 7.0 seeder change — verify Steward continuous-loop reassign cadence on first replay; if her OBSERVE interval (~5–6 min) lets cards sit too long, add an `assignee=orchestrator-tracker` poll to her wake.
- Phase 8 8.5 `terrain_kind` threshold tuning — start conservative, validate via analyzer/replay before SOUL changes. The labelled-state thesis can grow beyond `terrain_kind` (Tier 4 design follow-up) — don't expand 8.5's surface mid-flight.

---

## Out of scope

- Full worker SOUL rewrites. Phase 1's dispatch injection + A2 + one domain-skill trump line replaces this.
- Replacing the dispatcher. Confirm `t_dbd98222` is a real gap vs existing `mutex_park` before any code.
- Changing `mc goals` semantics for idle, non-card-bearing bots. A2 suppresses only when a card is in flight, preserving the goal engine for the explicit "idle bots stock up" behavior the user wants kept.
- Re-keying the procedural map beyond `offset_from` placement validation. Keep the `establish-scenario.sh` map auto-patch as belt-and-suspenders.
- Steward decomposition quality (card sizing, epic structure). Bad specs still fail after Phase 5; that belongs in playbook/establish-template iteration, not this closure gate.
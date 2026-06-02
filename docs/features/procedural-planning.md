# Procedural Planning — fixes before the next establishment run

Goal: get `establishment.explore` to a state where it produces autonomous, attributable, card-driven exploration data. Before re-running the full multi-bot scenario, validate each fix on a smaller test surface so we know what we're actually measuring.

Source: [`procedural-devlog.md`](procedural-devlog.md) + [`POSTMORTEM.md`](../../data/postmortems/establish-2026-06-01/POSTMORTEM.md).

## Progress

**Current phase:** 1 — Card visibility, on 1.5 (`kanban_smoke` agent-test).
**Open / total:** 18 / 24 (Phase 0 closed; Phase 1 items 1.1, 1.2, 1.3, 1.4 done).
**Last update:** 2026-06-02 (A2 implemented in http-app.js; mason.md + gatherer.md patched).

## Working agreement

- Every actionable item has a stable ID (`0.1`, `1.2`, …). IDs are phase + sequence; they never get reused.
- An item is `[ ]` pending until its **exit criterion** holds. Code landing alone does not flip it to `[x]`.
- When an item passes, edit this file in place: flip the checkbox and append a short ` — done YYYY-MM-DD, <commit/ref/note>` to the bullet.
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

- [ ] **1.5** — Land `data/agent-tests/topics/establishment/kanban-smoke.yaml`. Pin model to default. One anchor coord from the establish map; card body: "go to (X,Y,Z), `mc chat 'card-acknowledged'`, then `mc chat 'card-complete'`". Drive Flint at `BOT_URL=http://localhost:3002`. Exit: spec runs; predicates pass once. (Re-run if it flakes; don't gate on three.)
  - Predicates: card phrases appear in chat; `bot_at` matches anchor; run JSON `tool_calls` show `kanban_show` (or `scripts/kanban card`) before any `mc goals`; first 5 turns do not reference role-default goal names.
- [ ] **1.6** — Manual real-dispatch sanity (no Steward): repeat Phase 0 setup, watch the live trace. Exit: first `mc move` / `mc goto` aligns with card body coords; `mc goals` is **not** used for task selection.

**Dependencies:** Phase 0 done.

---

## Phase 2 — Nav perception primitives (lean)

**Why second.** With card visibility but weak nav signals, workers still cycle (Flint's pillar saga; Mason's trap loop). Phase 1 makes intent possible; Phase 2 makes execution survive real terrain.

**Items (must)**

- [ ] **2.1** *(A4)* — `pillar_up`/`pillar_down` return `{placed_blocks, y_before, y_after, broke_blocks}`. Exit: `curl :3002/...pillar_up` returns the four fields.
- [ ] **2.2** *(A5)* — Nav-brief exposes `standable_floor_y`, `on_pillar`, `pillar_height_below` on `/status` and `/scene`. Exit: at column top, all three fields are present and accurate.
- [ ] **2.3** *(A8-column)* — Nav-brief topology: `column_top` classification for 1×1 cells with four cardinal drops. Exit: bot on a 1×1 column reads `classification: column_top` (or `on_pillar: true`).
- [ ] **2.4** *(A9)* — When `lastMoveFailed` (F51.2) or `NAV_RECURRING_STUCK` blocks a `mc dig` at the current cell after a successful escape move, auto-clear stale flags. Touch: `bot/lib/server/middleware/position-guard.js` drift-clear pattern; optional dig-path hook in `bot/lib/actions/mining/dig.js`. Exit: trap-escape scenario uses dig without an interleaved `mc status` call.
- [ ] **2.5** *(A10)* — `pillar_up` agent verb appears in HTTP error envelopes and run report tool names (not `pillar_step`). Exit: an intentional `pillar_up` failure error envelope quotes `pillar_up`.

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

- [ ] **2.6** — `scouting.overlook` regression check still PASSes after nav-brief schema additions.

(Per-primitive verifications fold into 2.1–2.5 exits.)

**Dependencies:** independent of Phase 1; parallelize.

---

## Phase 3 — Orchestrator constraints

**Why third.** Steward shadow-scouting masks worker performance. Without A3, Phase 5 cannot tell whether workers or Steward produced marks. fleet-status v2 is the data she needs to stop guessing.

**Policy note.** `landfolk-plugin.md` documents *no `pre_tool_call` blocking* as the general policy (demote-after preferred). A3 is a deliberate exception for the orchestrator role and field-mutating verbs — document the exception in the steward SOUL header and the hook README.

**Items**

- [ ] **3.1** *(A3 deny hook)* — Extend `scripts/hermes-hooks/orchestrator-deny.sh` to refuse `mc move`, `mc goto`, `mc bg_goto`, `mc terrain_top`, `mc mark` when role=orchestrator and target is beyond a small base envelope. Explicit allow: `mc observe`, `mc status`, `mc scene`, `mc marks`, `mc chat`. Exit: each denied verb refused; each allowed verb passes.
- [ ] **3.2** *(A12-lite caller check)* — Add a check in `scripts/kanban complete`: if `HERMES_PROFILE=steward` (or caller != assignee), refuse with "not assignee — comment on the epic instead". Exit: Steward attempting to close Flint's card is refused.
- [ ] **3.3** — Add `scripts/fleet-status.py` to the OBSERVE step in `prompts/landfolk/steward.wake-minimal.md`. Exit: line present.
- [ ] **3.4** *(fleet-status v2)* — Extend `scripts/fleet-status.py`: per-bot running card id + body excerpt + kanban worker pid + parsed FAIL line from `$LOG_DIR/mc-*.log` + recent marks from `data/locations-{bot}.json`. Single commit. Exit: running the script during a real-dispatch test shows all the new fields populated.

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

- [ ] **4.1** — Switch `scene-landscape.js` biome cue to `bot.world.getBiome(pos)` so it stops reading `unknown`. Exit: `scouting.overlook` transcript shows a real biome name.
- [ ] **4.2** — Change `muster` in `requirements/scenario_establish_explore.yaml` to `random_safe` (or `near spawn within N`). Keep `establish-scenario.sh` auto-patch as belt-and-suspenders. Exit: `python -m mapcatalog scenario lint --only establishment.explore` passes; a fresh-seed bootstrap doesn't trigger the muster-position re-tp.

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

- [ ] **5.1** — Run `AUTO_REUSE=1 MATERIALIZE=0 scripts/establish-scenario.sh` uninterrupted for ~50 min; collect logs + final kanban snapshot + per-bot `locations-{bot}.json` into `data/postmortems/establish-<date>/`.
- [ ] **5.2** — All six attribution predicates above meet target, OR exceptions documented inline with reason (e.g., card spec didn't ask for marks).
- [ ] **5.3** — Post-run POSTMORTEM written. Confirms card-invisibility, shadow-scout, and pillar/trap-loop are not the dominant narratives.
- [ ] **5.4** — One-line closure note in [`procedural-scenario-runs.md`](procedural-scenario-runs.md) or the devlog: links Phase 5 predicates, kanban snapshot, locations JSON, and whether `establish` epics stay on proc-lab or move to main world.

**If a metric misses** → loop back to the responsible phase; do not advance scenario design.

## Phase summary

| Phase | What | Surface | Cost | Re-run blocker? |
|---|---|---|---|---|
| 0 | Validate dual-control guard | Log grep + 1 card | ~30 min | Recommended |
| 1 | Card visibility (dispatch + A2) | `kanban_smoke` + manual real-dispatch | ~half day impl + ~20 min validation | **Yes** |
| 2 | Nav primitives (A4, A5, A8-column, A9, A10) | curl + eyeball | ~half day impl + ~15 min validation | **Yes** |
| 3 | Orchestrator constraints (A3, A12-lite, wake, fleet-status v2) | Manual Steward session | ~half day impl + ~20 min validation | **Yes** |
| 4 | Bootstrap polish (biome + muster placement) | Lint + scouting run | ~hour impl + ~5 min validation | No |
| 5 | Multi-bot re-run | establishment.explore | ~50 min run + ~half day analyze | — |

**Time estimate:** ~2 focused days end-to-end. If a phase blows past its slot, cut deeper inside the phase before extending. Watch for:
- Phase 1 dispatch injection — if it turns out to need upstream Hermes config, swap to `worker.md` ritual line + A2 suppression only, accept slightly weaker enforcement.
- Phase 3 fleet-status v2 — keep to one commit; resist adding fields beyond the minimum Steward needs to stop guessing.
- Phase 5 attribution requires Phase 3's A12-lite caller check to be honest about worker-vs-Steward closures.

---

## Out of scope

- Full worker SOUL rewrites. Phase 1's dispatch injection + A2 + one domain-skill trump line replaces this.
- Replacing the dispatcher. Confirm `t_dbd98222` is a real gap vs existing `mutex_park` before any code.
- Changing `mc goals` semantics for idle, non-card-bearing bots. A2 suppresses only when a card is in flight, preserving the goal engine for the explicit "idle bots stock up" behavior the user wants kept.
- Re-keying the procedural map beyond `offset_from` placement validation. Keep the `establish-scenario.sh` map auto-patch as belt-and-suspenders.
- Steward decomposition quality (card sizing, epic structure). Bad specs still fail after Phase 5; that belongs in playbook/establish-template iteration, not this closure gate.

# Colony architecture validation — execution plan

**Date:** 2026-06-06 (last updated 2026-06-07)
**Status:** Sessions 1–4 complete; Session 4½ ready to execute. See [Progress](#progress) below.

## Progress

| # | Session | Status | Commit | Notes |
|---|---|---|---|---|
| 1 | Foundation | ✅ done | `80e2b2b` | `colony` marker excluded from fast/full runners; `tests/colony/` tree + README; `C0_colony_arena.yaml` (POIs + `mc mark` post-prep); `test_chest_delta_predicate.py` (variant 3); `telemetry.py` JSONL emitter with `SUMMARY_FIELDS` lock. Handoff regression stayed green. |
| 2 | Done-ness | ✅ done (verbs narrower than plan) | `be2d6ca` | `mc verify` dispatcher (`bot/lib/actions/verify.js`, 13 Tier 1 contract tests). Verbs landed: **`inventory_contains` and `chest_contains` only** — `chest_delta`, `region_*`, `at_mark` deferred (file marks them as future work). `test_chest_object_state_predicate.py` lands variant 2 against `chest_contains`. Done-ness vocab map in `docs/architecture/mc-verify-spec.md`. **Implication for Session 5:** capstone acceptance narrowed to a `chest_contains`-expressible predicate; richer region predicates need a follow-up session before the full walkthrough acceptance set is testable. |
| 3 | Blocker / review | ✅ done | `225f8e1` | `prototypes/agent-arch/overseer/review_loop.py` (284 lines, polling subscription pattern; structured-reason recognition; linkage via `task_events.kind='review_link'` payload `review_of=<id>`). 7 contract tests in `test_overseer_contract.py`. |
| 4 | Mutex 5a | ✅ done | `3c3fc4b` | `mutex_key.py` with `[bot:<name>]` title-prefix encoding (no metadata column in tasks schema yet — interim seam). `gate.py` Step 3+5 + `hooks.py` walk by computed key; `promote.py` helpers take a key string. 33 new tests; 108/108 plugin tests pass. |
| 4½ | Spawn seam | ✅ done | `3ce9bc4` | `spawn-with-bot.sh` + `data/bots/{pip,zee}.yaml` + 12 contract tests (lookup correctness / failure modes / precedence). |
| 5a | Capstone scaffold | ✅ done | (this commit) | `prototypes/agent-arch/capstone/`: `wheat_graph.py`, `wide_baseline.py`, `acceptance.py`, `author.py`, `preflight.sh`, README. 29 contract tests. `data/bots/mox.yaml` added. Preflight surfaces two gaps (missing `agent-builder/farmer/crafter` skill bundles) that must close before 5b. |
| 5a→b prep | Close pre-trial gaps | ✅ done | 3 commits | Gap 1: `agent-builder/farmer/crafter` skill bundles. Gap 2: `mc verify` `at_mark` + `region_blocks` verbs (17 new contract tests; spec doc updated). Gap 3: `scripts/colony` launcher (registry-driven, status/start/stop/restart/logs, `--dry-run` for testing; 15 contract tests). Preflight now exits 0. |
| 5b | Live wheat trial | pending — operator-driven | — | All pre-trial gates pass. Bring up `landfolk-test` world + Tester (`scripts/run-tester-bot.sh`) + colony bots (`scripts/colony start --all`); author colony lane + wide baseline via `capstone/`; gate via `acceptance.evaluate`; categorise via plan's confound table; update A6 + A7. |

### Assumption status (snapshot)

| # | Assumption | Status |
|---|---|---|
| A1 | `mc verify` predicate shape stable across variants | **supported** (Session 2 — 13/13 contract tests; 3 verbs landed) |
| A2 | `success_when` / `mc verify` / `acceptance` reconcile | **supported** (Session 2 — vocab map in `mc-verify-spec.md`; cross-reference in colony test) |
| A3 | Block → review → unblock reduces operator load | **supported** (Session 3 — full loop observable in kanban events; structured prefixes recognised) |
| A4 | `metadata.bot` mutex preserves parallelism without cross-claim | **supported** (Session 4 — both axes proven: same assignee + different bot promotes concurrent; same bot serializes across assignees) |
| A5 | Spawn stand-in injects per-card MC env from `data/bots/<bot>.yaml` | **supported** (Session 4½ — 12/12 contract tests across lookup / failure / precedence) |
| A6 | Per-card scope reset improves multi-domain completion | untested — scaffold ready (Session 5a); resolves in 5b live trial |
| A7 | Wheat-walkthrough graph exposes wide-flint paralysis | untested — same as A6 |

## Locked-in choices (decisions baked into the plan)

| # | Decision | Choice |
|---|---|---|
| 1 | pytest marker name | **`colony`** |
| 2 | Concern 5 bot registry naming | **Target roster names** (`pip` on :3005, `zee` on :3006), entries in `data/bots/<bot>.yaml`; isolation by world (landfolk-test only), not by name |
| 3 | Capstone scheduling | **Manual** for the first trial; revisit nightly only after shape is stable |
| 4 | Concern 2 variant 1 harness | **Documented-manual** for now; build a `@pytest.mark.integration` runner only when a second integration candidate appears |
| 5 | Capstone card graph source | **Walkthrough graph (hand-authored)** from `example-wheat-farm-walkthrough.md`. `@planner` LLM loop is NOT used for capstone |

The architecture's *strategic* value is in **system dynamics with multiple agents cooperating** to handle long-context heterogeneous work where single-session wide agents hit decision paralysis. This plan validates the mechanisms that make that work — completion predicates, blocker/review loops, per-bot mutex — using harnesses already in the repo, without disturbing existing tests or CI.

## Operating rule

After every session, answer one question:

> *Did this session reduce uncertainty about a key assumption enough to justify the next session?*

If no — **pivot** scope, mechanism, or hypothesis before continuing. Sunk-cost progression into Sessions 4–5 because Sessions 1–2 were "done" is the failure mode this rule exists to prevent.

## Architecture assumptions under test

This plan exists to support or contradict these statements. Update statuses as evidence comes in; pivot when any becomes *contradicted* or stays *inconclusive after a full session*.

| # | Assumption | Tested by | Status |
|---|---|---|---|
| A1 | `mc verify` predicate shape is expressible and stable across card variants | Concern 2 | untested |
| A2 | Card body `success_when`, `mc verify`, and epic `acceptance` reconcile to one done-ness vocabulary | Concern 2 + capstone | untested |
| A3 | Block → review → unblock loop reduces operator micromanagement vs vague blockers | Concern 4 | untested |
| A4 | `metadata.bot` mutex preserves parallelism without cross-claim | Concern 5a | untested |
| A5 | Spawn stand-in faithfully injects per-card MC env from `data/bots/<bot>.yaml` | Session 4½ | untested |
| A6 | Per-card scope reset improves completion reliability on multi-domain tasks | Capstone | untested |
| A7 | The wheat-walkthrough graph exposes wide-flint decision-paralysis failure mode | Capstone | untested |

## Proof vs demo discipline

Architecture decisions are made on **proof** artifacts — deterministic, reproducible, low-infra (plugin tests with in-memory DB, contract tests against proto kanban DB, Tester + rcon-driven assertions). **Demo** artifacts (LLM in the loop, multi-bot wall time, capstone narrative) are *evidence* but never the proof. Treat noisy LLM-based outcomes as suggestive, not decisive.

This principle is concrete in Concern 5 (5a is proof, 5b is demo) and the capstone (acceptance via `mc verify` is proof; "colony vs flint" wall-time is demo). Apply it generally.

## Use two harnesses, kept separate

| Layer | Harness | Used for |
|---|---|---|
| **MC world-true behavior** | `landfolk-test` world + Tester bot on :3004, fixtures via `data/test-fixtures/*.yaml` | Predicate verification, chest state, region predicates — Minecraft physics matter |
| **Hermes orchestration** | `prototypes/agent-arch/`, `HERMES_HOME=~/.hermes-proto-agent-arch`, tenant `proto-agent-arch`, mock bot :3091 | Card flow, parent metadata, blocker/unblock loops — kanban DB matters |
| **API + plugin contracts** | `bot/test/` (Node), `plugins/landfolk/tests/` (Python), `prototypes/agent-arch/tests/` (Python) | `mc verify` grammar, response envelope shapes, gate-check + hooks — no infra needed |

Don't merge. Don't put proto-tenant cards on `~/.hermes`. Don't use `flint_bot` in new tests. Don't put colony capstones in `run-functional-fast.sh`. Don't change global `tests/conftest.py` to require colony POIs.

## Smallest safe slice (Session 1)

Goal: prove the testing pattern with **zero risk to existing tests and CI**.

Deliverables:

1. **`colony` pytest marker** in `pyproject.toml`, excluded explicitly from `run-functional-fast.sh` and `run-functional-full.sh`:
   ```
   functional and not slow and not integration and not colony
   ```
2. **`tests/colony/`** tree + README: arena prep, Tester start, `pytest -m colony` instructions.
3. **`data/test-fixtures/colony/C0_colony_arena.yaml`** — applied via `scripts/run-fixture.sh`, NOT autoused. Defines POI signs/blocks at `:base_anchor:`, `:storage:` (chest), `:test_mine:`, `:test_lookout:`, **plus a post-prep step that issues `mc mark` calls** so the marks are queryable via `mc marks` on Tester (rcon-set blocks alone aren't enough — cards resolve `:marks:` through the bot's marks API per `agent-navigator.md`). Symmetric cleanup.
4. **`tests/colony/test_chest_delta_predicate.py`** — proves chest-delta done-ness (Concern 2 variant 3) end-to-end via Tester + rcon. One test; one assertion that matters; pattern the rest of Concern 2 copies.
5. **`prototypes/agent-arch/automation/telemetry.py`** — tiny JSONL emitter with a stable schema (`run_id`, `cards_created`, `cards_completed`, `cards_blocked`, `wall_time_s`, `per_card_retries`, `manual_interventions`). Sessions 4 and 5 use it; Session 1 lands it so later comparisons share format. Don't build a dashboard yet.
6. **Regression kept green:** `prototypes/agent-arch/tests/test_handoff_contract.py` continues to run on the proto pytest invocation. Cheap orchestration coverage; protects multi-card chains.

~½ day.

## Concerns to validate

### Concern 2 — Done-ness predicates

Three variants, three harnesses. Variant 1 is **observational evidence**, not a regression test:

| Variant | Predicate | Harness | Tier | Status |
|---|---|---|---|---|
| 1 | Vague (`"complete when done"`) — expect AUTO_STUCK | `@pytest.mark.integration` on proto tenant + LLM in the loop; manual capture only | Manual | Observational; runtime-dependent — don't treat as regression |
| 2 | Object-state (`"chest at :storage: contains ≥4 cobblestone"`) | `tests/colony/` + Tester + rcon-driven chest state | Tier 3 | Deterministic regression |
| 3 | Delta (`"chest delta ≥4 cobblestone vs start"`) | `tests/colony/` + Tester + rcon snapshot before/after | Tier 3 | Deterministic regression |

**Builds:** `mc verify <predicate>` helper as Tier 1 contract in `bot/test/`; `tests/_lib/chest_nbt.py` already exposes chest state for the colony assertions.

**Vocab map (A2):** one colony test should `mc verify` an item that *also* appears on a stub epic's `metadata.acceptance` list. The colony README includes a one-page table mapping `success_when` ↔ `mc verify` ↔ `acceptance`. Outcome of this concern updates A1 and A2.

### Concern 4 — Blocker / review loop

**Harness:** `prototypes/agent-arch/tests/test_overseer_contract.py` — pure kanban DB assertions, no Tester needed.

**Experiment:** scripted `kanban_block` with **structured block reasons** matching `board-dynamics.md` § hygiene prefixes (`resource_not_found:`, `nav_needs_<role>:`, `dead_mid_card:`) → minimal `@overseer` stub that subscribes to `kanban.events` and files a `[REVIEW]` card → **operator-comment-stub is a pytest fixture writing `kanban_comment` + `kanban_unblock`** → confirm the chain resumes with parent metadata intact.

**Scope:** incident review only. Epic-completion acceptance is bridged via `mc verify` in the capstone, not via a full LLM overseer.

**Build:** minimal `@overseer` profile in proto `HERMES_HOME`. Bot-less. No production deploy. Outcome updates A3.

### Concern 5 — Per-bot mutex on `metadata.bot`

Both `gate.py` AND `hooks.py` key on `assignee` today. Extending only gate-check leaves the dimension half-extended.

| | 5a: Plugin mutex **proof** | 5b: Live two-bot **demo** |
|---|---|---|
| Harness | `plugins/landfolk/tests/test_gate.py` + `test_hooks.py` | `tests/colony/` with two Tester-style bots + LLM |
| Backend | In-memory SQLite, no MC, no LLM | Real bots + LLM cards |
| Asserts | Two cards with `assignee=navigator` and different `metadata.bot` promote concurrently; same `metadata.bot` serializes | Wall-time gain vs sequential (qualitative — LLM variance can swamp small wins) |
| Decision weight | **Architectural** | Suggestive only |

5a is the deliverable that updates A4. 5b is a demo on top of 5a, not its proof.

**Bot registry:** `data/bots/<bot>.yaml` (the architecture's canonical surface per `bots-and-mc.md`), using target-roster names (`pip` on :3005, `zee` on :3006) on dedicated landfolk-test ports. Closer to production semantics; isolation by world, not by name.

**Build:** `gate.py` + `hooks.py` extended to read `metadata.bot` when present, falling back to `assignee`. Plugin tests are the deliverable.

### Session 4½ — Spawn stand-in (test seam, not production code)

**Why this session exists at all.** Session 4 proved the *kanban-side* of `metadata.bot`: two cards with the same Hermes profile (`assignee=navigator`) and different bots (`pip` vs `zee`) live in distinct mutex domains, and two cards with the same bot across different assignees serialize. That's half the story. The architecture's *other* half is that when each of those cards runs, the spawning worker must talk to the *right Mineflayer bot* — `pip` lives on port 3005, `zee` on 3006. Without per-card env injection, both workers would talk to whatever port the profile's static `.env` pinned, the cards would step on each other in-world, and the mutex extension would prove nothing useful in practice.

The production solution to this is **Section F of `impact.md`** — a Hermes spawn hook that reads `metadata.bot` from the claimed card and injects `MC_API_URL` / `MC_USERNAME` into the worker's environment before exec. That's months of work and touches Hermes-the-product. We're not building it now. We're building the *minimum test seam* that proves the contract such a spawn hook would have to honour.

**What we are testing.** The unit under test is a contract, not code:

> Given a card with `metadata.bot=<name>` (today encoded as `[bot:<name>]` title prefix), the worker that spawns to run that card sees `MC_API_URL` and `MC_USERNAME` env vars derived from `data/bots/<name>.yaml` — not from the profile's static `.env`.

Three things we verify:

1. **Lookup correctness.** Given `metadata.bot=pip` and a fixture `data/bots/pip.yaml` with `api_port: 3005, username: pip`, the seam exports `MC_API_URL=http://127.0.0.1:3005` and `MC_USERNAME=pip`. Same for `zee` → 3006. Wrong key → `data/bots/<unknown>.yaml` missing → script exits non-zero (so a misconfigured card fails loudly instead of running on the wrong body).
2. **Precedence.** When the seam runs a child process, the exported `MC_API_URL` overrides any profile-level `MC_API_URL` already in scope. This mirrors `bot/cli/api-url.mjs`'s precedence rule and is the property Section F will need.
3. **Replaceability.** The contract test is written against the *contract*, not the script. When Section F lands, the same test should pass against the real spawn hook by swapping the invocation; nothing downstream of the env vars couples to `spawn-with-bot.sh`.

**What we are NOT testing here.** No real Hermes worker, no LLM, no Minecraft. The capstone (Session 5) is what proves the contract pulls its weight under load. This session only proves the contract *exists* and *is honoured* by something testable.

**Deliverables.**

- `scripts/colony-validation/spawn-with-bot.sh` — reads `metadata.bot` (via `hermes kanban show --json` against the proto tenant, or accepts it as an arg for direct testing), looks up `data/bots/<bot>.yaml`, exports `MC_API_URL` + `MC_USERNAME`, then `exec`s the rest of its args as the worker invocation. Fails non-zero on missing card / missing bot file / missing required yaml fields.
- `data/bots/pip.yaml` and `data/bots/zee.yaml` — `api_port`, `username`, optional `notes`. Schema documented inline with comments, matching the canonical surface from `bots-and-mc.md`.
- `prototypes/agent-arch/tests/test_spawn_seam_contract.py` — the contract test. Three classes of assertion: (a) given a known card metadata, env vars match; (b) given an unknown bot, exit code is non-zero and stderr names the missing file; (c) given a profile env that already sets `MC_API_URL`, the child sees the seam's value (precedence). Implemented by exec'ing the shell script with `env -i` plus controlled inputs, capturing the child's environment with a `python -c 'import os, json; print(json.dumps({k: os.environ[k] for k in ("MC_API_URL","MC_USERNAME")}))'` victim.

**Pivot triggers.** If the script-layer approach turns out to need state that only Hermes has (e.g. claim metadata not visible via CLI), escalate to a design issue for Section F before continuing — don't paper over it. If `data/bots/<bot>.yaml` ends up needing fields we haven't thought through (auth, model pinning, world-id), pause and write the schema first; the schema decision deserves its own thought.

Outcome updates A5. ~¼ day.

### Capstone — Wheat farm (manual / `colony`-marked only)

Maps to your hundreds-of-hours observation. Wide flint with a multi-domain body hits decision paralysis; the colony chain should not.

**Freeze rule.** The capstone's **first** run uses the architecture exactly as specified: walkthrough graph + hand-bound `metadata.bot` + `mc verify` against `metadata.acceptance` + Session 4½ spawn stand-in. **No new architecture elements added during the trial.** If we discover something's missing while running, **stop**, file it as a separate session, then re-run from scratch. This prevents the capstone from absorbing every unresolved moving part.

**Card source:** base the chain on the [`example-wheat-farm-walkthrough.md`](../docs/architecture/example-wheat-farm-walkthrough.md) card graph (4–6 execute cards) using `dispatch.py` with explicit `[parents: …]` syntax in the runner script. Running the architecture's *own example* validates the doc more honestly than running a `@planner` we haven't built.

**`@dispatcher` stand-in:** cards are hand-bound to `metadata.bot` in `dispatch.py`. Lexicographic bind is deferred; called out in the runner.

**Wide baseline:** the wide control is the **same decomposed body** written into a single flint card. This collapses three confounds (multi-card vs wide-catalog vs legacy assignee) into one. Anything else would be unfair.

**Acceptance gate:** `mc verify` against `metadata.acceptance` (3 tilled plots, 4 wheat each, water source, sign). Bridges Concern 2 → Concern 4 → capstone. Updates A2 + A6.

**JSONL metrics** (via Session 1's `telemetry.py`): `run_id`, `cards_created/completed/blocked`, `wall_time_s`, `per_card_retries`, `manual_interventions`. Dashboard-spec fields can be added later; don't overbuild now.

**Confound table — outcome maps:**

| Outcome | Conclusion | Updates |
|---|---|---|
| Both complete, similar wall time | Architecture value isn't in cost or completion. Strategic claims (parallelism, evolution) must justify on their own. | A6 → inconclusive; A7 → contradicted |
| Colony completes; flint blocks | Narrow-scope claim supported on multi-domain work. Confounds: chain pattern vs per-card bundle vs dispatch latency. | A6 → supported; A7 → supported |
| Flint completes; colony struggles | Chain orchestration cost exceeds scope-reset benefit. Architecture needs rethinking on granularity. | A6 → contradicted |

## Explicit non-goals

- POC win-condition metrics from `target.md` (tokens / turns / time at completion as success). **Intentional deviation:** we validate mechanism correctness, not POC win. Cost claim stays "narrow wins on single-phase nav" from the [clean comparison](./2026-06-06-clean-comparison.md).
- DSL shapes 3+4 (parser-level). Capstone uses hand-authored graphs.
- Comments as inter-agent protocol beyond Concern 4 needs.
- Artifact references / blueprints — needs `workspaces.md` to settle.
- Recall stream — `data-api.md` mostly unbuilt.
- Self-improvement loops — year-long bet, not a measurement.
- Auto-stuck-check tuning — parameter knob, revisit per task type.
- Full Section F spawn layer — Session 4½ is script-layer stand-in only.
- Dashboards — JSONL is enough until comparisons stabilize.

## Sequencing with pivot gates

After each session, evaluate **Binary success** and decide **Go / Pivot / Stop**.

| # | Session | Deliverable | Binary success | Pivot if… | Time |
|---|---|---|---|---|---|
| 1 | Foundation | marker + tests/colony tree + C0 fixture (with `mc mark` post-prep) + chest-delta test + telemetry.py + handoff regression green | Test green AND `run-functional-fast.sh` byte-identical AND chest-delta fires correctly on Tester | Existing tests break → restructure marker; rcon chest state doesn't survive → reframe fixture | ~½ day |
| 2 | Done-ness | `mc verify` Tier 1 + variants 2/3 tests + done-ness vocab map | `mc verify` parseable; variants 2+3 deterministic | `success_when` ↔ `mc verify` ↔ `acceptance` can't map → reframe vocabulary; Tier 3 chest state too flaky → fall back to region predicates | ~½ day |
| 3 | Blocker/review | `@overseer` stub + blocker contract test with structured reasons | Block → review card → unblock → resume; all observable in kanban DB events | Stub can't subscribe to events → fall back to polling; structured reasons don't map to `board-dynamics.md` hygiene → file mapping issue | ~1 day |
| 4 | Mutex 5a | `gate.py` + `hooks.py` extension + plugin tests in-memory | Both files' tests pass: different `metadata.bot` promotes concurrent, same serializes | `hooks.py` extension is deeper than expected → split into separate session; `metadata.bot` semantics conflict with assignee → escalate to design | ~1 day |
| 4½ | Spawn seam | `spawn-with-bot.sh` + `data/bots/*.yaml` + contract test for the seam | Contract test asserts env exported correctly for a sample `metadata.bot` input | Script-layer hack too brittle → escalate to env-passthrough config; `data/bots/<bot>.yaml` schema underspecified → design first | ~¼ day |
| 5 | Capstone | runner from walkthrough graph + first wheat trial + JSONL metrics + confound doc update | Outcome categorizable via the confound table; A6 and A7 status updated | Too many moving parts noisy → freeze tighter and re-run; flint's decomposed-body baseline doesn't reproduce paralysis → re-examine the wide-control design | ~1½ days |

**Total: ~5 days.** Each session has an exit criterion; pivots are explicit choices, not "we'll figure it out next time."

## Anti-patterns

- ❌ Proto-tenant cards on `~/.hermes` (use `HERMES_HOME=~/.hermes-proto-agent-arch`)
- ❌ Using `flint_bot` in new tests (use Tester :3004 or a new colony role)
- ❌ Adding `@pytest.mark.integration` colony tests to `run-functional-fast.sh`
- ❌ Global `tests/conftest.py` changes requiring colony POIs for *all* functional tests
- ❌ New `metadata.bot` work touching `landfolk-ops` production tenant
- ❌ Capstone in CI — manual / scheduled only
- ❌ Capstone with prose decomposition treated as "architecture worked" — must be walkthrough graph
- ❌ Capstone with flint's "single card" meaningfully different from the decomposed body — confound, not control
- ❌ Treating Session 4½ spawn stand-in as a production Section F replacement
- ❌ Adding new architecture elements *during* a capstone run — freeze rule
- ❌ Treating Concern 5b demo wall-time as the parallelism proof — 5a is the proof
- ❌ Treating Concern 2 variant 1 as a regression — it's runtime-dependent observation

## Ready to execute

Sessions 1–4 complete (commits `80e2b2b`, `be2d6ca`, `225f8e1`, `3c3fc4b`). A1–A4 moved from *untested* to *supported* — every mechanism the architecture asks for in the kanban + predicate layer has a test backing it.

Next action: execute **Session 4½** — `scripts/colony-validation/spawn-with-bot.sh` + `data/bots/{pip,zee}.yaml` + `prototypes/agent-arch/tests/test_spawn_seam_contract.py`. The seam is a test-only stand-in for Section F; the contract it proves is what Section F will have to honour. Then Session 5 (capstone) is ready to run with all dependencies present.

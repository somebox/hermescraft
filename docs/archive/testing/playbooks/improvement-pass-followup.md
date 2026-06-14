# Followup improvement pass: playbook adoption + envelope honesty

> **Closed 2026-05-31.** Summary, preserved artifacts, and successor direction:
> [`improvement-pass-closure.md`](improvement-pass-closure.md).
> This file is the **historical plan and worklog**; do not treat open “next steps”
> below as active work unless revived explicitly.

Status: **closed** (Wave 5 + Wave 6 complete; Stage 3 catalog expansion
withdrawn; Stage 4 genesis gate deferred). Successor: procedural test worlds +
skills/primitives/collaboration iteration — see closure doc.
to [`route-precompute-context.md`](../../specs/nav/route-precompute-context.md) and
[`observation-verb-grammar.md`](../../specs/mc/observation-verb-grammar.md). The
playbook orchestration spec is in
[`design-composable-playbooks.md`](design-composable-playbooks.md); the eventual runtime substrate
is in [`agent-scripting-layer.md`](../../specs/agent/scripting-layer-dsl.md). Evidence:
g-2026-05-30-3 (`data/genesis-runs/g-2026-05-30-3/findings/`).

## Why this pass

The genesis run made three things concrete:

- **Cards are prose; workers pay for re-interpretation every cycle.** Mason
  re-read the blue_wool card across compactions; Flint re-derived the wood
  collect goal on every session.
- **Bots step into traps because nothing was pre-checked.** Mason dug into
  a 1×1 pit; nothing in his card said "ensure return path stays open." No
  in-flow gate refused "do this card *here, now, with this inventory*"
  before commit.
- **Reasoning waste tracks lack of structure.** Steward orients with
  `mc observe` 83 times and her error rate stays low. Workers freeform;
  nav/dig/collect errors run 41–71 %.

Three localized bugs amplified the waste:
- #54 `mc advise` printed PyYAML and timed out at exactly the stuck moments.
- #56 `mc craft` named the wrong missing ingredient on multi-variant targets.
- #58 the `nav_header` reaching mason-01 said "1 exit" without a direction.

### North star

Agents spend turns on strategy, not mechanics. Every deliverable is judged
on one or more of:

- **(P)** reduces hand-rolled debugging by the agent
- **(D)** makes the tool honest about what it did or didn't do
- **(F)** makes the next failure faster to diagnose

### Evidence vs assumptions

The postmortem of g-2026-05-30-3 supports some of this plan directly and
leaves the rest as testable hypotheses. Honest mapping:

| What the run proves | What the plan proves |
|---|---|
| `mc craft` lied about missing ingredients on multi-variant targets (#56). Mason had `15 blue_dye + 8 white_wool`; the tool said he was missing `black_wool`. Fix the selector and the 4 h loop disappears. | Stage 1 #56 is the direct fix. |
| `mc advise` died on PyYAML at exactly the stuck moments (#54). Two of the worst stuck clusters reached for it; both got disinformation. | Stage 1 #54 is the direct fix. |
| `nav_header` reached mason-01 saying "1 exit" without a direction (#58). | Stage 1 #58 is the direct fix. |
| Worker move/dig/collect error rates 41–71 %; verb-escalation chains (`move→goto→goto_near→hops`) are the dominant hand-roll. | Telemetry confirms; Stage 2 hint injection on `error.next_action_hint` is supported. |
| Mason self-recovered from a 1×1 pit and 25-move NAV_BLOCKED odyssey **without** any playbook. | Self-recovery worked. Structure may help; it's not the proven fix for the 4 h stall. |

The playbook stack (Stage 2 onward) is a **bet on structure reducing
turn waste**. Stage 2's A1–A3 tests are how that bet pays out or doesn't.

### Mental model

```
Stage 0–1:  Make verbs honest + measurable (shipped)
Stage 2a:   Playbook MECHANISM — A1 falsified; A2/A3 pass
Stage 2b:   A4 — sub-play telemetry OK; Flash completion weak
Stage 3:    Broad catalog withdrawn (pass closed)
Stage 4:    Genesis A/B deferred as pass gate
Wave 6:     Granularity lab complete — closure.md
Next:       Procedural test worlds + skills/collaboration library
Later:      agent-scripting-layer Part 1 (regions) when bench demands it
```

The 25-id survival catalog was **withdrawn** with pass closure. Registry
entries remain for agent-tests and optional templates — see
[`improvement-pass-closure.md`](improvement-pass-closure.md).

### Enforcement is LLM discipline this round, not a server gate

`max_turns`, verb whitelist, and phase 0 preflight all rely on the
worker SOUL following the playbook doc. There is **no server gate** in
this round that hard-stops a worker who skips preflight or busts the
whitelist. We measure compliance via JSONL post-checks: did preflight
verbs run before the first `act:` verb? Did the worker stay within the
whitelist? If A2 looks fine on the surface but free-form attempts slip
through, Stage 2c adds a server `mc playbook preflight` endpoint that
returns a hard refusal and prevents the next `act:` verb from
dispatching. **Trigger Stage 2c when any of:** A2 scenario fails;
post-hoc JSONL shows **< 80 %** of playbook-card spans had a
preflight-class verb before the first act-class verb (even when no
refusal fired); or **< 80 %** whitelist compliance per
`(playbook_id, phase)` span; or **≥ 10 %** NULL-playbook-context on
sync rows during playbook cards (A2c). We ship the discipline form first because
it's smaller and tests whether the prompt structure alone is enough.

### Signal isolation (interpretable Stage 2a)

Stage **2a-S (substrate)** lands first: registry (with `phases[]` verb
lists), kanban validation, `playbook phase set/clear` → `ctx.runtime`,
JSONL chokepoint, **regenerate-artifacts** skill copy,
**nav-telemetry --compliance** — **no A1 until 2a-S is green.** Stage
**2a-V (validation)** adds flat playbook doc, SOUL + kanban-worker,
mining #51–#55, then agent-test A1–A3 using shared card-body includes.

**`hintFromBrief()` is Stage 1**, not 2a (envelope-honesty family with
#58). A1 must answer only: *did routing + checkpoint structure change
worker behavior?* — not confound with new failure-path hint logic.

If A1 misses after a clean 2a-S + 2a-V ship, treat the result as
*"structure isn't enough"* rather than *"one of seven changes was
responsible."*

### The pivot

Cards become **playbook references** — Steward attaches `playbook: <id>` +
inputs, the worker SOUL walks the playbook's phase table, checkpoint state
persists as a kanban comment for resumability. Full schema and worked
example in [`design-composable-playbooks.md`](design-composable-playbooks.md). No new bot-side
runtime this round; only a small registry + a telemetry-context verb +
SOUL discipline + one fully written playbook.

This addresses every waste source named above with what already exists:

| Waste source | How playbooks fix it |
|---|---|
| Card re-interpretation | Steward writes id + inputs, not prose; phase table is shared procedure |
| Stepping into traps | Phase 0 preflight rows run before any `act:`; refusal envelope before commit |
| Lack of situational awareness | `verify:` rows per phase prove the act succeeded |
| Recovery hand-rolling | `branches:` table keys off `error.code` + `error.next_action_hint` |
| Some discovery preserved | `verb_whitelist` + `max_turns` per phase = bounded improvisation |
| Verifiability | Each phase's `verify:` is an objective predicate |
| Debuggability | Per-phase `playbook_id` + `phase` (+ `sub_playbook_id` when composed) on JSONL telemetry rows |
| Resumability across worker restarts | `[run_state]` checkpoint in kanban comment |

## Architecture in one picture

```
       Steward (v4-pro for plan-author turns only)
            │ chooses playbook id from registry, fills inputs
            ▼
       kanban card body
         playbook: wood.chop_tall_tree
         inputs: { … }
            │
            ▼
       Worker (v4-flash, SOUL walks phase table)
            │ at each phase boundary:
            │   mc playbook phase set <id> <phase>
            │   (stored on ctx.runtime on the bot server, NOT subprocess env)
            │   walk phase: preflight → act → verify
            │   on success: append [run_state] checkpoint comment
            │   on card complete: mc playbook phase clear
            │   on hard failure: consult branch table; checkpoint with last_error
            ▼
       ┌────────────────────────────────────────────┐
       │ Verb registry (today's mc taxonomy)        │
       │  returns P9 ok()/fail() envelopes          │
       │  error.next_action_hint string feeds       │
       │  the playbook's branch tables               │
       └──────────────┬─────────────────────────────┘
                      │
            bot ↔ world (mineflayer + Paper)
                      │
       ┌──────────────▼─────────────────────────────┐
       │ Telemetry chokepoint                        │
       │  task-lifecycle.js → metrics.logNavEvent    │
       │  per-row: playbook_id + phase from           │
       │  ctx.runtime.playbook_context (not env)     │
       └────────────────────────────────────────────┘
```

Three guarantees:

1. **One mutation surface.** Every `act:` runs through the existing verb
   registry. No new mutation path; operator denies still apply; P9
   action contract unchanged.
2. **Procedure as data + doctrine, not code.** Playbook phase tables are
   markdown the worker reads via `skill_view`. The runtime is the
   worker SOUL — no bot-side engine in v1.
3. **Resumability is free.** Checkpoints live in kanban comments, a
   store that already exists. A worker reclaimed mid-phase resumes the
   next at the last clean phase boundary.

## Delivery plan

Five stages. Each ships independently; later stages assume earlier
stages but never require them. Each stage has a **bot-unit-test gate**
(fast, `cd bot && npm test`) and a **scenario gate** (slow, bot + world).

### Tooling consolidation

Keep analysis and gates in **existing entry points** — avoid a sprawl of
one-off scripts.

| Capability | Owner | Notes |
|---|---|---|
| Live JSONL, playbook aggregation, **compliance** | **`scripts/nav-telemetry.py`** `--live`, `--playbooks`, `--compliance` | Reads registry YAML `phases[]` only. Reports **three** post-checks per playbook-card span: (1) preflight-before-first-act ≥ 80 %, (2) whitelist ≥ 80 %, (3) **NULL-playbook-context** — share of sync `mc` rows during playbook work with no `playbook_id` on JSONL (silent skip of `phase set`); Stage 4 target **< 10 %** NULL rows |
| Genesis + fixture **baselines** | Same script: **`nav-telemetry.py --baseline-turns <run_id>`** | Writes `findings/baseline-turns.md` with **two sections:** (1) g-2026-05-30-3 genesis aggregate, (2) fixture A1 medians filled after 2a-V. Stage 4 A1 **% target TBD** until both exist |
| Playbook doc → worker skill copy | **`scripts/regenerate-artifacts.sh`** step | Copies registry `doc:` → `skills/playbook-<slug>.md`, updates `skills/MANIFEST` |
| Registry lint, stress YAML, skill hash drift | **`scripts/check-conventions.mjs`** + **`bot/test/playbook-registry.test.js`** | No separate sync or compliance scripts |
| Stress routing | **`scripts/stress.sh`** | Delegates to `run-fixture.sh` / L3 or `agent-test.py` |
| A1 card-body parity | **`data/agent-tests/playbooks/includes/chop-oak-8/`** | Three shared body fragments included into agent-test YAML so prompts match kanban card bytes |

### Stage 0 — Foundation (substrate)

Unchanged from the prior draft. Playbooks depend on the same envelope +
telemetry chokepoint as freeform verbs.

| Deliverable | Where | Bot unit test |
|---|---|---|
| Internal `Envelope<T>` + `envelope.fromAction(actionResult)` adapter | new `bot/lib/shared/envelope.js` | adapt `ok()`/`fail()` shapes from `action-contract.js`; round-trip P9 `next_action_hint` string |
| `envelope.formatSuggested(suggested_next)` serializer | same file | structured `{verb, args, why}` → validator-safe one-line string |
| `logNavEvent(record)` JSONL writer — **v1 schema** (`schema_version`, `actionName`, `ok`, `error.code`, optional `playbook_id` / `phase` / `sub_*`) | extend `bot/lib/runtime/metrics.js` (mirror `logEquipRecovery`) | unit test: append to `nav-<profile>.jsonl` honoring `HERMESCRAFT_TMP`; golden line matches schema |
| Chokepoint emit (**sync POST actions only**); read `playbook_id` / `phase` from `ctx.runtime.playbook_context` (set by **`mc playbook phase set`**, cleared by **`mc playbook phase clear`** or **auto-clear when `ctx.runtime.taskContext.card_id` changes** — see **Playbook context lifecycle** below) | `bot/lib/server/middleware/task-lifecycle.js` after `pushAction` (~L248); use `actionName` | mock `actionFn` returning `ok()` and `fail(...)`; one JSONL line per outcome. **Async `bg_*` omitted this round.** |

#### Playbook context lifecycle (auto-clear)

The bot server does **not** poll kanban. It learns the active card from
existing **`mc task_context set`**, which POSTs `/task-context` with
`card_id` from **`HERMES_KANBAN_TASK`** (or `--card` override) — see
`bot/cli/dispatch.mjs` and `bot/lib/server/http-app.js`.

**Rules (2a-S):**

1. **`mc playbook phase set`** copies the current `taskContext.card_id`
   onto `playbook_context.card_id` (if task context is missing, phase
   set fails fast with a clear code — worker must bind card first).
2. **Auto-clear `playbook_context`** when `POST /task-context` sets a
   `card_id` **different** from `playbook_context.card_id` (new claim,
   reclaim, or wrong-card leak).
3. **Explicit clear:** `mc playbook phase clear` and worker SOUL on
   `kanban_complete` / `kanban_block`.
4. **Reclaim same card:** same `card_id` → playbook context is **not**
   cleared by task_context; resuming worker calls `phase set` from
   `[run_state]` (A3).

Playbook-card SOUL (2a-V): after claim, `mc task_context set …` (worksite
if any) so `card_id` is bound **before** the first `playbook phase set`.
| Stress runner `scripts/stress.sh <scenario>` — thin orchestrator (see **Stress testing harness**) | new (~minimal bash) | `noop` scenario runs in ≤30 s |
| Extend **`scripts/nav-telemetry.py`**: `--live`; **`--baseline-turns <run_id>`** (genesis baselines → `findings/baseline-turns.md`, two sections) | existing script | reuse session-walking patterns from `stuck-scenarios.py` internals where helpful — **no new baseline script** |

**Deferred to 2a-S (registry must exist first):** `nav-telemetry.py --playbooks --compliance` (preflight-before-act %, whitelist % from registry YAML).

**Out of Stage 0:** async chokepoint; log rotation; standalone `playbook-compliance.py` / `baseline-turns.py`.

**Parallel work.** Stage 1 (#56/#58) does not require Stage 0 envelope/JSONL; only scenarios whose pass criteria mention JSONL need the chokepoint first.

**Gate.** Bot unit tests green; `scripts/stress.sh noop` passes.

### Stage 1 — Stop the lies (three localized bugs)

Unchanged. Playbooks depend on honest primitives; these three are the
worst current liars.

| Task | Fix | Impact |
|---|---|---|
| **#54** advise | Regex-parse the config subset (mirror `tests/_lib/openrouter.py`); suppress the spurious PyYAML warning; reconcile the latency mismatch (90 s OpenRouter vs 30 s shell) by reducing the OpenRouter timeout for `advise` only | **(D)** advise becomes usable at stuck moments and inside bounded-improvise phases |
| **#56** craft selector | Shared `pickRecipeForCraft(b, name, count) → {recipe, invocations, plan}`. Per-variant `ceil(count / variant.result.count)` scoring; on tie, prefer the variant whose canonical ingredient matches a held item. `mc craft` and `mc craft_plan` call the same helper | **(D)** craft stops naming wrong missing ingredients on multi-variant targets (beds, plank-specific doors); `craft.from_inputs` playbook is safer |
| **#58** `nav_header` suggested direction | Add server-side `nav_header.suggested_hint: string` populated by `buildNavFrame` from cheap local-geometry (open-direction + nearest mark), independent of brief mode. `formatNavFrameLine` prints it after exit count | **(D)** mason-01 pattern (exit count without direction) when the compact header is all workers see |
| **`hintFromBrief()` injector** — allowlist + dedup | failure paths on move/goto/collect/craft; codes `{NAV_BLOCKED, NAV_TARGET_UNSTANDABLE, BOT_ON_PILLAR, MISSING_INGREDIENTS}`; **Stage 1 dedup key:** `(profile, actionName, code)`; after 2a-S when `playbook_context` present, extend to `(playbook_id, phase, code)`. Nav brief off → #58 fallback only | **(D)** ships before 2a-V A1; same hint layer on all three A1 arms |

**Bot unit-test gate:** `crafting.test.js` tie-break + `pickRecipeForCraft`;
new `L3.xx_craft_bed_variant`;
`cli/output.test.js` snapshot of `mc status` with
`nav_header.suggested_hint`; `prompts-sync.test.js` stays green;
`mc-advise-cli` smoke test asserts no PyYAML warning on stderr.

**Scenario gate:**
- `advise-on-stuck`: response in ≤ 25 s; no PyYAML warning on stderr.
- `recipe-bed-variant`: agent crafts `blue_bed` from `white_wool` +
  planks in ≤ 2 tool calls; no `MISSING_INGREDIENTS` naming the wrong
  wool color.
- **`craft-post-56-blue-wool` (run immediately after Stage 1, do not
  wait for Stage 3):** bot or L3 fixture with Mason's postmortem
  inventory (`15 blue_dye + 8 white_wool`); craft `blue_wool` ×8 in ≤ 2
  tool calls with #56-fixed selector. Validates the 4 h loop root cause
  before playbook catalog work.

### Stage 2a — Flat playbook adoption (mechanism test, A1–A3)

Goal: prove the playbook **routing** layer with **one flat playbook**
(`references_skill:` for procedure). **Composition (sub-plays) and A4
are gated to Stage 2b on 2a-V wins.**

**2a-S — Substrate (ship before A1).** Mechanical surfaces only:

| Deliverable | Where |
|---|---|
| Playbook id registry + lint | `data/playbooks/registry.yaml` with **`phases[]`** per id: `id`, `preflight_verbs`, `allowed_verbs` (machine source for compliance — markdown doc is human-readable only) | `check-conventions.mjs`, `playbook-registry.test.js` |
| Kanban `playbook:` validation | kanban facade + `kanban-card-schema.test.js` |
| `mc playbook phase set` / `phase clear` → `ctx.runtime` | bot actions + CLI + `playbook-phase-set.test.js`; requires bound `taskContext.card_id`; **auto-clear on card id change** (see Playbook context lifecycle) |
| Playbook doc → skills | **`regenerate-artifacts.sh`** (not a new top-level script) + MANIFEST |
| Compliance reporting | **`nav-telemetry.py --playbooks --compliance`** (lands with first registry that defines `phases[]`) |

**2a-V — Validation (after 2a-S green).** Hypothesis test surfaces:

| Deliverable | Where | Impact |
|---|---|---|
| First playbook — **flat form** | `docs/testing/playbooks/catalog/wood-chop-tall-tree.md`: phases + `references_skill:` → mining skill; **no `use_playbook:`** | **(P)** routing + checkpoint + verify |
| Card-body + `[run_state]` | kanban docs + checkpoint format | **(F)** resumability |
| Worker SOUL + **kanban-worker** | `worker.md`, `kanban-worker.md`: top-level `playbook:`, phase-set ritual, pass-back for A2 | **(P)** turn-1 visible |
| Mining-skill cleanups (#51–#52–#53–#55) | `minecraft-mining.md`, collect UX if code | fair A1 vs prose-skilled (same skill both sides) |

**Removed from 2a:** `hintFromBrief` (Stage 1).

**Bot unit-test gate:**
- `bot/test/playbook-registry.test.js`: registry round-trip
  (every id has a doc; every doc has front-matter `playbook: <id>`).
- `bot/test/playbook-phase-set.test.js`: after `mc playbook phase set`,
  subsequent sync verb's JSONL row carries `playbook_id` + `phase` from
  `ctx.runtime` (not subprocess env); `phase clear` removes them.
- `cli-action-sync.test.js`, `actions-manifest.test.js`, `cheatsheet-sync.test.js` after new verbs.
- `scripts/check-conventions.mjs`: phase-table lint (standard columns)
  on the one shipped playbook.
- `bot/test/kanban-card-schema.test.js`: card-create with unknown
  `playbook:` id is rejected.
- `prompts-sync.test.js` after worker SOUL edits.
- `cheatsheet-sync.test.js` after the one new verb.

**Scenario gate (Stage 2a — assumptions A1, A2, A3 only):**

- **A1 — playbook routing beats prose on waste.** `chop-prose-vs-playbook`:
  same goal (`[SUPPLY] 8 oak_log`) authored **three** ways for a fair
  baseline:
    - **Prose-minimal:** title + coords only. No skill reference.
    - **Prose-skilled:** title + coords + explicit "follow `skills/minecraft-mining.md § Production workflow`".
    - **Playbook:** `playbook: wood.chop_tall_tree`, the registry
      resolves to the same skill section via `references_skill:`.

  Run each ≥ 5 times via **`agent-test.py`** using shared bodies from
  `data/agent-tests/playbooks/includes/chop-oak-8/` (prose-minimal,
  prose-skilled, playbook fragments — same goal bytes every run). Model +
  `--max-turns` pinned to worker defaults. Archive under
  `findings/a1-chop-prose-vs-playbook/` with **card-body content hash**
  in each report JSON. **Primary metric:** tool calls to card close;
  turns secondary. **Pass:** playbook averages ≤ both prose baselines on
  tool calls AND tool errors. **Fail:** within 10 % of prose-skilled or
  50 %+ worse. Fill fixture medians into `baseline-turns.md` § fixture;
  Stage 4 A1 **% target TBD** from that section after review.
- **A2 — preflight discipline catches traps (LLM honor system).**
  `chop-preflight-refuses`: fixture removes the axe before card claim.
  **Pass (scenario):** structured `kanban_block` with
  `prep_required_unmet:axe`; no approach act before preflight.
  **Pass (counterfactual, all playbook cards on JSONL):** ≥ **80 %** of
  spans show a preflight-class read-only verb before the first act-class
  verb — even when the worker did not refuse. Silent skip + mid-act
  crash counts as compliance failure, not “normal failure.” **Fail A2
  scenario** or **< 80 % counterfactual** → consider Stage 2c.
- **A3 — checkpoint resume works.** `chop-checkpoint-resume`: kill the
  worker after `chopped: 4/8`; respawn a fresh worker on the same card.
  **Pass:** new worker reads the latest `[run_state]` comment, resumes
  the chop loop at iteration 5 with `chopped: 4` carried forward.
  **Fail:** new worker restarts from phase 0 or duplicates work.

**A4 (composition) is deferred to Stage 2b.** Stage 2a is the
mechanism-only proof; composition is the next bet, not bundled.

### Stage 2b — Composition (gated on Stage 2a wins)

Goal: add `use_playbook:` composition only if Stage 2a's A1 and A3
show structure wins. If A1 falsifies (playbook needs more turns than
prose-skilled), STOP — re-evaluate before adding composition.

| Deliverable | Where | Impact |
|---|---|---|
| Sub-playbook **`pillar_up_safe` only** (minimal A4 scope) | `docs/testing/playbooks/catalog/pillar-up-safe.md`; `wood.chop_tall_tree` gains one `use_playbook:` ascend row | composition substrate — **`descend_safe` deferred** until A4 passes |
| `[run_state]` nested `sub:` | comment protocol + worker SOUL | sub-play resume |
| `mc playbook phase set … --sub …` | `ctx.runtime` sub fields + JSONL | parent vs sub attribution |

**Scenario gate (Stage 2b — A4):**

- **A4 — composition works.** `chop-composition`: the new `ascend` phase
  in `wood.chop_tall_tree` invokes `pillar_up_safe`. **Pass:** sub-play
  completes; parent resumes; JSONL rows carry both `playbook_id` and
  `sub_playbook_id`; a deliberate `BOT_ON_PILLAR` in the sub-play is
  recovered by its internal lateral retry, not bubbled to the parent.
  **Fail:** sub-play invocation fails to resolve, parent doesn't
  resume, or telemetry can't distinguish parent from sub. **A4 is the
  load-bearing assumption** — if it falsifies, Stage 3 ships without
  composition (workers don't recurse sub-plays; Steward sequences via
  `--after` instead).

### Stage 2c — Server preflight gate (conditional)

Only if triggers in **Enforcement** fire (A2 fail, preflight-before-act
< 80 %, or whitelist < 80 %). **v0 scope — do not build Layer A DSL:**

- One playbook: `wood.chop_tall_tree`, phase `preflight` only.
- Checks: existing read-only `mc inventory` (and listed preflight verbs
  from registry YAML).
- Effect: block dispatch of registry-listed **mutating** verbs until
  preflight pass recorded on `ctx.runtime` for that phase.

Expand only after v0 proves the gate reduces compliance gaps.

### Stage 3 — Steward as playbook author + playbook library expansion

**Status (post Wave-5):** Broad expansion **paused**. Execute
[`lab-wave-6-granularity.md`](lab-wave-6-granularity.md) W6-T1 first; ship
`build.tower_vertical` only as the lab playbook until results land. Steward
playbook-author SOUL remains deferred except for prose-skilled supply templates.

Goal: Steward stops emitting prose card bodies for patterns covered by
playbooks. **Stage 3.0 (gate):** run **`craft-subcard-file`** and
**`craft-subcard-unblock`** before expanding the catalog — if worker
`kanban_create` is denied, revise `craft.from_inputs` branches to
Steward-only sub-cards before writing seven playbooks.

| Deliverable | Where | Impact |
|---|---|---|
| Steward SOUL: playbook-author doctrine | edit `prompts/landfolk/steward.md`; "pick id from registry, fill inputs; always check inputs against the registry's `required:` list before creating the card"; `prompts-sync.test.js` must pass | **(P, D)** structured cards replace prose for P2/P3/P4 patterns covered by playbooks |
| Steward routing on v4-pro for playbook-author turns | `data/agent-models.json` selective override on the playbook-author code path; cost amortized over many worker invocations | quality of input-fill matters; v4-pro is the right tool for the small number of authoring turns |
| Library expansion (top-level playbooks) | new docs under `docs/testing/playbooks/catalog/`: `mine.underground_target`, `supply.from_chest`, `craft.from_inputs`, `build.repair_site`, `build.tower_vertical`, `farm.passive_mob_chicken` | **(P)** covers the bulk of observed P2/P3 cards; tower + repair + mining reuse `pillar_up_safe` / `descend_safe` already shipped Stage 2 |
| Library expansion (sub-plays) | `docs/testing/playbooks/catalog/recover-stuck.md` joins the catalog; reused by branch tables in `mine.underground_target` and `wood.chop_tall_tree` | **(P)** one named recovery pattern instead of ad-hoc agent reasoning |
| Sub-card dispatch for multi-step gathers | `craft.from_inputs` branch creates `[SUPPLY]` sub-cards; validate **`craft-subcard-file`** then **`craft-subcard-unblock`** before **`craft-blue_wool-sub-cards`** integration | **(P)** decomposed test; #56 already fixed postmortem “had ingredients” case at Stage 1 |
| `mc reach` as primitive | new `bot/lib/actions/movement/reach.js` — thin router over `move`/`goto`/`goto_near` with short-hop retry; available to playbook `act:` rows as `mc reach <coord\|@mark>` | **(P)** absorbs hand-rolled `move`→`goto`→`goto_near` chains when playbook acts use it instead of bare `move` |

**Stage 3 minimum set** = the registry entries above (including
**`scout.resource`** for worker-filed scout sub-cards) + Stage 2b
sub-plays when A4 passes. Broader catalog (~25 ids) is **Stage 4+**.

**Bot unit-test gate:**
- `bot/test/playbook-registry.test.js` extends to assert each new id
  round-trips.
- `scripts/check-conventions.mjs` lints each new phase table.
- `bot/test/reach.test.js`: router with mocked `getActions()` covering
  distance gate, standability, short-hop retry, hard failure carrying
  `next_action_hint`.
- `prompts-sync.test.js` after Steward SOUL pivot.
- `cheatsheet-sync.test.js` after `mc reach` lands.

**Scenario gate:**
- `chop-steward-authored`: Steward observes a tall oak at known coords,
  picks `wood.chop_tall_tree`, fills inputs, files the card. Worker walks
  it end-to-end. Pass: card closes done; turns-per-card ≤ Stage 2
  baseline × 0.9 (proving Steward's input-fill quality is not the
  bottleneck on v4-pro).
- `tower-reuses-pillar-up-safe`: **Wave 6 W6-T1** — three arms (prose / coarse / medium); see [`lab-wave-6-granularity.md`](lab-wave-6-granularity.md). Stage gate moved from “after A4 pass” to granularity lab.
- **`craft-post-56-blue-wool`:** Stage **1** gate (postmortem inventory);
  may repeat in Stage 3 with playbook card body — see Stage 1.
- **Sub-card chain (Stage 3, in order):** `craft-subcard-file` →
  `craft-subcard-unblock` → `craft-blue_wool-sub-cards` (empty inv;
  sub-cards include `playbook: scout.resource` for cornflower, then
  `craft.from_inputs` for dye and wool).

### Stage 4 — Integration validation (genesis A/B)

Goal: re-run genesis with same seed and anchor; A/B against
g-2026-05-30-3. Plan **2–3 runs** (`g-2026-05-31-1`, `-2`, `-3` same
seed/anchor, `--skip-base`) and aggregate metrics (median for noisy
continuous stats; all runs must pass hard zeros). Single-run ±20 %
turn-savings will be swamped by worker/Steward stochasticity.

**Deliverables.** Steward emits playbook-typed cards for P2/P3 where
catalog covers; workers walk them.

**Gate metrics** (aggregate across runs + `nav-telemetry.py --live
--playbooks --compliance`):

| Metric | Baseline | Target |
|---|---|---|
| **A1.** Tool calls / turns per closed playbook card | `baseline-turns.md` § genesis + § fixture | **TBD %** — set after 2a-V fixture medians + genesis § reviewed; not a pre-calibrated −20 % |
| **A2.** Phase-0 preflight refusals | 0 | **≥ 5** distinct refusals across the run series |
| **A2b.** Preflight-before-first-act compliance (JSONL counterfactual) | n/a | **≥ 80 %** of playbook-card spans |
| **A2c.** NULL-playbook-context (sync rows during playbook work) | n/a | **< 10 %** rows missing `playbook_id` (workers skipped `phase set`) |
| **A3.** Checkpoint-resume success | n/a | **≥ 1** per run series, no resume failures |
| **A4.** Composition events (if 2b shipped) | n/a | **≥ 10** aggregated; clean parent/sub attribution |
| **Whitelist compliance** | n/a | **≥ 80 %** of `(playbook_id, phase)` spans; **< 80 % → Stage 2c** |
| Multi-variant craft mis-report (#56) | observed | not observed |
| Phase-verify false-positive close | n/a | **0** |
| Stuck clusters (`stuck-scenarios.py`) | 8 (g-2026-05-30-3) | **median per run < 4** across the 2–3 run series (pre-registered; robust to one bad run) |
| Mason `mc move` err% | 55 % | < 45 % (noisy; 2–3 runs) |
| Live JSONL sync rows | 0 | > 2000; playbook/phase on **> 80 % of sync rows** |
| P3 epic at run end | 2/3 | full close (**content track** often the real gate) |

**Falsification rule.** If A4 misses (composition broken), pause the
plan and re-design before any further library expansion — composition
is the load-bearing assumption. A1 missing by less than 10% is reason
to investigate, not pause. A2 and A3 are integer-count goals; missing
zero refusals or zero resume events means the gates aren't firing in
realistic conditions.

**Authoring policy across stages.** During Stages 0–1, genesis cards may
remain prose — playbook authoring isn't gated yet. From Stage 3 onward,
Steward's playbook-author doctrine is **required** for P2/P3 supply,
craft, and build cards (the patterns the catalog covers). Stage 2's A1
test deliberately keeps prose available so the two forms can be compared
side-by-side on a fixture; Stage 4 expects most genesis cards to be
playbook-typed.

### Stage 4 — Genesis content track (parallel from Stage 2a)

Playbooks don't fix everything the postmortem flagged. This track can
start **during Stage 2a** and **gates Stage 4** alongside playbook
metrics. With **one maintainer**, treat it as **sequential work** in
the same calendar window — “parallel” means not blocked on playbook
code, not necessarily concurrent people.

| Item | Why it's outside playbooks |
|---|---|
| **#57 sheep availability** at the (-456, 74, 596) anchor | Genesis/world content, not a procedure issue. Pre-spawn a passive flock, or rewrite the wool source to be string-from-spider, or both. |
| **P3 card achievability audit** | The run's P3 stall was a mix of #56 (fixed) and "the cards literally couldn't be done at this anchor with these inputs". Re-author the P3 epic card bodies against the achievability of the same fixture world before Stage 4. |
| **Mining-skill alignment** (#51, #52, #53, #55) | Skill doc cleanups that the playbook references via `references_skill:`; if the skill is wrong, the playbook routes to the wrong procedure. |

A successful Stage 4 requires both the playbook track (A1–A4, compliance
metrics) **and** the content track passing. Otherwise Stage 4 will replay
the same "the bot followed the instructions; the instructions were
impossible" failure mode at a different cost layer.

### Implementation confidence (expectations, not guarantees)

| Stage | Outcome | Confidence |
|---|---|---|
| 0 Foundation | baseline-turns.md (via nav-telemetry) + JSONL; compliance flags with 2a-S | High |
| 1 Stop the lies | #54/#56/#58 + hint injector | High |
| 2a Flat + A1–A3 | A2/A3 pass; **A1 falsified** — prose-skilled for simple chop | **Measured** |
| 2b Composition | A4 telemetry OK; Flash completion weak | Medium |
| 3 Library | **Paused**; W6 one slice before catalog | High effort |
| 6 Granularity lab | W6-T1/T3/T4 **complete**; pass **closed** | Measured |
| 4 Genesis | Noisy; content track (#57, P3) often gates before playbook metrics | Medium |

If any metric is missed, the corresponding stage is reopened with a
targeted scenario — not the next genesis.

## Wave-5 outcomes (2026-05-31)

Honest A1/A4 predicate runs (gemini-2.5-flash, post-NBT-parser-fix). Numbers in
[`baseline-turns-fixture.md`](fixture-baseline-turns.md).

### A1 — falsified (Flash + chop-oak-8 flat)

Matrix n=5 per arm:

| Arm | mc median | chest ≥8 | inv_excl clean | playbook verb |
|-----|-----------|----------|----------------|---------------|
| prose-minimal | 29 | 3/5 | 4/5 | 0/5 |
| **prose-skilled** | **18** | **4/5** | **5/5** | 0/5 |
| playbook | 35 | **0/5** | 5/5 | 4/5 (23 calls) |

Playbook arm: ~2× the mc calls of prose-skilled, **0/5** chest deposits (every
run ended at chest=1, the prep starter log untouched). Ritual cost (`mc playbook
phase set` × 4–8 per run + `[run_state]` kanban comments) consumed enough of the
30-turn budget that no playbook agent reached deposit. A1 hypothesis
*"playbook ≤ prose on tool calls/errors"* fails on **both** axes.

### A4 — playbook telemetry works, completion does not (Flash, 10-log + pillar)

n=3:

| Run | mc | chest oak_log | inv_excl | sub_play |
|-----|----|---|----|----------|
| 1 | 27 | 5 (partial: 4 deposited) | clean | `pillar_up_safe` fires (4 JSONL rows) |
| 2 | 62 (over budget) | 0 | clean | playbook verbs used |
| 3 | 36 | 0 | **agent held 9 oak_log, didn't deposit** | pillar_up + playbook used |

Sub-play telemetry (`sub_playbook_id: pillar_up_safe`, `sub_phase:
check_lateral`/`place_then_step`) propagates correctly through phase set and
downstream actions. **Falsification is broader than "A1 was too easy"**: even
the hard composition fixture doesn't push playbook into a completion win at
gemini-2.5-flash. The 10-log + pillar task fails for the same Flash-budget
reason as A1.

### A2/A3 — playbooks earn their keep on discipline + resume

- **A2 chop-preflight-refusal**: 5 mc, ✅ — `prep_required_unmet:axe` block before any approach move.
- **A3 chop-checkpoint-resume**: 7 mc, ✅ — fresh worker reads `[run_state]` (chopped: 4), collects 4 more, deposits 8. This is where playbook structure pays off; A1's prose-skilled wouldn't know to resume.

### Compliance (preliminary, mixed-arm JSONL)

```
preflight_before_act: 0.67
whitelist:            0.43   ← well below the 80% threshold for 2c
null_playbook_context: 0.08
```

The whitelist number says agents call verbs outside `wood.chop_tall_tree.allowed_verbs`
~57% of the time when phase is set — not because the playbook is broken, but
because agents reach for `inspect`/`status`/`scene`/`equip`/`find_blocks` which
aren't in the per-phase allowed_verbs lists. **The whitelist may be too
restrictive** for realistic worker behavior, OR the playbook author should
expand `allowed_verbs` for chop_loop to include observation verbs.

### Updated direction

| Item | Status |
|---|---|
| **Stage 2a A1**, Flash + chop-oak-8 flat | **Falsified n=5**; Stage 4 %-improvement target for A1 → **N/A**. Treat **prose-skilled** as the production baseline for simple [SUPPLY] chop cards. |
| **Default worker pattern for simple chop cards** | Card body without `playbook:` (i.e. prose-skilled shape). Steward should NOT author `playbook: wood.chop_tall_tree` for "fetch 8 logs from one tree" until ritual cost is reduced. |
| **Playbooks remain in scope for** | A2 (preflight discipline), A3 (resume/checkpoint), A4 (composition + sub-play telemetry — telemetry verified, completion gated on model). |
| **Stage 2c server gate** | **Skip for now**. Compliance whitelist=0.43 looks "broken" but A2 still passes; suggests `allowed_verbs` is too tight, not that workers need server-side gating. Revisit if a real card gets through that shouldn't. |
| **Stage 3 catalog expansion** | **Pause broad expansion**. Keep A2/A3 + optional craft-subcard if genesis needs it. No new playbooks until ritual cost work lands or we test on a stronger model. |
| **Cheaper rituals** | Track in docs first (batch phase set, fewer `[run_state]` boundaries on flat path, "lite mode" in playbook skill). No bot-side engine. Worth revisiting before deciding whether to pause Stage 3. |
| **Stronger model on A1** | Defer — only if cheaper rituals don't unlock A1, and only as a cost/quality comparison vs prose-skilled. Don't re-run the matrix at Flash to chase a falsified result. |
| **agent-scripting-layer runtime substrate** | Defer indefinitely — both A4 telemetry and A3 resume succeed via worker hand-call; no engine needed. |

### Production note (today, no code)

Steward's kanban-author skill should template simple supply cards as
prose-skilled-style prose, not `playbook:` headers. Reserve `playbook:` for
cards that genuinely need structure: resume (A3-class), composition (A4-class),
or honor-system preflight (A2-class).

## Wave 6 — Granularity lab (complete)

**Status:** Closed. Full results:
[`lab-wave-6-granularity.md`](lab-wave-6-granularity.md). Pass closure:
[`improvement-pass-closure.md`](improvement-pass-closure.md).

| Track | Scenario | Status |
|-------|----------|--------|
| **W6-T1** | `tower-reuses-pillar-up-safe` | **Complete** — Option C (prose default) |
| **W6-T3** | `tower-platform-3x3` | **Complete** — resume 3/3; coarse 0/3 |
| **W6-T4** | `tower-scaffold-3x3` | **Complete** — coarse 2/3; closeout axis |
| **W6-T2** | Shallow mine | **Not run** — superseded by procedural-world testing |

No further Wave 6 matrices planned under this pass.

## Out of scope (deliberately deferred)

| Idea | Defer because |
|---|---|
| Bot-side playbook engine (auto-walk phases without LLM turns) | Worker SOUL walks the table fine in v1; revisit if Stage 4 turn-per-card data argues the LLM cost dominates |
| Layer A query DSL surfaced as `mc` verbs | The phase table's `preflight` / `verify` rows compose existing read-only verbs. Worth doing later as a Layer A roll-out (`agent-scripting-layer.md`), not Stage 2 |
| Layer B `call()` runtime | Same as above; phase tables can migrate to functions later |
| Region-selector grammar | Standalone refactor described in `agent-scripting-layer.md` Part 1; valuable but not gating any playbook |
| Tier-1 router taxonomy (`mc obtain`, `mc escape_pit`, etc. as compound verbs) | Playbooks compose these from existing primitives via `act:` rows; the compound-verb tree becomes redundant |
| Multi-level recipe recursion in `craft_plan` | `craft.from_inputs` playbook with sub-card dispatch (Stage 3) solves the blue_wool case |
| Material-simplification map | No scenario evidence; revisit if sub-card dispatch proves insufficient |
| Stress-scenario replay mode (extract `findings/` → fixture) | Stretch |
| Knowledge-lookup service distinct from `mc advise` | Open architectural decision; defer to after #54 lands |
| Async/background JSONL chokepoint | Different lifecycle path; Stage 0 covers sync only |
| Log rotation | Not Stage 0 |
| #57 sheep availability (playbook code) | Not a playbook deliverable — handled on **Stage 4 content track** (pre-spawn or card rewrite) |

## Stress testing harness

`scripts/stress.sh <scenario>` is a thin router over harnesses that
already exist — not a third test framework.

| Kind | Runner | Spec location |
|------|--------|----------------|
| Bot-only (noop, recipe-bed-variant, craft-post-56) | `scripts/run-fixture.sh` + scripted `mc` or L3 pytest | `data/test-fixtures/stress/*.yaml` |
| Agent + bot (advise-on-stuck, A1–A4, steward-authored) | `scripts/agent-test.py` | `data/agent-tests/playbooks/*.yaml` |

P4 conventions: `world: landfolk-test`, prep/cleanup rcon, safe-home
`(52, 65, 52)` where the spec says so. **Align rcon player name with
the bot under test** (Flint on `:3001` for default agent-test vs Tester
on `:3004` for some capability fixtures — each YAML documents which).

Agent scenarios pin `--model` to worker defaults in
`data/agent-models.json` and a fixed `--max-turns`.

**A1 card bodies:** shared fragments live under
`data/agent-tests/playbooks/includes/chop-oak-8/` (included into each
spec prompt so all three arms share exact goal bytes).

## Stress-test scenario library

Each scenario is one YAML under `data/test-fixtures/stress/`, ≤ 5 min
wall-clock, exercising one failure mode. P4-compatible
(`world: landfolk-test`, `prep`/`cleanup` rcon lists, safe-home reset to
`(52, 65, 52)`, profile `Tester`), lints under
`scripts/check-conventions.mjs`.

| Scenario | Stage gate | Setup | Pass criterion |
|---|---|---|---|
| `noop` | 0 | spawn bot at safe-home per YAML; one sync `mc` | jsonl ≥ 1 row with schema_version; runner clean exit |
| `advise-on-stuck` | 1 | agent-test: `prep` traps bot; agent calls `mc advise` | response ≤ 25 s; no PyYAML on stderr |
| `recipe-bed-variant` | 1 | bot/L3: `white_wool` + planks at table; craft `blue_bed` | craft succeeds ≤ 2 calls; no wrong wool in error |
| `craft-post-56-blue-wool` | 1 | bot/L3: postmortem inv; craft `blue_wool` ×8 | ≤ 2 craft calls; correct variant (#56) |
| `chop-prose-vs-playbook` (A1) | 2a | agent-test: three card forms; ≥5× each | **Closed — falsified** at Flash; prose-skilled default for simple chop |
| `chop-preflight-refuses` (A2) | 2a | agent-test: fixture removes axe before card claim | phase 0 `kanban_block: prep_required_unmet:axe`; no approach `move` before preflight |
| `chop-checkpoint-resume` (A3) | 2a | agent-test: kill worker after `chopped: 4/8`; respawn on same card | resume at iter 5 with `chopped: 4` |
| `chop-composition` (A4) | 2b | agent-test: `ascend` invokes `pillar_up_safe` | sub-play JSONL OK; Flash completion optional gate |
| `chop-steward-authored` | 3 | Steward picks `wood.chop_tall_tree` for tall oak | **Deferred** — simple chop stays prose-skilled |
| `tower-reuses-pillar-up-safe` | **6 (W6-T1)** | agent-test: 6 cobble column; prose vs coarse vs medium | **Done** — Option C; prose default for simple build |
| `tower-platform-3x3` | **6 (W6-T3)** | 3×3 platform; prose / coarse / resume | **Done** — resume 3/3; see wave-6 doc |
| `tower-scaffold-3x3` | **6 (W6-T4)** | dual-deck scaffold; strict bbox | **Done** — closeout axis; see wave-6 doc |
| `craft-blue_wool-sub-cards` | 3 | agent-test: empty inv; full chain | three sub-cards; parent closes (after subcard-file + subcard-unblock pass) |
| `craft-subcard-file` | 3 | agent-test: worker files one `[SUPPLY]` sub-card | kanban accepts; namespace valid |
| `craft-subcard-unblock` | 3 | agent-test: parent `--after` child | parent unblocks when child closes |
| `long-range-nav` | 3 (`mc reach` smoke) | bot 140 blocks from base in unfamiliar terrain | JSONL `outcome != ok` rows for nav verbs ≤ 7 |

## Architecture details

### P9 contract (preserved end-to-end)

- HTTP responses unchanged. `bot/lib/shared/action-contract.js` `ok()` /
  `fail()` shapes flow back to the worker.
- `error.next_action_hint` remains a **string** at the HTTP boundary.
  `HERMES_VALIDATE=1` rejects non-string hints.
- The internal `Envelope<T>` is for routers (`mc reach`) and telemetry
  only. At the HTTP boundary it serializes via `formatSuggested()`.
- Playbook branch tables consume `error.code` + `error.next_action_hint`
  directly; no new wire format.

### Telemetry chokepoint

Sync-action insertion after `pushAction` (~L248) in `task-lifecycle.js`;
variable is `actionName`. Reads `playbook_id` / `phase` (and optional
sub fields) from **`ctx.runtime.playbook_context`**, set by
`mc playbook phase set` and cleared by `mc playbook phase clear` on the
bot server — **not** from subprocess env. JSONL at
`/tmp/hermescraft/nav-<profile>.jsonl` (override via `HERMESCRAFT_TMP`).
Rows use the v1 schema documented in Stage 0. **Async `bg_*` actions do
not emit rows in this round.**

Post-run: `nav-telemetry.py --live --playbooks` aggregates per-phase
ok/fail/turns/wallclock — the data Stage 4 needs to size phase
`max_turns` budgets and validate the turns-per-card target.

The "39 % of blockages previously lost to log-truncation" figure is a
hypothesis; validate by A/B of `--live` vs retrospective extraction on
one stress run before reciting it.

### Why no bot-side playbook engine in v1

The worker LLM walks the phase table by reading the playbook doc (via
`skill_view`) and the latest `[run_state]` comment. This is one of:

- One LLM turn per phase (most common case): preflight rows + one `act:`
  + verify rows fit in a turn for short phases.
- Multiple turns per phase (e.g. `chop_loop` with budget 18): each
  iteration is a turn; the worker tracks iteration count in the
  checkpoint scratchpad.
- Sub-playbook traversal (composition): the same worker walks both
  parent and sub one phase per turn; JSONL distinguishes via
  `playbook_context.playbook_id` vs `playbook_context.sub_playbook_id`
  on **`ctx.runtime`** (not subprocess env).

In both cases the LLM is in the loop, which is what we have today. The
playbook just removes ambiguity about *which verb to call next* and
*what counts as success*. A bot-side engine that walks mechanical rows
without LLM cost is a follow-on if Stage 4 data shows the LLM
budget dominating.

## Tasks rolled into stages

| Task | Stage | One-liner |
|---|---|---|
| #54 advise | 1 | regex config + warning suppression + timeout reconcile |
| #56 craft selector | 1 | shared `pickRecipeForCraft` with per-variant `ceil(count/yield)` + held-ingredient tie-break |
| #58 `nav_header` suggested direction | 1 | server-side `nav_header.suggested_hint`; CLI prints it |
| #50 (done) `nav_header` on scene/status | — | shipped pre-pass |
| #51 dig_area cap docs | 2 | rewrite `skills/minecraft-mining.md` line saying 500 |
| #52 surface-strip pattern | 2 | new section in mining skill; cited by Stage-3 `mine.underground_target` playbook |
| #53 cross-map card prescriptions | 2 | loosen P2/P3 card bodies in genesis templates; playbook inputs replace much of the prose |
| #55 collect 64-cap UX | 2 | raise cap or include usage in the error |
| #57 sheep availability | out-of-scope | genesis content; pair with material work later |

## Resolved decisions

1. **Sequencing.** Stage 0 → 1 → 2 → 3 → 4. Stages 0–3 ship within days;
   Stage 4 is the next genesis run.
2. **Procedure form.** Playbook id + inputs in the card body + phase
   table in skill docs + `[run_state]` checkpoint in kanban comments.
   **Composition** via `use_playbook:` in `act:` rows; no bot-side
   runtime in v1.
3. **First playbook is `wood.chop_tall_tree`.** Stage **2a** ships a
   **flat** doc (`references_skill:` + routing/checkpoints; no
   `use_playbook:`). Stage **2b** adds `pillar_up_safe` /
   `descend_safe` and A4 composition if 2a wins.
4. **Worker autonomy.** Preserved via per-phase `verb_whitelist` +
   `max_turns` budget, plus the reactive layer.
5. **Model split.** Steward on v4-pro for playbook-author turns;
   workers on v4-flash. Selective routing in
   `data/agent-models.json`, not a per-profile global swap.
6. **Recipe recursion.** Sub-card dispatch by Steward via
   `craft.from_inputs`, not code-level recursion.
7. **Envelope contract.** P9 `error.next_action_hint` string is the
   agent-facing wire format. Typed `Envelope<T>` is internal (routers +
   telemetry). `formatSuggested()` is the only serializer.
8. **Stress vs genesis as gate.** Stages 0–3 gate on bot unit tests +
   stress scenarios. Stage 4 gates on genesis metrics under the four
   falsifiable assumptions A1–A4.

## Code validation (2026-05-31)

| Claim | Verdict |
|---|---|
| `HERMES_NAV_BRIEF` → `behaviors.navBriefMode`; brief computed only for `shadow`/`1` | **Confirmed** (`bot/lib/config/index.js`; `observation.js` ~L437-470) |
| Compact header omits brief `← suggested`; shows `signals.text` only | **Confirmed** (`formatNavFrameLine` in `bot/cli/output.mjs`) — Stage 1 #58 adds `nav_header.suggested_hint` |
| P9 agent-facing contract is `error.next_action_hint: string` | **Confirmed** (`action-contract.js`; CLI `results.mjs`); `HERMES_VALIDATE=1` rejects non-string |
| Internal `Envelope<T>` | **Internal use only** — routers + telemetry; serializes via `formatSuggested()` at HTTP boundary |
| `bestRecipeForInventory(b, count)` vs `buildCraftPlan(.., invocations)` mismatch | **Confirmed** for yield ≠ 1; fix is per-variant `ceil(count/yield)` |
| Tie → `recipes[0]` | **Confirmed** (`recipe-ingredients.js`; `crafting.test.js`) |
| `INGREDIENT_TAG_EQUIVALENTS` excludes wool/planks deliberately | **Confirmed** (`recipe-ingredients.js` ~L71-78) |
| `craft_plan` single-level, no recursion | **Confirmed** (`buildCraftPlanFromRecipes`) — sub-card dispatch in Stage 3 instead |
| `mc advise` client-only chain through `runAdviseCli` | **Confirmed** (`bot/cli/index.mjs` ~L369-388) |
| PyYAML warning + defaults in `config.py` (non-fatal) | **Confirmed** (~L69-86); shell vs OpenRouter timeout is separate |
| Steward read-only: no `craft`/`recipes` in SOUL table | **Confirmed** (`prompts/landfolk/steward.md` ~L42) — Stage 2 adds read-only `recipes`, `craft_plan`, and playbook registry view |
| `BOT_ON_PILLAR` → `pillar_down` hint | **Confirmed** (`_preflight.js` ~L177-191) |
| `pillar_up` lateral exit probe `canStepLaterally` | **Confirmed** (`pillar.js` ~L132-149) |
| `task-lifecycle.js` variable is `actionName`, insertion after `pushAction` (~L248) | **Confirmed**; sync-path only |
| `logEquipRecovery` pattern uses `HERMESCRAFT_TMP`; no rotation today | **Confirmed** — Stage 0 inherits |
| `navBriefLog` hook optional | **Confirmed** (`nav-brief.js` ~L655-657) |
| `go_mark` `visit_count` on arrival | **Confirmed** (`marks.js` ~L98-99, L133-134) |
| `data/playbooks/registry.yaml` (Stage 2) | **Implemented** (uncommitted) — `playbook-registry.test.js` + skill byte-sync |
| `mc playbook phase set` / `phase clear` (Stage 2) | **Implemented** — `ctx.runtime.playbook_context`; live Waves 4; not subprocess env |
| Per-call `--playbook-context` CLI override | **Deferred** — only if phase-set compliance fails in JSONL post-checks |
| `mc reach` (Stage 3) | **Partial** — `movement/reach.js` + registry; missing `reach.test.js` / committed cheatsheet |
| Steward playbook-author SOUL (Stage 3) | **Not started** — registry + flat playbook doc exist; Steward prompts not updated |
| "39 % blockages lost to truncation" | **Hypothesis** — validate via `--live` JSONL A/B before reciting |

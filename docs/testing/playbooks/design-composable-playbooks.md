# Agent playbooks: composable orchestration over existing primitives

Status: **design reference** (2026-05-31). The improvement **pass is closed** —
see [`improvement-pass-closure.md`](improvement-pass-closure.md).
Playbooks remain orchestration spec + test harness; production cards favor
prose + skills unless closeout/preflight/resume patterns require structure.
Orchestration spec on top of the existing `mc` verb registry. Companion to
[`agent-scripting-layer.md`](../../specs/agent/scripting-layer-dsl.md) (eventual runtime substrate)
and [`improvement-pass-followup.md`](../../archive/testing/playbooks/improvement-pass-followup.md) (historical plan).
Evidence base: g-2026-05-30-3 (`data/genesis-runs/g-2026-05-30-3/findings/`).

Architecture owner for the same ideas (reflex, taxi nav, perception zoom, living vocabulary): [`../../architecture/embodied-control.md`](../../architecture/embodied-control.md).

Playbook **phase verb whitelists** are the per-card slice of the **agent surface** (not the full 181-verb registry). See embodied-control § Two layers.

## Delivered v1 vs design ambition

**Design ambition:** composable playbooks with `use_playbook:` sub-plays
and a full survival catalog.

**Delivered v1 unless A4 passes:** **flat** top-level playbooks only
(`references_skill:` for procedure; routing + checkpoint + verify in the
playbook doc). **No worker recursion into sub-plays** in Stage 2a or in
Stage 3 if A4 falsifies — Steward sequences work via kanban `--after`
instead. The registry and docs describe composition so Stage 2b can
extend without a schema rewrite; do not assume composition is live in
fleet until A4 and Stage 4 A4 metrics say so.

## Why playbooks (and why not runbooks)

Three patterns from the live run argue for procedure-as-documentation,
not procedure-as-code-the-agent-writes:

- **Cards are prose; workers pay for re-interpretation every cycle.**
  Mason re-read the blue_wool card across compactions; Flint re-derived
  the wood collect goal on every session.
- **Bots step into traps because nothing was pre-checked.** Mason dug
  into a 1×1 pit because nothing in his card said "ensure return path
  stays open." There was no in-flow gate.
- **Reasoning waste tracks lack of structure.** Steward orients with
  `mc observe` 83 times and her error rate stays low. Workers freeform
  and their nav/dig/collect errors run 41–71 %.

A **playbook** is a named, parameterized pattern in a catalog. The name
distinguishes it from a "runbook" (procedural, fixed walk) in three
ways that matter:

1. **Composition (Stage 2b+, if A4 passes).** A phase's `act:` row can
   be either a verb call or `use_playbook: pillar_up_safe`. Until then,
   flat playbooks only — see **Delivered v1 vs design ambition** above.
2. **Adaptation.** Branches handle errors as before, but **Steward can
   swap the active playbook for a card mid-execution** by filing a fresh
   card that takes over. The worker doesn't author a new plan at run-
   time; the orchestrator picks a different play from the catalog when
   observed state demands it.
3. **Strategic framing.** A playbook is a *pattern* the worker executes
   with autonomy inside a phase's verb whitelist, not a rigid step list.
   The sports analogy holds: the play call is fixed; each player adapts
   within their role.

The discipline is the same as a runbook would have used (phase tables,
preflight, verify, branch tables, verb whitelists, `max_turns`,
checkpoint comments). What's new is composition and the explicit
"templates contribute to the process" framing.

**Crucially, playbooks add no new mutation surface.** Every `act:` row
calls existing `mc` primitives. Every `verify:` and `preflight:` row is
a read-only `mc` call. The playbook is data + doctrine; the runtime is
the worker SOUL walking the phase table.

## Domain-coupled perception (the key insight)

Canonical write-up: [`../../architecture/embodied-control.md`](../../architecture/embodied-control.md) § Ecological sight. Summary:

Today's `mc scene` returns the same data whether you're surveying a
chicken pen, auditing a wall, or counting trunk logs. Workers pay for
the mismatch by re-deriving "what matters here?" every turn.

Playbooks fix this at the **phase template** level: each phase composes
existing read-only verbs into the *specific observation* its task needs.
Examples from the catalog below:

- **Tree survey** (`wood.chop_tall_tree` phase 2): `mc scene` +
  `find_blocks <species>_log r=8` + LOS check — counts actual trunk
  logs, detects branches, identifies safe scaffold side.
- **Pen survey** (`farm.passive_mob_chicken` phase 1): `mc scene` +
  `mc nearby` for adults + `mc inspect` of corner cells for enclosure
  integrity + `mc find_entities` count.
- **Blueprint diff** (`build.repair_site` phase 1): `mc blueprint
  verify` or `capture` — already domain-coupled today.
- **Cast range check** (`chore.fish_quota` phase 1): `mc scene` + water
  reachability + rod state in `mc inventory`.

The verbs don't change; the *composition* does. Each playbook documents
its phase-by-phase observation recipe so workers don't have to invent
one.

## Three artifacts together

Playbooks live in three places that already exist:

```
        Steward                              Worker
          │                                     ▲
          │ playbook id + inputs (card body)    │ run_state checkpoint
          ▼                                     │ (kanban comment)
        kanban card body ────────────────────► kanban comments
          │
          │ playbook id resolves through
          ▼
        data/playbooks/registry.yaml ──► docs/testing/playbooks/catalog/<id>.md
              (machine-readable index)         (phase table + composition)
```

No new datastore. No new runtime. The novelty is the **schema** in the
card body and the **comment protocol** for checkpoints — plus the
**composition convention** that lets one playbook reference another.

## Playbook id registry

`data/playbooks/registry.yaml` is the single source of truth for valid
playbook ids **and for compliance verb lists** (`phases[].preflight_verbs`,
`phases[].allowed_verbs`). Human-readable phase tables in each `doc:`
file must stay aligned with registry entries; **`check-conventions.mjs`**
asserts registry ↔ doc phase ids match. Compliance tooling reads **YAML
only**, not markdown tables.

```yaml
# data/playbooks/registry.yaml
playbooks:
  # ─── top-level: cards reference these ───
  - id: wood.chop_tall_tree
    doc: docs/testing/playbooks/catalog/wood-chop-tall-tree.md
    summary: "Flat Stage 2a: approach, chop loop, closeout; procedure via references_skill."
    inputs:
      required: [tree, target_logs, scaffold_block, deposit_to]
      optional: [keep_min]
    # Machine source for nav-telemetry --compliance (markdown doc mirrors for humans).
    phases:
      - id: preflight
        preflight_verbs: [inventory, craft_plan, equip, chest_search]
        allowed_verbs: [inventory, craft_plan, equip, chest_search]
      - id: approach
        preflight_verbs: [status]
        allowed_verbs: [move, status, scene, inspect]
      - id: chop_loop
        allowed_verbs: [dig, nearby, find_blocks, inspect, pillar_down, move, place]
      - id: closeout
        allowed_verbs: [move, deposit, list_container, status]

  - id: mine.underground_target
    doc: docs/testing/playbooks/catalog/mine-underground-target.md
    summary: "Travel to a known surface entry, descend to target Y, mine N of a resource, return."
    inputs:
      required: [resource, quota, mine_site, prep_required]
      optional: [chamber_size, keep_min]

  - id: supply.from_chest
    doc: docs/testing/playbooks/catalog/supply-from-chest.md
    summary: "Withdraw N of an item from a base chest, deliver to another mark."
    inputs:
      required: [item, count, source_chest, deposit_to]
      optional: [leave_min]

  - id: craft.from_inputs
    doc: docs/testing/playbooks/catalog/craft-from-inputs.md
    summary: "Craft N of an item at a table given ingredients in inventory or a nearby chest. Sub-cards generated for missing ingredients."
    inputs:
      required: [item, count, ingredients]
      optional: [table_mark, deposit_to]

  - id: scout.resource
    doc: docs/testing/playbooks/catalog/scout-resource.md
    summary: "Find and mark a surface resource patch (flowers, ore hint) for downstream supply/craft cards."
    inputs:
      required: [resource, search_hint]
      optional: [radius, deposit_mark]
    phases:
      - id: survey
        preflight_verbs: [status, inventory]
        allowed_verbs: [move, scene, nearby, find_blocks, inspect, mark, marks]
      - id: confirm
        allowed_verbs: [inspect, mark, go_mark, status]

  - id: build.repair_site
    doc: docs/testing/playbooks/catalog/build-repair-site.md
    summary: "Capture or verify a site against a blueprint; fix defects up to a scope."
    inputs:
      required: [site, scope]
      optional: [blueprint, materials_mark, allowed_blocks]

  - id: build.tower_vertical
    doc: docs/testing/playbooks/catalog/build-tower-vertical.md
    summary: "Raise a column or framed tower to a target Y. Mode chosen at card time."
    inputs:
      required: [footprint, target_y, block, mode]
      optional: [blueprint, anchor]

  - id: farm.passive_mob_chicken
    doc: docs/testing/playbooks/catalog/farm-passive-mob-chicken.md
    summary: "Sustain a chicken flock at a pen; breed, collect, do not wipe."
    inputs:
      required: [pen_mark, target_adults, outputs]
      optional: [min_adults, feed_item]

  # ─── sub-plays: composed by the above; not usually carded directly ───
  - id: pillar_up_safe
    doc: docs/testing/playbooks/catalog/pillar-up-safe.md
    summary: "Pillar up N blocks with per-block lateral exit check; handles BOT_ON_PILLAR."
    inputs:
      required: [count, block]
      optional: [side_check, max_lateral_retries]
    subplay: true

  - id: descend_safe
    doc: docs/testing/playbooks/catalog/descend-safe.md
    summary: "Descend from current Y to surface via stair_down, pillar_down, or guided fall."
    inputs:
      required: []
      optional: [prefer_stair, max_drop]
    subplay: true

  - id: recover.stuck
    doc: docs/testing/playbooks/catalog/recover-stuck.md
    summary: "Assess situation, escape, return to safe ground."
    inputs:
      required: []
    subplay: true
```

The `subplay: true` flag is a convention marker, not a hard
restriction — anything in the registry can be card-attached, but sub-
plays are not what Steward picks for a parent goal.

Sync constraints:

- Every `playbooks[*].id` is unique.
- Every `doc` path exists and contains a phase table.
- Every doc has front-matter `playbook: <id>` that round-trips to the
  registry.
- Card-create rejects unknown ids; `use_playbook:` references inside a
  phase resolve against the registry too.

## Card body schema

Steward inserts a small structured block into the card body alongside
prose context.

```yaml
# kanban card body — header section
playbook: wood.chop_tall_tree
inputs:
  tree:
    base: [395, 65, -612]
    species: oak
    estimated_height: 8
  target_logs: all
  scaffold_block: dirt
  deposit_to: chest_wood
  keep_min: 0
```

The playbook id and inputs are immutable for the life of the card.
Workers don't edit them; Steward owns them. **If observed state demands
a different play**, Steward writes a fresh card with the new playbook
id and uses kanban `--after` to sequence it; the original card stays
blocked or is closed with partial credit.

## Checkpoint protocol

After every completed phase (or any phase that returns a hard failure),
the worker appends a structured checkpoint to the card comments.

```yaml
# kanban comment, written by the worker
[run_state]
playbook: wood.chop_tall_tree
phase: chop_loop                  # next phase to enter
completed: [preflight, approach, tree_survey, ascend]
context:
  trunk_logs_seen: 8
  scaffold_top: { x: 396, y: 73, z: -612 }
  chopped: 0
  last_error: null
  ts: 2026-05-31T01:23:45Z
```

When a phase composes a sub-playbook, the checkpoint nests:

```yaml
[run_state]
playbook: wood.chop_tall_tree
phase: ascend                     # the parent phase currently active
completed: [preflight, approach, tree_survey]
sub:
  playbook: pillar_up_safe
  phase: place_then_step
  completed: [check_lateral]
  context:
    placed: 4
    target: 7
context:
  trunk_logs_seen: 8
  scaffold_anchor: { x: 396, y: 65, z: -612 }
  ts: 2026-05-31T01:24:10Z
```

A fresh worker reads the nested checkpoint and resumes inside the sub-
playbook at `place_then_step` with `placed: 4`. When the sub-play
completes, the worker returns to the parent's `ascend` phase, marks
it done, and writes a checkpoint advancing the parent to `chop_loop`.

Rules:

- The **most recent** `[run_state]` comment wins. No merge; the worker
  writes a fresh block at each phase boundary.
- In-progress mid-phase state isn't persisted; restart at the last
  clean boundary.
- A worker that completes the final phase writes `phase: __done__` and
  closes the card.

## Phase table (standard shape)

Every playbook doc has its phase table in the same column order so the
worker can mechanically read it.

| # | Phase | Goal | Preflight | Act | Verify | Branches | Verb whitelist | max_turns |
|---|---|---|---|---|---|---|---|---|

The `Act` column may be either a verb call (`mc <verb> args`) or a
sub-playbook reference (`use_playbook: <id>` with its own `inputs:`).

The `Verb whitelist` column is the discipline that keeps worker
autonomy bounded. Inside a phase, the worker may issue any verb in
the list, up to `max_turns` calls. If the phase's `verify` doesn't
hold after the budget, the branch row fires.

## Branches and the error envelope

Branch rows key off the existing P9 envelope's `error.code` and
`error.next_action_hint` fields. The follow-up improvement pass
invests in injecting useful `next_action_hint` strings on
`move`/`goto`/`collect`/`craft` failures precisely because branch
tables consume them.

```
| Branch row | Match                          | Action |
|------------|--------------------------------|--------|
| (default)  | error.code starts with NAV_    | Re-issue act once with a shorter hop. Second fail → checkpoint with phase=current and last_error=<code>. |
| trap       | error.code = BOT_TRAPPED       | use_playbook: recover.stuck. Resume current phase on return. |
| occluded   | error.code = NO_VISIBLE_BLOCKS | Switch act to `mc tunnel` toward last seen target. |
| hazard     | error.code starts with HAZARD_ | Seal source if dirt available. Checkpoint, escalate to kanban_block. No --force widening. |
```

## How workers load playbook docs

Playbook bodies live under `docs/testing/playbooks/catalog/<id>.md`. Workers
load skills via `skill_view` against `skills/` (see `skills/MANIFEST`).

**Stage 2a (canonical):** a step in **`scripts/regenerate-artifacts.sh`**
copies each registry `doc:` to `skills/playbook-<slug>.md` and updates
`skills/MANIFEST`. After `skill_view('kanban-worker')`, the worker calls
e.g. `skill_view('playbook-wood-chop-tall-tree')`. **`playbook-registry.test.js`**
asserts doc hash matches skill copy.

**Optional later:** Hermes-native `skill_view playbook:<id>` resolving
through `data/playbooks/registry.yaml` without a copy step.

## Composition: when a phase uses another playbook

A phase's `act:` row may be `use_playbook: <id>` instead of `mc <verb>`.
The runtime contract:

1. The parent worker writes a checkpoint marking the parent phase as
   "running with sub" and includes the sub-playbook id + initial
   inputs.
2. The same worker walks the sub-playbook's phases in turn (still
   one LLM-turn-per-phase; no new runtime).
3. Telemetry rows carry both `playbook_id` and a nested
   `sub_playbook_id` field so post-run analysis can attribute time +
   errors to either layer.
4. On sub-playbook success, the parent phase's `verify:` runs against
   the parent context.
5. On sub-playbook hard failure, the parent's branch table fires with
   `error.code = SUBPLAY_FAILED` and the sub's last error attached.

This is how a tower playbook reuses `pillar_up_safe`, how
`recover.stuck` reuses `descend_safe`, and how the catalog stays small
without duplicating procedure. Sub-playbooks are **the templates that
contribute to the process** that the earlier framing called for.

## Sub-cards for decomposition (orthogonal to composition)

Sub-playbooks are *invoked inline by the worker*. Sub-cards are
*filed by the worker for a different worker to execute later*. Both
matter:

- Composition (sub-playbook) example: `wood.chop_tall_tree` `ascend`
  phase uses `pillar_up_safe` — same worker, immediate.
- Decomposition (sub-card) example: `craft.from_inputs blue_wool`
  preflight finds inventory short on blue_dye → emits a `[SUPPLY]`
  sub-card with `playbook: craft.from_inputs` and `item: blue_dye`;
  parent card waits via kanban `--after`.

Both routes flow through the playbook catalog; the difference is
synchronous (composition) vs queued (decomposition).

**Stage 3 validation order (avoid one integration test masking five
failures):** agent-test `craft-subcard-file` → `craft-subcard-unblock`
→ `craft-blue_wool-sub-cards`. See followup pass stress library.

### Who files sub-cards (kanban convention)

Workers **may** file sub-cards directly under two narrow conditions:

1. The sub-card's `playbook:` id is in a worker-allowed namespace
   (today: `supply.*`, `craft.*`, `scout.*`, `recover.*`). Registry
   must contain every prefix used — e.g. **`scout.resource`** for
   cornflower scout sub-cards in `craft-blue_wool-sub-cards`.
2. The parent card's playbook explicitly authorizes sub-card filing in
   a branch row's action (`escalate: { kind: sub_card, playbook: <id>,
   inputs: { … } }`). The playbook spec is the permission grant.

Outside those, the worker must `kanban_block` with a structured reason
and let Steward decide. This keeps the orchestration boundary clean
without forcing every sub-card through Steward's loop: the routine
cases (need ingredients, need a tool, need a scout) are autonomous;
novel decompositions stay with the orchestrator.

The Steward SOUL doctrine (Stage 3) documents both lists explicitly.

## Verb whitelist + budget = bounded autonomy

The worker autonomy preserved in two ways:

1. **Inside each phase**, the worker is free to use any verb on the
   whitelist up to `max_turns`. A phase that says
   `whitelist: [scene, nearby, find_blocks, move, dig, place]` and
   `max_turns: 8` is a "do what you need to" window.
2. **The reactive layer is unchanged.** Reactions (low HP, mob, drown)
   interrupt at any time; the worker resumes the phase after the
   interrupt clears. Reactive policy is not authored in playbooks per
   `docs/archive/phase-2-design/reactive-layer.md`.

A worker can't burn four hours improvising on the wrong thing because
the phase's `max_turns` budget caps the freeform window.

## Worker SOUL discipline

The worker SOUL is updated once to describe how to walk a playbook:

1. On card claim, read the **top-level `playbook:`** field from the card body (NOT `inputs.playbook` — the id is a sibling of `inputs:`, not a child).
2. `skill_view('playbook-<slug>')` (synced from registry via deploy) or read the playbook doc from context.
3. Read the most recent `[run_state]` comment. If none, start at the
   first phase.
4. For the current phase:
   a. **`mc playbook phase set <playbook_id> <phase>`** (and `--sub` when inside a sub-play).
   b. Run each `preflight` row. If any returns `fail()`, consult the
      branch table.
   c. If the `act` row is `use_playbook: <id>`, recurse into the sub-
      playbook (steps 1–5 on the sub).
   d. Else, issue the verb call. Read the envelope.
   e. Run each `verify` row. If any fails after `max_turns` reasoning,
      consult the branch table.
   f. On phase success, write a fresh `[run_state]` comment advancing
      to the next phase.
5. On the last phase's success, **`mc playbook phase clear`**, then close the card with `kanban complete`.

The SOUL update is small enough to keep `prompts-sync.test.js` green
without per-profile divergence.

## Telemetry context

At each **phase boundary**, the worker calls:

```
mc playbook phase set <playbook_id> <phase> [--sub <sub_playbook_id> <sub_phase>]
```

That POST stores `{ playbook_id, phase, sub_* }` on the bot server's
**`ctx.runtime.playbook_context`**. Every subsequent **sync** `mc`
action includes those ids on the Stage-0 JSONL row until context is
cleared:

```
mc playbook phase clear
```

Call `phase clear` on card complete or when abandoning the playbook.
**Subprocess env is not used** — it does not reliably reach the bot
server process.

**Card binding and auto-clear.** The server learns `card_id` from
`mc task_context set` (`HERMES_KANBAN_TASK` or `--card`). `playbook
phase set` requires that binding and snapshots `card_id` on
`playbook_context`. If `POST /task-context` changes `card_id`, the
server clears stale `playbook_context` (see followup pass **Playbook
context lifecycle**).

**Alternative (deferred):** optional per-call `--playbook-context` on
the CLI → HTTP body to override or backfill when post-checks show
missed phase-sets.

`scripts/nav-telemetry.py --live --playbooks` aggregates per-phase
ok/fail/turns/wallclock with parent and sub attribution. JSONL rows
use the v1 schema from the followup pass (sync actions only; `bg_*`
deferred).

## Worked example — Stage 2a flat (`wood.chop_tall_tree`)

**Ship first in Stage 2a-V.** Procedure detail lives in
`references_skill: skills/minecraft-mining.md` § Production workflow.
**No `use_playbook:`**, **`mc move`** on approach (not `reach` until
Stage 3). Registry `phases[]` must match this table.

| # | Phase | Goal | Preflight | Act | Verify | Branches | Verb whitelist | max_turns |
|---|---|---|---|---|---|---|---|---|
| 0 | preflight | Ready to chop | `mc inventory` (axe tier for `inputs.tree.species`; scaffold count ≥ height) | `mc equip` axe; `mc craft_plan` axe if short → `[SUPPLY]` sub-card | axe held; scaffold OK | missing axe → `kanban_block` + `prep_required_unmet:axe` + `[SUPPLY]`; scaffold short → `supply.from_chest` sub-card | inventory, craft_plan, equip, chest_search | 4 |
| 1 | approach | Adjacent to trunk base | `mc status` | `mc move` to `inputs.tree.base` | `mc inspect` base cell is `<species>_log` | `NAV_*` → branch + checkpoint on repeat | move, status, scene, inspect | 6 |
| 2 | chop_loop | Trunk logs in inventory | count `<species>_log` < target | `mc dig` trunk logs top-down per mining skill § Production workflow | count ≥ `inputs.target_logs` | partial budget → checkpoint `chopped: n/N` | dig, nearby, find_blocks, inspect, pillar_down, move, place | 18 |
| 3 | closeout | Logs deposited | inv ≥ minimum | `mc move` to deposit; `mc deposit` | chest delta matches | return nav fail → checkpoint | move, deposit, list_container, status | 8 |

Preflight refusal for missing axe: `skills/kanban-worker.md` pass-back
(`kanban_block` + `[SUPPLY]` sub-card).

## Worked example — Stage 2b+ full (`wood.chop_tall_tree` with composition)

After A4 passes, extend the flat doc with ascend/descend
**`use_playbook:`** rows and Stage 3 `mc reach` on approach/closeout.
Located at `docs/testing/playbooks/catalog/wood-chop-tall-tree.md` (composed
variant).

| # | Phase | Goal | Preflight | Act | Verify | Branches | Verb whitelist | max_turns |
|---|---|---|---|---|---|---|---|---|
| 0 | preflight | Ready to chop | `mc inventory` for axe (`<tool_tier>_axe` matching `inputs.tree.species` hardness); count `inputs.scaffold_block` ≥ `tree.estimated_height` | `mc equip <axe>`; `mc craft_plan <axe>` for shortfall → file `[SUPPLY]` sub-card | axe held; scaffold count meets need | `MISSING_INGREDIENTS` → file sub-card via `craft.from_inputs <axe>`, parent blocks `--after`. Scaffold short → file `supply.from_chest` sub-card | `[inventory, craft_plan, equip, chest_search]` | 4 |
| 1 | approach | Bot adjacent to trunk base | `mc status` | `mc reach @tree.base` (Stage 3); falls back to `mc move tree.base.x tree.base.y tree.base.z` in Stage 2 before `reach` lands | `mc inspect tree.base` returns `<species>_log` | `NAV_BLOCKED` → branch as Stage 2 envelope hint suggests; on second fail, checkpoint | `[reach, move, status, scene]` | 6 |
| 2 | **tree_survey** | Know what we're cutting | (none) | `mc scene 8`; `mc find_blocks <species>_log r=8`; `mc inspect` at `base + (0,1,0)` through `base + (0,estimated_height,0)` | `context.trunk_logs_seen` set; `context.scaffold_side` set (open lateral cell adjacent to trunk) | If `trunk_logs_seen < estimated_height / 2`, the mark may be wrong → checkpoint with `last_error: tree_mismatch`, do not climb | `[scene, find_blocks, inspect, nearby]` | 6 |
| 3 | ascend | Bot beside trunk near canopy | scaffold block in inv | **use_playbook: `pillar_up_safe`** with `{ count: trunk_logs_seen - 1, block: scaffold_block, side_check: every_block }` | bot Y ≥ `tree.base.y + trunk_logs_seen - 2`; bot is at `scaffold_side` not on trunk | `SUBPLAY_FAILED: BOT_ON_PILLAR` → checkpoint with `last_error`; sub-play handled its own internal recovery | (delegated to sub) | (delegated) |
| 4 | chop_loop | All trunk logs collected | `mc inventory.count(<species>_log) < target` | `mc dig` for each `<species>_log` in reach, going down per iteration; pillar_down or step-down between layers | `inventory.count(<species>_log) == trunk_logs_seen` (or `target_logs` if numeric) | `NO_VISIBLE_BLOCKS` → switch to `mc tunnel` lateral 1 toward last seen log. Budget exhaust → checkpoint with partial `chopped`. | `[dig, nearby, find_blocks, inspect, pillar_down, move, place]` | 18 |
| 5 | reclaim_scaffold | Scaffold blocks back in inv, surface clear | (none) | `mc dig` each scaffold block placed in ascend phase; `mc pickup` saplings if dropped | `inventory.count(scaffold_block) ≥ ascend.placed - 2` (allow some loss to grass replacement); no `scaffold_block` placed within 3 of trunk base | `MISSING_BLOCK` (someone else picked up) → accept, continue | `[dig, pickup, nearby]` | 8 |
| 6 | descend | Bot at surface | bot above target Y | **use_playbook: `descend_safe`** | bot Y ≤ tree.base.y; bot intact (`hp >= 14`) | sub failure → checkpoint, escalate | (delegated) | (delegated) |
| 7 | closeout | Logs in chest; card closed | inventory ≥ minimum | `mc reach @deposit_to`; `mc deposit <species>_log leave: keep_min` | chest snapshot `+= chopped` | `NAV_*` on return → `use_playbook: recover.stuck` if persistent | `[reach, deposit, list_container, status]` | 8 |

Sub-playbook `pillar_up_safe` ships alongside as the smallest realistic
composition test:

| # | Phase | Goal | Preflight | Act | Verify | Branches | Verb whitelist | max_turns |
|---|---|---|---|---|---|---|---|---|
| 0 | check_lateral | Confirm a side cell is walkable at planned height | `mc scene` for `inputs.side_check` direction | (read-only) | `context.safe_side` set | All sides blocked → checkpoint `BLOCKED_LATERAL`, exit with failure | `[scene, inspect, nearby]` | 3 |
| 1 | place_then_step | Place block under feet, jump | scaffold block in inv | `mc pillar_up 1 inputs.block` | bot Y += 1; lateral exit still present at new Y | `BOT_ON_PILLAR` → re-run check_lateral one cell laterally; if still blocked, escalate | `[pillar_up, place, scene, inspect]` | 3 |
| 2 | loop_until_target | Repeat until `placed == count` | `placed < count` | (loop phase 1) | `placed == count` | (none — loop owns its own retries) | (inherited) | (per iteration) |

That's three phases — enough to validate composition with telemetry
attribution.

## Adoption after Wave 5 (2026-05-31)

Flat A1 at Flash **falsified**; **W6-T1** confirmed Option C (prose-skilled ~2–3× cheaper, all arms 3/3).
Next measurement: **W6-T3** platform — see
[`lab-wave-6-granularity.md`](../../archive/testing/playbooks/lab-wave-6-granularity.md).

| Tier | When Steward uses `playbook:` on worker cards |
|------|-----------------------------------------------|
| **A — prose-skilled default** | Simple [SUPPLY] one-site gather/deposit (e.g. chop-oak-8 class) |
| **B — playbook** | Preflight gates (A2), `[run_state]` resume (A3), multi-step composition with sub-plays (A4) |
| **C — lab / TBD** | Multi-anchor platform (`tower-platform-3x3`); playbook id for coarse arm only |

Do not treat Stage 4 A1 % improvement on flat chop as a live KPI.

## Validation strategy

- **Schema lint on every commit.** `scripts/check-conventions.mjs`
  extension reads `data/playbooks/registry.yaml`, walks each `doc`,
  asserts the phase table is present and column-formatted, and
  verifies every `use_playbook:` reference resolves to a registry id.
- **Playbook-id round-trip test.** Every id has a doc with matching
  front-matter.
- **Card-body parse test.** Cards with a `playbook:` header naming an
  unregistered id are rejected at create time.
- **Per-phase L3 fixtures.** Each shipped playbook gets ≤ 3 fixture
  scenarios: one happy-path, one branch-table case, one composition
  or checkpoint-resume case.
- **Stress scenarios in the followup pass.** Routed by
  `scripts/stress.sh`: bot-only specs under `data/test-fixtures/stress/`
  (via `run-fixture.sh` / L3); agent specs under
  `data/agent-tests/playbooks/` (via `agent-test.py`). Pass criteria
  include falsifiable assumptions A1–A4 from the followup pass.

## Anti-hallucination

- **Closed playbook id registry.** Steward references only ids that
  exist; the kanban facade rejects unknown ones.
- **Closed sub-play references.** A phase's `use_playbook:` resolves
  against the same registry; a lint catches drift.
- **Markdown discipline + sync test.** Phase tables follow standard
  columns; lint rejects malformed tables.
- **Verb whitelists per phase.** Workers can only call listed verbs
  during a phase; the SOUL rule plus telemetry post-checks catch
  drift.
- **Branch tables key off existing error codes.** No new code names;
  branches resolve against `bot/lib/shared/action-contract.js`.

## Path to the scripting layer (Layer B)

[`agent-scripting-layer.md`](../../specs/agent/scripting-layer-dsl.md) describes the
eventual runtime substrate (region selectors, pure-query DSL Layer A,
`call()` engine Layer B). When that runtime exists, a playbook phase
becomes:

```js
// hypothetical Layer B implementation of phase `ascend`
function ascend(ctx) {
  return runPlay('pillar_up_safe', {
    count: ctx.trunk_logs_seen - 1,
    block: ctx.scaffold_block,
    side_check: 'every_block',
  });
}
```

— same composition, same checkpoints, now executable and fixturable as
code. Until then, the markdown phase table is the play and the worker
SOUL is the interpreter.

## Out of scope this round

| Idea | Defer because |
|---|---|
| Bot-side playbook engine (auto-walk phases without LLM turns) | Existing SOUL + worker LLM walks the table fine; revisit if Stage 4 turn-per-card data shows the LLM cost dominating. |
| Layer A query DSL surfaced as `mc` verbs | The phase table's `preflight`/`verify` rows compose existing read-only verbs. |
| Layer B `call()` runtime | Same as above; playbooks are documentation today. |
| Worker-authored playbook drafts at runtime | Hallucination surface too large; Steward picks from the catalog. |
| Multi-level recipe recursion in `craft_plan` | `craft.from_inputs` playbook with sub-card dispatch covers the blue_wool case. |
| Cross-playbook merge / inheritance | Single-level composition (`use_playbook:`) is enough this round. |
| Reactive policy in playbooks | Stays in the reactive layer per existing doctrine. |

## Related work

- Companion: [`agent-scripting-layer.md`](../../specs/agent/scripting-layer-dsl.md) —
  the eventual runtime substrate.
- Delivery vehicle:
  [`improvement-pass-followup.md`](../../archive/testing/playbooks/improvement-pass-followup.md).
- Observation verbs:
  [`observation-verb-grammar.md`](../../specs/mc/observation-verb-grammar.md).
- Existing five-phase mining template: `skills/minecraft-mining.md`.
- Action contract: `bot/lib/shared/action-contract.js`.
- Reactive doctrine: `docs/archive/phase-2-design/reactive-layer.md`.
- Coordinate convention: `docs/reference/world-coordinates.md`.

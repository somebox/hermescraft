# Observation verbs — grammar, naming, and response shapes

Status: draft / planning. Package 1 (May 2026) implemented the **status = self / scene = world** split in code; see below. CLI registry (2026-05): the former **`observe` command group** is renamed **`perceive`** in `mc commands --category perceive`; the verb **`mc observe`** is unchanged (orchestration snapshot).

**Strategy owner:** typed nouns, symmetric success, and perceive-lane consolidation are **step 1** of the delivery chain in [`../../architecture/embodied-control.md`](../../architecture/embodied-control.md). This spec is the technical detail; embodied-control is the organizing policy (registry vs agent surface, facades, evidence loop).

## Package 1 shipped (status = self, scene = world)

- **`GET /status`** no longer embeds `nearbyBlocks`, `notableBlocks`, or raycast `scene`. Lean status returns `supplies`, `holding` (with tool `durability_left` when applicable), `nearby_entities`, optional `situation` and `hand_vs_inventory`.
- **Fleet agents call `mc status`**, which always uses **`slimStatusEnvelope`** in `bot/cli/index.mjs` — server-only changes do not reach agents unless the envelope passes fields through.
- **`mc scene`** (and lean `/scene`) includes a **`topology`** block from `standingState()` plus a one-line locale summary (pit-with-sky vs sealed vs head-block).
- **`mc anchors`** uses marks with `chest_snapshot` on `GET /marks`, not a world block scan on status.
- Deferred after genesis validation: `status --goal`, `status --near_mark`, equipped armor on status, resolver semantic aliases.

**Post–package 1 usage (May 2026):** Re-run `scripts/mc-call-survey.py --minutes 10080` after the cheatsheet/registry audit ([`docs/reference/audits/audit-mc-commands-2026-05-29.md`](../../reference/audits/audit-mc-commands-2026-05-29.md)): **752** sessions, **38,397** `mc` calls, **181** registry commands. Traffic still concentrates on ~30 verbs; `inventory` (1,416) remains heavy beside `status` (1,988) — doctrine says self-only, habits lag. `inspect` (2,126) + `terrain_top` (1,020) rival `scene` (1,276) for “what’s here?” **`advise`** 55 calls in 7d (rare escape hatch, not per-turn). **38 commands had zero fleet use** in that window (combat advanced verbs, `construct`/`repair`, `bg_combo`/`bg_fight`/`bg_strafe`, `fish`, boat low-level except `sail_to` 24, `regions_reload`/`regions_terrain`, etc.) — treat as **exposure gap**, not failed design, until genesis/cards assign them.

**Route brief on observe (nav refactor, 2026-05):** when `HERMES_NAV_BRIEF=1`, `mc observe` includes **`nav_brief`** / **`nav_brief_text`** — precomputed movement lines for the current cell (replaces `nearby_marks`). Agents should prefer copying a brief line over rebuilding routes from `scene`/`map`. See [`route-precompute-context.md`](../nav/route-precompute-context.md) and skill [`skills/minecraft-navigation.md`](../../../skills/minecraft-navigation.md).

Scope: the `mc` observation/perception verbs — how an agent *asks* about the world (verbs, naming, flag grammar) and what *comes back* (response shapes). The deeper "let agents write code against primitives" direction lives in its companion, `agent-scripting-layer.md`; this document stays at the verb-and-shape level.

## Problem

The observation verbs grew one at a time, each solving a real moment, but they now overlap on geometry and split on intent. An agent that wants one plain answer ("where is wood and can I reach it?") must choose between `find`, `find_blocks`, and `discover`; an agent that wants "what's my situation?" must combine `status`, `inventory`, and `observe`. The verbs also disagree on flags and on how they name the same thing.

Three concrete symptoms:

- **`status` is overloaded yet still feels incomplete.** Package 1 removed the embedded world-scan from lean `status`, but agents still pair `status` with `inventory` / `inspect` / `terrain_top` for one mental question. Goals and task history remain on `mc observe` (orchestration snapshot). `status --goal` is still deferred, so “how much wood for this card?” is not one read yet.
- **Three verbs for one question.** `find` (inventory + chests + visible), `find_blocks` (x-ray coords), and `discover` (category scout) answer "where is X" at different resolutions with different response shapes, and none of them offers "I don't have it — where do I go, or what substitutes?"
- **Three verbs for "what's around me."** `nearby` (cube scan), `map` (2D surface), and `scene` (LOS rays) overlap. `map` describes the horizontal plane well and the vertical axis poorly. `scene` is what agents reach for when blocked or aligning, but its output is a flat list of block names, not a picture of topology.

## Evidence (this is a data-driven redesign)

Two repo tools quantify the problem.

**Verb mix** — `scripts/mc-call-survey.py` over a 7-day window (715 sessions, ~37,013 `mc` calls). The visual/assessment cluster is ~24% of all calls:

| Verb | Calls | % of all | Role |
|------|------:|---:|------|
| inspect | 1,983 | 5.36% | single-cell probe |
| status | 1,942 | 5.25% | self + embedded mini-scene |
| find_blocks | 1,548 | 4.18% | x-ray block coords |
| scene | 1,176 | 3.18% | LOS situational read |
| nearby | 1,002 | 2.71% | cube scan + entities |
| map | 513 | 1.39% | ASCII surface |
| find | 287 | 0.78% | inventory/chest/block sources |
| look | 244 | 0.66% | cardinal prose |
| observe | 159 | 0.43% | goals/task snapshot |
| advise | 53 | 0.14% | LLM digest |
| discover | 19 | 0.05% | category scout (near-dead) |

Read-outs: `find_blocks` beats `find` + `discover` combined because it returns coordinates; `discover` is effectively dead; `observe` is a Steward (orchestration) verb, workers live on `status`; `advise` is a rare escape hatch, not a per-turn tool.

**May 2026 rerun (same tool, 7d / 38k calls):** Rank order unchanged in spirit — `move` ~12.6%, then `inspect` / `dig` / `status` / `find_blocks` / `inventory` / `goto_near` / `scene`. Discovery cluster ≈ **2,745** calls (`find_blocks` + `find` + `chest_search` + `discover`). World-vision cluster ≈ **6.5k** (`scene`, `nearby`, `map`, `look`, `look_at`, `inspect`, `terrain_top`, `standing`, `reachable`, `scout`). Regenerate this table after major doctrine or registry changes.

**Failure distribution** — `scripts/analyze-mc-failures.py` over the cognition logs: of 3,438 recognized `mc <verb> <material>` calls, **1,519 failed (44%)**. The category histogram:

| Category | Count | Nature |
|----------|------:|--------|
| other | 838 | mixed |
| pathfind_failed | 185 | where (navigation) |
| already_block | 134 | state (cell occupied) |
| view_blocked | 131 | where (line of sight) |
| no_solid_neighbor | 64 | where (placement geometry) |
| refusing_to_dig | 44 | with-what (no tool) |
| nav_blocked | 30 | where (stuck) |
| region_protected | 27 | permission |
| **unknown_name** | **7** | **what to call it (0.5%)** |

The decisive finding: **material-name recognition is not the failure mode** (0.5%). Agents pick correct Minecraft names. The 44% failure rate is dominated by **where / when / with-what-tool / what-state** — exactly the questions the perception layer is supposed to answer before the agent commits to an action. The redesign therefore optimizes the *perception and response* surface, not the naming/aliasing surface (that is a separate thread: `resolver-semantic-aliases.md`).

## Mental model — four lanes

Sort every observation question into one of four lanes. Each lane has one primary verb, so an agent picks the lane from the question, not from a memorized cost table.

| Lane | The question | Primary verb | Cost |
|------|--------------|--------------|------|
| **Self** | Who am I, what do I carry, what's urgent right now? | `status` | low |
| **Locale** | What's in reach / line of sight — why can't I move, what am I facing? | `scene` | medium |
| **Expedition** | I don't have it — where do I go to get it (or what substitutes)? | `search` | medium–high |
| **Chart** | Where am I in space, including vertically? | `map` | medium |

Orchestration data (goals engine, task history, alerts, recent actions) is *not* a perception lane — it stays on `observe` (or a `status --mission` slice) so vision and mission don't tangle. Two micro-verbs stay as-is because the data shows agents like point checks: `inspect` (one cell) and `standing` (local topology).

The current set already has these lanes implicitly, but spreads each across multiple verbs: Self over `status`+`inventory`+`observe`; Expedition over `find`+`find_blocks`+`discover`; Locale over `scene`+`nearby`+`look`; Chart over `map`+`terrain_top`. The core move is collapsing each lane to one primary verb plus flags.

## Naming and flag grammar

Consistency across verbs is half the value. The proposal standardizes the grammar so the same flag means the same thing everywhere:

- **Verbosity, identical on every verb.** `--lean` (minimal, stable schema) and `--verbose` (same schema, more rows/coords/debug). During migration `--full` aliases `--verbose`. Poll-style verbs (`status`, `scene`) default lean; expedition verbs default verbose-by-need.
- **Anchor scope.** `@mark` (e.g. `status @base`) adds, for that mark: distance from bot, bearing, and entities near the mark. Anchors come from the existing `locations-*.json` store, so genesis `lt_*` marks work immediately.
- **Goal scope.** `--goal <id>` (or auto from the active task card) filters counts and search to goal-relevant items. `status --goal supply_wood` reports oak_log/planks/sapling totals from inventory + known chests plus the current gap.
- **Reason, only where it pays.** `--reason "..."` is reserved for the intent-shaped, expensive paths (`search`, `advise`); it is not bolted onto cheap polls.

Naming rule of thumb: the verb is a plain verb of intent (`status`, `search`, `scene`, `map`); the noun/region it acts on is an argument, not a new verb. This is what lets `find`/`find_blocks`/`discover` collapse into `search [--category]` and `look` fold into `scene --cardinals`.

## Verb-by-verb (use cases → today → proposed)

### `status` — the self report

- **Use cases:** after a move (HP, food, position, held tool, mounted, submerged); "how much wood do I already hold and what's the gap" (`status --goal supply_wood`); "anyone near base?" (`status @base`); am I in a protect region now?
- **Today:** `getFullState` returns vitals + holding + inventory *and* a raycast scene + block cube + entities; `briefState` (attached to every action) carries neither scene nor inventory; goals live on `observe`. A fast self-read is entangled with a slow world-scan.
- **Proposed:** pure self-state, never runs a raycast or `findBlocks` (stays cheap to poll, and stops clearing escape/stuck state as a side effect of a "what's my HP" call). Core: position, vitals, holding (+ armor), mounted, hazards, regions_here, stuck_warning. Add `supplies` (goal-derived or top items), `@mark` block, `--lean`/`--verbose`. The world-scan moves to `scene` and `search` where it belongs.

### `scene` — the locale picture

- **Use cases:** "why can't I move right?" (blocked dirs, head-level block, step-down, entity behind); "am I aligned with the furnace/log/door?"; "trapped in a hole with open sky above" vs "closed alcove"; "zombie behind me"; pre-collect "is the trunk in line of sight?".
- **Today:** `buildSceneSummary` raycasts a FOV cone, groups hits by block **name**, lists lava/fire hazards, emits prose + a fair-play disclaimer. `standing` separately classifies the immediate cell, but agents use `inspect` more. Nothing describes "passage", "ledge", "open above" as a concept.
- **Proposed:** keep prose, add a structured `topology` block — `footing: flat|uneven|air_below`, `headroom`, `passage: {bearing, width_hint}`, `drop: {dir, blocks}`, `enclosure: pit|alcove|open`. Entities bucketed by bearing sector, explicitly including **behind**. Optional `--target X Y Z` returns distance/delta + `facing_ok`/`need_turn` for alignment. `look` folds into `scene --lean --cardinals`; `nearby`'s entity list folds into `scene --verbose` / `status --entities`.

### `search` — the expedition planner

- **Use cases:** "do I already have iron?" (inventory + chests); "nearest oak_log I can reach?" (visible + x-ray with reachability); "any wood within 64m?" (category); "no iron anywhere, need fuel" (substitutes — not implemented today); "I saw coal yesterday" (last-seen memory).
- **Today:** `find` ranks inventory/chest/block with reachability; `find_blocks` is the x-ray scan; `discover` loops a category's block names. The `observedBlocks` map already records recently-seen blocks with decay but only leaks into scene text.
- **Proposed:** `search <resource|category>` returns the same five phases every time — `on_person`, `stored`, `in_range`, `memory`, `alternatives`. Flags: `--radius`, `--count`, `--reachable-only`, `--category wood|ore|food`, `--fair-play` (LOS gate for collect preflight; default x-ray for planning), `--lean`/`--verbose`. Doctrine collapses to **need stuff → `search`** — the single largest reduction in "which verb?" overhead, given find/find_blocks/discover are three habits today.

### `map` — the chart, with a vertical slice

- **Use cases:** disoriented (where is water/forest relative to me?); planning a wall/path line; vertical questions (cliff height, cave mouth, tree height, "air above this column?").
- **Today:** `generateMap` renders a top-down ASCII grid (`T`/`~`/`#`), one surface block per column — the vertical axis collapses to one char. `terrain_top` samples column heights separately.
- **Proposed:** `map [--radius]` unchanged; add `map slice` — a vertical cross-section. Two forms worth prototyping: `map column X Z` (one column surface→sky/depth as a strip) and `map slice --bearing north --width 5` (coronal cross-section through the bot, so cliffs/overhangs/tree height read directly). Doctrine: `map` for layout, `scene` for immediate interaction, `map slice` when Y matters.

### `observe` / `advise` — orchestration and the expensive interpreter

- `observe` is mission control (goals, task, alerts, recent_actions, idle_reason); runs no raycast and never calls an LLM. A `status --mission` slice can give workers brief + top goals + task in one cheap call so they stop reaching for `observe`.
- `advise` is the one expensive, LLM-backed interpreter; it should wrap `search --verbose` + `scene` + `map` + the mission snapshot under `--reason`, and return 1–2 concrete `next_mc` suggestions. Explicit escalation (stuck, repeated failure, boat-vs-walk), not a per-turn read — matching the data (53 / 37,013 calls).

## Response shapes — mirror the verb (action) on a typed noun

The shapes the model reads every turn matter more than any skill file, because they're read far more often. Today the contract (`bot/lib/shared/action-contract.js`) is asymmetric: **failure is richly typed** (`{ code, message, observed_state?, next_action_hint?, retry_safe }`) while **success is prose** (`result` string + ad-hoc `data`). And the same real-world thing is described differently by each verb — an oak log is `{name, pos}` in scene, `{x,y,z,distance,bearing}` in find_blocks, `{block:{...}}` in inspect.

Three evolutions:

### 1. A typed noun vocabulary, reused everywhere

Every verb that refers to a kind of thing emits the same shape, so the model learns one schema, not six:

```text
Block    { name, pos:{x,y,z}, dist, bearing, reachable?, approach_cell?, tool_needed?, attrs?{} }
Entity   { kind:'mob'|'player'|'item', name, pos, dist, bearing, health?, hostile?, attrs?{} }
Location { mark, pos, dist, bearing, note?, kind:'protect'|'resource'|'marker' }
Item     { name, count, where:'hand'|'inventory'|'chest:<mark>', attrs?{} }
Landform { kind:'tree'|'pond'|'cliff'|'field', anchor:{x,y,z}, extent?, members?, attrs?{} }
```

The shared spatial primitives — `pos`, `dist`, `bearing` — are exactly what the agent needs to decide what to do next, and they're computed already (`bearingFromDelta` in `perception.js`) but not threaded through `find`/`inspect`/`marks`. `attrs` is the noun-specific escape hatch (a chest's free slots, a furnace's fuel/progress, a log's species, a mob's equipment) so the common shape stays small. `Landform` is where the tree/pond clustering idea lands — `search --category wood` returns one `Landform{kind:'tree'}` instead of N `Block` rows.

### 2. A `delta` and `goal` block on every relevant result

Promote the prose `result` to structured outcome that the prose is *rendered from*:

```js
{
  ok: true,
  verb: "collect",
  delta: { item: "oak_log", gained: 8, requested: 12, remaining_request: 4 },
  subject: { /* typed Block/Item it acted on */ },
  inventory_now: { oak_log: 20 },
  goal: { id: "supply_wood", counts: ["oak_log","birch_log","oak_planks"], have: 60, target: 96, gap: 36 },
  result: "Mined 8/12 oak_log. Wood supply 60/96 (gap 36)."
}
```

"Goal is wood, so also say how much wood of all kinds" is exactly the `goal` block. The goal engine (`scoreGoals`) already maps `supply_wood` to a metric over several item names, so the join is wiring, not new computation. `delta.remaining_request` also dissolves the success/failure asymmetry: a partial collect (8/12) is read as progress, not parsed out of a sentence.

### 3. Prose as a projection, and symmetric `state_after`

- Generate the `result` prose *from* the typed fields (one renderer, as `bot/cli/output.mjs` already does for maps/scenes) so prose and data can't drift — a recurring failure pattern is the agent acting on the prose while the structured data says something subtler (nearest candidate is unreachable, but the sentence leads with its coords).
- Add an optional `state_after` on success, symmetric with failure's `observed_state`, so "I got the wood but I'm now in a hole" surfaces without a follow-up `scene`.

### How shapes mirror the model

| Question | Lane (verb) | Mirrored in the response |
|----------|-------------|--------------------------|
| What changed? | any action verb | `delta`, `subject`, `state_after?` |
| What did I act on? | action / `inspect` | typed `Block`/`Entity`/`Item` |
| Where is it, can I reach it? | `search`, `scene` | shared `pos`/`dist`/`bearing`/`reachable`/`approach_cell` |
| Why do I care? | `status --goal` | `goal` block on relevant results |
| What's the thing's nature? | `inspect`, `scene` | `attrs{}` (species, fuel, fill, hostility) |

## Doctrine shift (before → after)

| Old habit (data-backed) | New habit |
|-------------------------|-----------|
| `status` + `inventory` + `observe` for a wood card | `status --goal supply_wood` once |
| `find_blocks oak_log` → `goto_near` | `search oak_log --reachable-only` |
| `scene` when collect fails | `scene --target …` (alignment) or `scene` + `standing` |
| `map` when lost | `map`, or `map slice` when height matters |
| `discover logs` | `search --category wood` |
| `advise` mid-loop | `search` + `scene`; `advise` only when stuck |

## Directions beyond verbs (pointer)

Two larger directions extend this work; both are captured (or sketched) in `agent-scripting-layer.md` and should not bloat the verb layer:

- **Region selectors** — a shared addressing grammar (`x,y,z`, `me r=1`, `3m north`, `@base r=8`, `box(p1,p2)`) so one resolver feeds every verb and the typed-noun shape comes back regardless of how the region was expressed.
- **A query/actuation language** — dot-chains for pure reads, `call(verb,...)` for the only mutation path (reusing the existing verb registry as the actuation vocabulary). The typed nouns and `delta`/`goal` shapes here become the return values there.

## How to explore and validate

This is a behavior change to a token-sensitive, agent-facing surface, so validate it the way perception work already is in this repo: deterministic unit tests for the new outputs, context-tests for decision quality, and a live A/B. Nothing here ships on intuition.

- **Phase 0 — shadow, don't replace.** Add new fields behind flags without removing anything: `status --goal <id>`; `scene` `topology` (start by extending `standing`'s classification to a 3-block reach); `search` as a thin facade over `find`/`find_blocks`/`discover` + `observedBlocks` memory; `map column X Z`. Measure payload sizes against current verbs so "lean is smaller" is provable.
- **Phase 1 — deterministic tests.** Unit-test `search` ranking and `scene` topology on synthetic fixtures (mirror `bot/test/perception.test.js` and the L0 scene/nearby fixtures). A noun-shape contract test (analogous to `validate()` in `action-contract.js`) asserts every verb emitting a block/entity/location uses the shared shape — the cheapest way to stop drift.
- **Phase 2 — context-tests (decision quality).** Add scenarios under `data/context-tests/` with synthetic `status`/`observe` fixtures (harness in `scripts/context-tests/`). The failure distribution above is the scenario backlog: "blocked moving east, passage south" (view_blocked / nav_blocked), "collect target not visible — expect search/scene first" (NO_VISIBLE_BLOCKS, 87% of `collect iron_ore`), "holding empty, inventory has pickaxe" (refusing_to_dig), "goal already met from chests" (goal block changes the first action). Heed the rubric-coupling caution in [`docs/reference/fleet-notes.md`](../../reference/fleet-notes.md): don't let the prompt recite the verb the matcher rewards.
- **Phase 3 — live A/B.** Run the same genesis card twice (new doctrine vs current verbs) and compare with `scripts/mc-call-survey.py` (does `search` absorb find/find_blocks/discover; does "which verb?" thrash drop), `scripts/analyze-mc-failures.py` (do view_blocked / no_visible_blocks rates fall after `scene` topology), and `scripts/agent-context.py` (does slimmer `status` + one-call `status --goal` cut per-turn context). Pre-register success criteria (fewer observation calls per completed card, lower spatial-failure rate, no completion regression). Treat any single run as signal, not proof — the same caution as the goals-gap context reports (`docs/testing/context-tuner/reports/`).
- **Phase 4 — migrate and deprecate.** Point skills/SOULs at the four-lane model; alias old verbs (`find`→`search`, `discover`→`search --category`, `look`→`scene --cardinals`) for one release; update `KEY_PRIMITIVES` in `mc-call-survey.py` so adoption is tracked. Keep HTTP paths (`/status`, `/scene`, `/map`) stable and route new CLI names to existing endpoints internally to limit blast radius.

## Registry scale vs intent taxonomy (May 2026)

Two different groupings exist; they are **not fully aligned**:

| Source | What it groups | Purpose |
|--------|----------------|---------|
| `bot/cli/registry.mjs` → `docs/reference/mc-cheatsheet.md` | **11 categories** (`observe` 24, `world` 68, `task` 19, …) | `mc help`, generated inventory |
| `docs/reference/mc-command-reference.md` §A | **Intent** (observe / movement / world / building / …) | Agent grammar, chains, argument vocabulary |

**Revelation:** Cheatsheet length (**181** lines) is an **implementation catalog**; fleet behavior follows a **~30-verb core**. Zero-use commands are often **newly exposed** (registry + examples backfill landed before cards/skills taught them).

**Intent mismatches to resolve** (pick registry category *or* doc intent, then test/sync):

| Command | Registry / cheatsheet section | `mc-commands.md` intent |
|---------|------------------------------|-------------------------|
| `escape`, `through` | world | movement |
| `deathpoint` | movement | (memory / marks narrative) |
| `set_home` | world | world (memory-adjacent) |
| `check`, `blueprint`, `craft_plan` | observe | observe (behaviorally world/build) |
| `construct`, `repair` | building | building ✓ |

**Overlap clusters** (same question, many verbs): perception self (`status`, `inventory`, `observe`, `health`); perception world (`scene`, `nearby`, `map`, `look`, `inspect`, `terrain_top`); discovery (`find`, `find_blocks`, `discover`, `chest_search`); predicates (`check`, `verify_plot`, `is_empty`, `is_filled`, `is_sheltered`, `farm_status`, `blueprint verify`); navigation (`move`, `goto`, `goto_near`, `through`, `escape`, boat stack).

## Simplification candidates (next steps)

These are **design options**, not committed API. Prefer HTTP-stable aliases and skills-first doctrine before deleting registry entries.

1. **Core cheatsheet for skills** — Inject a “Core ~40” list (survey percentiles + package-1 lanes) in worker SOULs; full list via `mc help` / `mc commands`. Reduces recall load without removing handlers.
2. **`mc search` facade** — One verb with flags (`--blocks`, `--category`, chests) over `find` / `find_blocks` / `discover`; aligns with four-lane model and Layer A in `agent-scripting-layer.md`.
3. **`mc verify <sub>`** — Noun-style subcommands: `shelter`, `plot`, `empty`, `filled`, `farm-status`, `region` (maps `is_sheltered`, `verify_plot`, `is_*`, `check`, blueprint verify). Low volume (~tens–low hundreds/week) but high card value; easier recall than four predicate verb names.
4. **`mc build <sub>`** — Namespace for `place`, `wall`, `fence`, `stairs`, `level`, `level_ground`, `path`, `fill`, plus card orchestration `construct` / `repair`. Cheatsheet today splits “building” (2 cmds) vs “world” (68).
5. **`mc survey`** (optional) — Read-only `scout`, `terrain_top` under one name; distinct from `verify`.
6. **Registry `intent` field** — Mirror `mc-commands.md` §A on each `CmdDef`; CI asserts `intent` ∈ known set (like `category` ∈ `CATEGORY_ORDER`). Stops help sections and doctrine from drifting.
7. **Profile-scoped help** — `mc help --profile mason` filters categories/verbs (future).
8. **Re-survey after genesis cards** that assign `construct`, `regions_terrain`, combat verbs — compare zero-use list; update `KEY_PRIMITIVES` in `mc-call-survey.py`.

**Relation to nav refactor:** [`route-precompute-context.md`](../nav/route-precompute-context.md) LOOK/GO/DO collapses *movement + observation loop*; this doc collapses *perception + discovery + predicates*. Both can proceed in parallel with shared `mc-call-survey` metrics.

## Open questions

- **A.** `status @base` with no marks in the store — omit the anchor block silently?
- **B.** `search` default: x-ray for planning vs fair-play LOS for honesty. (Proposal: x-ray default, `--fair-play` opt-in for collect preflight.)
- **C.** Merge `observe` into `status --mission`, or keep two endpoints because the dashboard polls `observe`?
- **D.** Does `terrain_top` become `map height`, or stay separate given ~2.4% live usage?
- **E.** How much topology can `scene` compute before it stops being low-medium cost? Measure latency in Phase 0, don't guess.
- **F.** Scalar vs collection results when a verb's region matches many cells — one shape that varies by receiver, or two?
- **G.** Should `mc-commands.md` §A become the canonical `intent` and registry `category` become help-only, or should both stay and sync via tests?
- **H.** Pilot `mc verify` / `mc build` subcommands as CLI-only aliases first, or wait for `search` / four-lane migration?

## Related work

- Route brief / move-canonical DSL: [`route-precompute-context.md`](../nav/route-precompute-context.md), [`skills/minecraft-navigation.md`](../../../skills/minecraft-navigation.md).
- Scripting / region selectors / query-actuation language: `agent-scripting-layer.md` (companion).
- Perception modes and their differing semantics: `docs/archive/experiments/phase-2-sprint-log.md` (§F11).
- Perception digest / `mc advise`: `docs/archive/perception-digest-experiment.md`, `skills/minecraft-perception-advise.md`.
- Name-resolution (parallel, non-spatial layer): `resolver-semantic-aliases.md`.
- Coordinate convention: `docs/reference/world-coordinates.md`.
- Live failure analysis: `scripts/analyze-mc-failures.py`, `reports/genesis/2026-05-28-mc-failure-analysis.md`.
- Verb-usage survey: `scripts/mc-call-survey.py`.
- Command registry audit (cheatsheet sync, examples, schema caps, guardrail tests): [`docs/reference/audits/audit-mc-commands-2026-05-29.md`](../../reference/audits/audit-mc-commands-2026-05-29.md); cadence note in [`docs/reference/fleet-notes.md`](../../reference/fleet-notes.md).

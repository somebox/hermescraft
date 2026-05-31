# Navigation & planning refactor: from prompt-reasoning to movement primitives

> File: `docs/features/route-precompute-context.md` (kept for link stability; the route-precompute brief is Pillar 3 of this broader navigation refactor).

Status: **shipped in code (2026-05-30)** — Phases 0a–3 implemented behind flags (`HERMES_RETRACE_TRAIL`, `HERMES_MOVE_RESOLVE`, `HERMES_NAV_BRIEF=shadow|1`). Rollout: shadow → SLO calibration → single-profile canary → fleet. See `bot/lib/config/README.md` and `bot/lib/runtime/nav-brief.js`.

## Thesis

Today the agent navigates by **reasoning over geometry in the prompt**: it pulls raw blocks (`scene`, `map`, `nearby`), builds a 3D picture in-context, guesses a move, and frequently guesses wrong. This refactor moves that work **out of the prompt and into bot primitives**:

- the bot **lays string** as it moves (breadcrumbs of standable cells) so "where I've been" is a primitive, not something the LLM reconstructs from history;
- movement collapses into a **small DSL** (LOOK / GO / DO) so the agent picks a verb instead of deriving one;
- each round the bot **precomputes a brief** of reachable destinations as DSL lines, so the LLM **chooses a line** rather than solving a maze.

The LLM's job shifts from *deriving* paths to *selecting* among precomputed, honest options. Geometry stays in the engine that owns it.

### Evidence this is the right cut

From `docs/features/observation-verbs-redesign.md` (data from `scripts/mc-call-survey.py` / `scripts/analyze-mc-failures.py`): of 3,438 recognized `mc <verb> <material>` calls, **1,519 (44%) failed**, dominated by `pathfind_failed` / `view_blocked` / `no_solid_neighbor` / `nav_blocked` — "I reasoned about geometry and guessed wrong." Material naming failed **0.5%**. Separately, the visual/assessment cluster (`scene`, `map`, `nearby`, `find_blocks`, `status`) is **~24%** of all `mc` calls (May 2026 rerun: ~38k calls / 752 sessions; world-vision cluster larger if `inspect` + `terrain_top` included — see observation doc). The failure mode and the token load are both in prompt-side geometry reasoning — exactly what moves to primitives here. **Parallel work:** shrinking the 181-verb cheatsheet (core list, `verify`/`build` namespaces) is independent of nav brief rollout; both should be re-measured with `mc-call-survey` after genesis cards expose new verbs.

## The three pillars

| Pillar | From (prompt) | To (primitive) |
|--------|---------------|----------------|
| **1. Movement DSL** | choose among `goto`/`goto_near`/`move`/`go_mark`/`sail_to`; reason which | one canonical **`move <target>`**; bot picks mode |
| **2. String-laying** | reconstruct "where I came from" from chat history | breadcrumbs recorded by the bot; expose crumb-backtrack in the CLI |
| **3. Per-round brief** | dump blocks, build a mental map, derive a move | read a flat list of reachable destinations as DSL lines |

Each pillar is grounded in existing code **where noted** (see *Grounding in existing code* and *Code verification (2026-05-30)*); the refactor consolidates and schedules it, it does not invent a pathfinder. **Where a pillar depends on code that is only partly built or greenfield, that is called out explicitly** — the plan is honest about existing-vs-greenfield (the brief, the refresh hook, junction promotion, and the CLI trail surface are all new work).

---

## Pillar 1 — A movement DSL (LOOK / GO / DO)

The `observe` and `movement` verb groups are the least intuitive surface in the CLI. Three verbs mean "walk to coordinates" (`goto`, `goto_near`, `move` — and the cheatsheet itself says prefer `move`, `goto` is power-user); "go there" fragments by destination type (`goto`/`go_mark`/`go_site`/`sail_to`/`deathpoint`); the `observe` group is a grab-bag holding non-perception verbs (`connect`, `fair_play`, `blueprint`). Collapse the whole surface onto the agent's actual loop — *what's true? → take me there → (if blocked) use a tool*:

| Bucket | Question | Verbs |
|--------|----------|-------|
| **LOOK** | What is true right now? | `status` (self), `scene` (locale, + `standing`), `map` (chart), `find` (expedition — collapses to `search` when `observation-verbs-redesign.md` ships), **brief** (routes — v1 ships inside `observe`, decision D1; a dedicated `mc brief` verb is deferred), `inspect` (cell) |
| **GO** | Take me to a place | one canonical **`move`**, `stop` |
| **DO** | Change world / move body | `dig`, `place`, `collect`, `pillar_up/down`, `stair_up/down`, `ladder`, `jump`, `retrace`, `escape` |

### One nav verb — `move` is canonical

**`move` is the canonical navigation verb** (not a new `go`). This is a code-forced choice: `goto` already owns the alias `go` (and `g`), and the registry's `buildAliasMap` throws on duplicate aliases (`registry.mjs`), so a new canonical `go` cannot be introduced without first stripping `go` from `goto` — a silent semantic flip for anyone typing `mc go X Y Z`. Making `move` canonical removes a *decision* (which of three nav verbs) rather than adding a verb; `goto` stays in the registry as `move --raw`'s implementation, and `move` is what every worker SOUL already trains.

```text
mc move <target> [--near N] [--raw] [--force]
```

> **This is the target grammar, not today's.** Today `mc move` requires **three numeric coordinates** — `dispatch.mjs` `case 'move'` throws `missing:coords` on fewer than 3, and there is no `--near`, `--raw`, `@mark`, or bare-name handling on `move`. Region refs (`:region:`/`:region:/site`) only work because `dispatch.mjs` **rewrites the HTTP action to `go_site`** for `goto`/`goto_near`/`move` — `move` itself never sees the ref. (Separately, `goto`'s `bodyFn` already passes a `mark` field when present, so coordinate-less mark nav has a partial precedent there, not on `move`.) Everything in this block beyond `move X Y Z` is **new work** (Phase 0b).

- **`<target>` resolves any destination:** `@mark`, `x,y,z`, `:region:`, `:region:/site`, bare mark name. Partly built: `dispatch.mjs` already rewrites a `:region:`/`:region:/site` first-arg on `goto`/`goto_near`/`move` to `go_site`. Mark/bare-name resolution into `move` is **new work**.
- **Bot picks the mode:** opens doors + refuses bad detours (today's `move` behavior); `--near N` = today's `goto_near` arrival range. Water (`sail_to`) is **deferred** (see below), not auto-folded in v1.
- **Escape hatches become flags:** `--raw` = today's `goto` (raw pathfinder, open-space power use) — **new flag**; `--force` already exists on `move` (overrides detour refusal) and keeps that meaning. Don't conflate them: `--raw` swaps the pathfinder mode, `--force` only relaxes the detour guard.

This removes the `goto`/`move`/`goto_near` decision — the top navigation footgun — by making the safe behavior (`move`) canonical and the raw pathfinder opt-in (`--raw`).

**Resolver must route through the `move` stack.** Today `go_site` and the dispatch ref-routing call raw `goto({x,y,z})` internally (`go_site.js`), so navigation to marks/regions skips door handling and detour refusal. For "safe by default" to be true on exactly the strategic destinations the brief surfaces, `go_site` / `go_mark` must be refactored to call the `move` stack once `move` is canonical. `go_mark` also has its own behavior to preserve (`pathfindGotoNear`, 15s cap, `last_visited`/`visit_count` bookkeeping in `marks.js`).

### DO = primitives, not navigation

`pillar_up/down`, `stair_up/down`, `ladder`, `jump`, `retrace`, `escape` are **body actions `move` cannot express** (vertical, scaffolded, recovery). Group them explicitly: "called by `move` and by the brief's repair hints; invoke directly only when `move` reports it can't." This is also what the brief surfaces in confined mode, so the layering matches.

### `perceive`, not `observe` (category)

Rename the muddled `observe` *group* to `perceive` and evict non-perception verbs (`connect`→platform, `fair_play`→config, `blueprint`/`check`→build, `craft_plan`→craft). The *verb* `mc observe` stays as the orchestration snapshot, no longer a perception lane — removing the category/verb name clash.

> **Name collision to resolve first:** `mc scene` already carries the **alias** `perceive` (`registry.mjs`: `g('scene', 'observe', ['perceive', 'vision'], …)`). A `perceive` *category* alongside a `perceive` *alias for scene* will confuse the cheatsheet, `mc commands --category`, and the agent's mental model. Before/with the rename, either drop `perceive` as a scene alias or pick a different category name. This is a Phase 3 prerequisite, not a detail.

### Migration is incremental (alias-over)

| Old | Becomes | Note |
|-----|---------|------|
| `move` | `move` (canonical) | already the trained verb; gains target resolution |
| `goto` | `move --raw` | raw pathfinder kept as a flag; `goto`/`g` aliases retained during migration |
| `goto_near` | `move --near N` | arrival range as a flag |
| `go_mark` / `go_site` | `move @mark` / `move :region:/site` | refactor internals to call the `move` stack — today `go_site` calls raw `goto`, `go_mark` calls `pathfindGotoNear` (neither gets door/detour handling) |
| `sail_to` | `sail_to` (unchanged in v1) | water folding **deferred** — multi-phase orchestrator, not a thin alias |
| `deathpoint` | `move @deathpoint` | today `deathpoint()` uses `pathfindGotoNear` (like `go_mark`, range 3), **not** `goto`/`move` — preserve death-reach semantics, not just the alias |

Keep every old verb as a registry alias; `prompts-sync.test.js` catches deprecated tokens in prompts. Do **not** strip `go`/`g` from `goto` until prompts/SOULs are migrated (the alias map throws on duplicates, and a bare `mc go X Y Z` must not silently change meaning mid-migration). `flee --to` stays in combat (retreat semantics); whether `collect` folds into `move` is open (it embeds its own pathfinder).

---

## Pillar 2 — String-laying (breadcrumbs as a primitive)

Theseus' thread: as the bot moves it **lays string** — records standable cells — so the path back is never re-derived. The laying half **already exists and runs** (`nav-trail.js`: `sampleNavTrailCrumb` is called every ~5s by the stuck watchdog in `manager.js` when on ground, and by `excavation.js`; teleport clears it). The following-back half is **only partly built**, and the refactor must finish it:

- **Lay (exists)** — crumb sampled when on the ground and moved ≥ `MIN_SPACING` (2); cap `TRAIL_CAP` (64); `TRAIL_TTL_MS` (30 min) decay; clear on teleport (`jump > 8`). Single-writer (the module).
- **Promote (shipped)** — junction crumbs (`last_dig_site`, etc.) on dig/place/move/descent hooks.
- **Follow back (shipped).** `mc retrace --trail` → `use_trail:true`; plain `mc retrace` still defaults to `stair_down` `lastDugSteps`. The brief's `back:` line emits **`retrace --trail`** (or a crumb `move x,y,z`) when breadcrumbs exist.
  - **Fallback behavior:** `resolveRetraceTrail` falls through to `lastDugSteps` when `use_trail` is set but the TTL-filtered crumb list is `< 2` (`navTrailCrumbsNewestFirst` applies the 30-min cutoff). `--trail` therefore is not a hard guarantee of crumb-walk; the brief's `back:` line should not promise crumb fidelity when the trail is thin.
  - **Server-only:** `resolveRetraceTrail` also accepts `args.mark` (synthesises a two-point start→mark trail), unused by the CLI.
- **Simplify (shipped)** — collinear merge in `nav-trail.js`. Note `refreshNavTrailFromHistory` remains a **dead stub** (no callers).

The string is **volatile traversal memory**, distinct from durable **destinations** (marks). It is single-writer (the bot, via `sampleNavTrailCrumb`), self-pruning, and never persisted across cycles. `clearNavTrail` fires on teleport (`nav-trail.js`), respawn (`lifecycle.js`), reconnect (`manager.js`), and the `status` path (`http-app.js`) — so the string drops on death/reconnect (consistent with "volatile"), but a *natural* death only clears it on the respawn action, not at the moment of death. The journey line must tolerate a crumb string that survives until respawn.

---

## Pillar 3 — The per-round brief

At the start of each cycle the bot computes a compact **navigation brief**: which key locations are reachable now, the best DSL line to each, repair hints when blocked, and a confined-vs-open mode signal. The agent reads it instead of dumping blocks.

**"Cycle" = the agent's wake/turn boundary, surfaced through the read it already makes.** Decided (D1): the brief is computed lazily when the agent reads `observe`/`status` (the once-per-turn orientation read), not on a server timer. That makes the brief's freshness exactly the agent's decision cadence and avoids a background recompute loop. The within-round refresh hook (Phase 2) covers mutations *between* those reads. A dedicated `mc brief` (open question C, deferred) would move the trigger to that call with the same cadence. There is no "round" object in the code today — this boundary is **new plumbing** wherever it lands.

### Brief shape — situated header + flat DSL lines

A **typed `nav_brief` block is the canonical source of truth**; the flat text the agent reads is a **deterministic render of it** (struct in the payload, text projection for the agent — the split `mc find` and `find_blocks` already use, returning rich objects that the CLI/skill layer flattens). This resolves the apparent tension between "no JSON for the agent" and the provenance/reconciliation guarantees below: tooling, tests, and the reconciler read the struct; the agent sees text. "No JSON on the hot path" means **none shown to the agent**, not none computed. (Caveat: `observation.js`/`buildObservePayload` returns a JSON object for `GET /observe`; the agent-facing flattening lives in the CLI envelope, not in observe itself — so the render step is genuinely new code, not a reuse of an observe pretty-printer.)

**Versioned contract (`nav_brief` v1).** Because the brief replaces the `nearby_marks` field and may move from `observe` to a dedicated verb, lock a small envelope from day one so tooling/tests/readers don't break on iteration:

| Key | Purpose |
|-----|---------|
| `schema_version` | `"nav_brief/1"` — bump on breaking field changes; readers gate on it |
| `brief_id` / `computed_at` | identity + freshness stamp (the header's `as_of` renders from `computed_at`) |
| `pos_snapshot` | bot cell the brief was computed from — lets the freshness hook detect "agent moved/dug since" |
| `nav_mode` | `confined` / `open` (+ signals) |
| `paths[]` | the typed lines (label, verb, args, annotations, `seen`/`inferred`, `profile`) |
| `journey` | the compact crumb summary (surfaced separately, see *Decision vs journey*) |
| `stale_reason?` | set when degraded (below) |

Keep the envelope additive: new optional fields don't bump the version; renames/removals do. This is the **whole** contract — don't grow it speculatively.

The agent-facing render is a **situated header + a flat list of `label: verb args` lines**, ordered by relevance. No utility scores, no nested legs.

**Line grammar:**

```text
<label>: <verb> <args>            <annotations>
```

- **label** — a mark (`base`, `chest_food`), a feature (`iron_ore`, `stairs_down`), a trail cell (`back`), or a frontier (`unexplored_ne`).
- **verb + args** — a runnable DSL command, copied verbatim. Mostly `move <target>`; a DO primitive only when `move` structurally can't.
- **annotations** — inline honesty/cost tags (below).

**Mark rendering rule:** `move` accepts both `@mark` and a bare mark name. The brief renders the **bare name** for marks (`move base_anchor`) to match how `go_mark`/SOULs already read; `@mark` remains valid input and is used in prose here when disambiguating a mark from a coordinate. Pick one form per render and keep it stable for golden-file tests.

A line is one runnable command. When a destination needs a **repair prelude** (dig a blocking cell, then walk), emit it as a composite hint with an explicit `→` joining two runnable commands (`dig X Y Z → move X Y Z`); the agent runs them in order. This is the one sanctioned exception to one-command-per-line.

**Header (the situated frame):**

```text
<situation> at X,Y,Z — <mode> (<signals>)   as_of=tN
```

Only the **newest** header is authoritative for planning; older briefs are historical facts, prunable. The header anchors every line, so the imperative body stays a true statement when read later (see *Principles — Output shape — situated propositions*).

**Annotation vocabulary** (Part D honesty data as terse tags, not JSON keys):

| Tag | Meaning |
|-----|---------|
| `seen` / `inferred` | line of sight vs planned through unloaded/x-ray chunks |
| `⚠ <reason>` | `⚠ blocked (sealed)`, `⚠ exposed (night)`, `⚠ 40m detour`, `⚠ fall risk` |
| `(Nm)` / `(N blocks)` | straight-line distance or dig length |
| `✓` / `✗ need N` | resource check on editing verbs (inventory × cost) |
| `← suggested` | the server's single best pick this round |

### Open-mode example

```text
Surface at 305,64,-52 — open (4 exits)   as_of=t106
paths:
- base:        move base_anchor     (14m) ← suggested, passes 6m from chest_food
- base_ridge:  move 290,68,-70      (11m) shorter, farther from food
- chest_food:  move chest_food      (22m) on the way to base
- unexplored_ne: move 340,64,10     frontier, inferred
journey: base → forest_edge 276,64,78 → here
```

Ordering replaces scoring; weights live server-side. The two `base` lines are competing routes the agent picks between (`← suggested`, or the food-adjacent one when hungry) — no `utility=42` to interpret.

Keep those weights in **one ranking policy object** (distance, hazard, food-on-route, mode), not scattered across handlers — so ordering is tunable and testable in isolation (and the A/B in Phase 3 has a single knob to turn). This is open question G; the architectural commitment here is only "one place," not the specific weights.

### Confined-mode example

```text
Underground at 272,38,82 — confined (1 exit, density 0.81)   as_of=t104
paths:
- surface:  pillar_up               ✓ have blocks   ← suggested   (DO: move can't climb)
- base:     move base_anchor        ⚠ blocked — climb first
- iron_ore (5 blocks): dig 272,38,80 → move 272,38,79   seen
- back:     retrace --trail                      (DO: reverse the string)
standing: enclosure_inside; open_dirs [up]; step_up_dirs [north]
journey: pit_lip 272,64,82 → shaft → here
```

Blocked strategic marks are still **listed** (so the agent knows base exists and is currently sealed) but carry `⚠` and never `← suggested`. On a confined→open flip, the next brief leads with a stamped transition line.

> These examples show the **end-state** (Phase 2) behavior. The `← suggested` pick, blocked-line suppression/flagging, and reconcile-before-emit land in Phase 2; Phase 1 may list strategic rows with a `⚠` tag but without active suppression.

### Other context-aware lenses (same data, optional)

Additive lenses on the same line list, each from signals already collected: **resource-gated** edits (`✓/✗`), **backtrack** (the string via `retrace --trail`), **reachability verdict** headline (cousin of `mc scout`'s verdict), **danger-reorder** (night/low-HP sorts safety first), **delta** line (diff vs previous frame), **suggested+alternatives**.

---

## Principles (preserved across the refactor)

### Within-round only, zero persistence (locked)

No route or edge state is written to disk or carried **across cycles**. Each round recomputes from live world state and discards the brief at round end. Mutable terrain cannot stale a stored edge if there is no stored edge — so v1 has no **cross-cycle** invalidation, negative-cache, or pruning machinery. What persists, unchanged: **destinations** (marks; Steward single writer; reconciled via `[HEALTH] reconcile` cards + `scripts/reconcile-marks.py` today, with `mark-drift.py` as the planned scheduled detector — see `docs/features/landfolk-plugin.md`) and **the string** (volatile `nav-trail`). A cross-round edge cache is deferred until Phase 1 latency proves recompute too expensive. *Within* a single round the server may hold a volatile negative leg ("don't re-offer this line after a live failure"); that is round-scoped state, discarded at round end, not cross-cycle persistence (the negative-leg machinery itself lands in Phase 2).

### Advisory, not autopilot

The brief is decision context, not a frozen plan. One hop per execution; the pathfinder re-plans mid-move; the act-time read governs the next physical action (see *Consistency*).

### Output shape — situated propositions

Pushing geometry to primitives changes what accumulates in history: observations become conclusions. Conclusions must survive compaction — read alone, out of order, without the turn that made them. **Heuristic: write every line as if read by itself, later.** A relative imperative ("move closer") ages into a stale directive; a situated proposition ("from 272,38,82, base was blocked; surface was a `pillar_up`") ages into a historical fact that composes into a journey. The brief reconciles actionable with durable by structure: the **header is the situated proposition**, the **body lines are runnable DSL anchored to absolute destinations**. Structured fields are source of truth; prose is a deterministic projection (same rule as `observation-verbs-redesign.md` § Response shapes).

### Decision context vs journey context

| | Decision context (this round's brief) | Journey context (the string) |
|---|---|---|
| Role | ephemeral planning aid | durable orientation |
| In history | disposable — replace each round; prime compaction target | should survive compaction |
| Source | recomputed brief | `nav-trail` crumbs + compact "journey" line |

Doctrine: latest-authoritative (never re-read an old line as a live instruction); journey surfaced **separately** from routes so it persists when briefs are compacted; **anti-deskill fallback** — if the brief is missing (timeout/error), revert to `scene` / `standing`, don't act blind.

**Degraded modes are typed, not silent.** The planner can partly fail (timeout, no reachable candidate, stale snapshot); make that explicit so the agent and tests both branch deterministically rather than the agent guessing from an empty list:

| Mode | When | Agent guidance carried in the payload |
|------|------|----------------------------------------|
| `NO_BRIEF` | planner errored/timed out | fall back to `scene`/`standing` (anti-deskill) |
| `STALE_BRIEF` | `pos_snapshot` no longer matches (moved/dug since compute) | cheap re-read (`standing`/`reachable`) before acting on a line |
| `PARTIAL_BRIEF` | some candidates resolved, others timed out | act on resolved lines; treat missing ones as unknown, not blocked |

These reuse the existing typed-error contract (`{code, message, retry_safe}` in `action-contract.js`) — a new vocabulary of codes, not a new mechanism.

### Consistency — so other perception doesn't contradict

`scene`, `status`, `find`, `standing`, and the brief describe one world. Resolve contradiction in code, not by asking the LLM to referee:

- **One vocabulary** — destinations as `Location`; brief lines use shared `pos`/`dist` nouns **and real `mc` verbs as keys** (`move`, `dig`, `pillar_up`) — the same verbs the agent runs, no perception/action drift.
- **One coordinate convention** — `block_y` vs `surface_y` per `docs/conventions/coordinates.md` on every cell.
- **Provenance** — `source` (`brief`/`scene`/`status`/`find`), `as_of`, `seen|inferred` on every statement.
- **Precedence** — for the next physical action, the act-time honest read wins (`scene`/`standing`, immediate, `seen`); the brief is the strategic heading (may be `inferred`). Tactical vs strategic, not co-equal.
- **Reconcile before emit** — if a brief line's target is a cell `standing`/`scene` reports blocked, suppress or flag it.
- **Lane discipline / displacement** — the brief is the Route lane; `scene`/`nearby` become **exception tools** ("if the brief answered it, don't re-scan"). Pollution reduction is a measured outcome (Phase 3 `mc-call-survey`), not automatic: nothing suppresses `scene`/`nearby`, so the brief must be good enough to *displace* them, and must not duplicate `observe.nearby_marks` (extend/replace that field, don't sit beside it).

---

## Mechanism

### Component seam (where the code lives)

Four responsibilities, kept separate so transport (which verb/payload carries the brief) is decoupled from semantics (how routes are computed and rendered). One planner, many surfaces — `observe` slice now, a dedicated `mc brief` later (open question C) — without duplicating logic.

| Responsibility | What it does | Home (proposed) |
|----------------|--------------|-----------------|
| **State provider** | gathers inputs: marks, crumbs, `standingState`, `nav_mode` | reuse existing readers (`marks.js`, `nav-trail.js`, `_nav-helpers.js`) |
| **Planner** | candidate generation + profile ladder + repair hints + ordering | new `runtime/nav-brief.js` (planner core) |
| **Renderer** | typed `nav_brief` → deterministic text (header + lines) | same module, pure function (golden-file tested) |
| **Freshness** | version stamp + post-mutation invalidation hook | new; stamp in planner, hook in dig/place/`pillar_*` (Phase 2) |

This is the *minimum* seam to keep the brief testable and re-surfaceable — not a framework. Resist adding a generic "perception bus"; the four pieces above are enough for v1.

**Internal nav facade (0b).** "Route through the `move` stack" means one exported function — `navigateToTarget({ target, near?, raw?, force? })` in the movement module — that `move`, `go_site`, `go_mark`, and the brief's line-execution all call. Sequenced (decision D3) as 0b-i (facade + `go_site`) → 0b-ii (`go_mark`) → 0b-iii (CLI `move` resolution), each independently shippable. The facade's external contract for the legacy verbs stays unchanged except the added door/detour safety (acceptance: `mc go_mark`/`mc go_site` keep their codes, timeouts, and visit bookkeeping).

### Key-location set

Capped (~8 strategic + a few local junctions) so precompute stays cheap and the brief stays smaller than the loop it replaces.

| Source | Origin | Notes |
|--------|--------|-------|
| Fleet marks | `locations-base.json`, `locations-<bot>.json` | `base_anchor`, `chest_*`, `lt_*` — authoritative |
| Nearby chests / tables | marks + recent use | within working radius |
| Decision waypoints | `nav-trail.js` string | promoted crumbs (cell before `dig`/`place`/`move`/descent) |

Tiers: **immediate** (current cell, last crumb — escape/repair), **local** (junctions, ~16–32 m — leg goals), **strategic** (`base_anchor`, `chest_food` — reached via the string + `move`, not one long A\* each round).

### Round-start precompute

Read-only `b.pathfinder.getPathTo(movements, goal, timeoutMs)` (the same call `queries/region.js` `is_sheltered` uses for leak probes — proof the read-only pattern works, not an existing mark-precompute helper), up a profile ladder: `walk` (no edits) → `dig` (mine through) → `scaffold` (pillar/bridge) → `none`. For the honest reachable/unreachable annotation, copy the `annotateReachability` use in `queries/find.js` (the `mc find` verb) and `mining/scout.js` (which powers **`find_blocks`**, *not* the `mc scout` hazard verb — `queries/scout.js` does hazards + `mine_here|move_to|…` and does **not** annotate reachability): reachable-first sorting, `approach_cell`, `unreachable_reason`. Do **not** copy `observe`, which has no reachability today. Emit one DSL line per reachable (or repairably-reachable) candidate, ordered by relevance, best tagged `← suggested`. For marks, the verb is `move @mark` and the bot executes the leg internally; never dump a full path-node list. (Today `move.js` uses `getPathTo` + detour checks and `go_mark` uses `pathfindGotoNear`; the `navigateViaHops` helper in `_nav-helpers.js` exists but has **no callers** yet — adopting it for `move`'s internal hopping is a Phase 0b/1 decision, not existing behavior.)

### Path repair (obstruction analysis)

When all profiles return `none` (or in confined mode before a long `move`): flood the reachable frontier (`computeReachability`, converging on a Movements-backed probe — open question F), find choke cells, simulate k=1 edits (k=2 if budget), re-run `getPathTo`, rank by edit count and cost, honor protect regions. In confined mode, repair + `standing`/`escape` are primary; strategic rows hide until mode flips open.

### Navigation mode: confined vs open

Don't plan long transits while `enclosure_inside`, `three_walled`, or local walk exits ≤ 2.

| Signal | Source | Confined indicator |
|--------|--------|-------------------|
| Standing class | `standingState` / `mc standing` | `enclosure_inside`, `three_walled`, `trapped`, tight `alley` |
| Open horizon | `open_dirs`, ceiling | ≤1 open dir + low ceiling |
| Local exits | `getPathTo(walk)` within R_local (8–12 m) | ≤2 successes |
| Local density | solid fraction 5×5×5 | high + few exits → tunnel |
| HP / threat | status / reactive | low HP amplifies confined doctrine |

`nav_mode = confined` when enclosure-like standing **or** (low exits **and** high density). Confined → repair + escape only; open → full destination list + food-on-route bias. Local exit counting must use Movements-backed probes, not hand-rolled BFS (verified: `computeReachability` is standability BFS with no doors/dig/scaffold), so counts match real `move`.

---

## Pathfinder reliability

Precomputed routes are only as honest as the pathfinder and snapshot. Surface which failure class applies; never present A\* output as ground truth.

- **A. Execution vs planning** — success while Y diverges (`fell_by_blocks`, set on `goto`/`goto_near` when fall ≥ 4 — **not** by `move.js`, so the brief can't read it off the `move` path; treat it as a `--raw`/`goto`-only signal); detour explosion (`detour-check.js` — `mc move` already refuses; the brief inherits this, but only on the `move` path, not raw `goto`/`go_site`); stall (`NAV_NO_PROGRESS`, `next_hop_suggestion`); unstandable target; hop exhaustion. Note an existing auto-recovery already couples nav to a trail: `HERMES_NAV_AUTO_RETRACE` (`config/index.js` → `maybeAutoRetraceOnStall` in `_nav-autoretrace.js`) fires one `mc retrace` on a `goto`/`move` `NAV_NO_PROGRESS` when `dy > 0`, the flag is on, **and `ctx.runtime.lastDugSteps` has ≥2 steps** — i.e. the `stair_down` trail, **not** the nav-trail crumb string. Pillar 2's backtrack must not double-trigger with it. *Record path-vs-straight and first-step ΔY; offer the line, not a full itinerary.*
- **B. Enclosure/shelter** — `is_sheltered` false ± (operable doors, head gaps); incomplete walls; `standing` is pathfinder-independent. *In confined/shelter contexts prefer `open_dirs`/`step_up_dirs`/`escape`; tag `shelter_semantics: ingress` vs `travel`.*
- **C. Model fidelity** — BFS ≠ Movements; loaded-chunk x-ray (tag `inferred`); reactive vs pathfinder race; water/`collect` vs hand `move`. *Shared Movements profiles; row `prefer: collect` when a solid ore wall blocks hand `move`.*
- **D. Required on every line** — `profile`, `straight_m`, `path_m`, `detour_ok`, target cell, `seen|inferred`, optional `conflict_warning` (`fall_risk`/`surface_detour`/`underground_up_first`), optional `verify_after`.

### Relationship to existing verbs

The brief is the **cheap, always-on** layer; heavier cousins stay for deep questions: `mc scout` (hazard+target survey, returns `mine_here|move_to|not_enough|unsafe`), `mc advise --target` (slow LLM digest with `route_preview`). `mc retrace --trail` (new CLI flag) is the crumb-backtrack executor; plain `retrace` stays for stair egress. `mc reachable` supplies the standable approach cell — but it is **geometry-only** (foot/head/ground at the target); its own docs warn it does **not** verify a path exists from the bot's position. The brief must not let a `reachable` pass imply reachability; path honesty comes from `getPathTo`/`annotateReachability`, not `reachable`. The brief **replaces/extends `observe.nearby_marks`** (verified single emitter in `observation.js` — low fan-out, but version the `/observe` payload for any external reader). Today `nearby_marks` is **straight-line distance only** (no reachability), so the brief is a genuine upgrade — `annotateReachability`-backed honest routes — not a rename. No new *navigation* verb is required — the refactor makes `move` canonical and consolidates the rest behind it; the one genuinely new surface is `retrace --trail` (or a `backtrack` verb) and the `brief` itself.

Note `mc move`'s water-refusal path already emits a `route_preview` (`water-refusal.js`) — a cousin of the brief/scout verdict. The brief should align with that shape, not duplicate it inconsistently.

---

## Mutable world: destinations vs traversability

Terrain changes — mostly from the bot. Separate **destinations** (nodes) from **traversability** (the string/edges). A blocked path never deletes a chest mark; it breaks an edge claim only.

| Class | Examples | Blocked path invalidates? | Pruned here? |
|-------|----------|---------------------------|--------------|
| Authoritative destination | fleet `chest_*`, `base_*`, `lt_*` | No | Never — worker flags drift |
| Private destination | bot-discovered chest | No | Bot may update |
| Built traversal | stairs, bridges | edge only | promote to `lt_` if key connector |
| Volatile string | trail crumbs | edge only | TTL, cap, collinear merge |

**Destination gone at coords:** fleet → `[HEALTH] reconcile` / Steward; private → bot updates mark.

**When a route breaks mid-round:** keep the destination; suppress that line for the rest of the round (volatile negative leg); promote the current cell (crumb) and recompute; re-classify `nav_mode` (pit → confined); drop volatile string nodes only.

### Within-round staleness (the sharp edge)

The brief is computed at round start, but the agent mutates the world *during* the round — a brief can rot inside the very round it was issued (dig down 6 → `surface: pillar_up` count wrong; dig through → `⚠ blocked` is now a false negative; mine out `back` → that cell is gone). **There is no invalidation hook today** — nothing in the movement/dig layer marks a brief stale after a self-mutation; that hook is **new work** (Phase 2). Three principles:

1. **Self-terminating verbs over baked quantities.** `mc pillar_up` already stops at a sky-open surface (verified in the registry), so emit `surface: pillar_up` (verb self-corrects), not `pillar_up 26` (stale the moment you dig). Favor `move`, `collect`, `retrace` — verbs that re-evaluate at execution. Bake a number only when the agent's own action won't change it. *This is the cheapest mitigation and needs no new code — prefer it.*
2. **False-negative ≫ false-positive.** A stale "reachable" walks the bot into a wall (possible death); a stale "blocked" just triggers a re-check. When freshness is uncertain, round toward blocked/unknown; trust only positive/`seen` claims for action.
3. **Refresh hook after self-mutation (new).** A successful `dig`/`place`/`fill`/`stair_*`/`pillar_*`/`collect` should mark brief lines crossing the mutated cells stale (`brief_refresh_required`), so the agent does a cheap `mc standing`/`mc reachable` (or `brief` refresh) before committing — not a full `scene` dump. Round boundary is the coarse refresh; this is the within-round one.

### Edges as cache (deferred)

If profiling ever requires a cross-round cache, treat edges as cache entries evicted on mutation event, TTL, live contradiction, and dominance — out of scope for v1. v1 persists only destinations.

---

## Code verification (2026-05-30)

Snapshot of existing-vs-greenfield from a read of `registry.mjs`, `dispatch.mjs`, `nav-trail.js`, `retrace.js`, `go_site.js`, `marks.js`, `lifecycle.js`, `manager.js`, `observation.js`, `_nav-helpers.js`, `queries/region.js`, `queries/scout.js`, `find.js`, `config/index.js`, plus the bot test suite. Keeps the plan honest about what the refactor inherits vs. builds.

| Capability | Status | Evidence / note |
|------------|--------|-----------------|
| String **laying** | ✅ exists, runs | `sampleNavTrailCrumb` called ~5s by stuck watchdog (`manager.js`) + on dig (`excavation.js`); teleport clears |
| String **follow** (crumbs) | ✅ shipped | `mc retrace --trail` → `use_trail`; fallback + `source` field |
| `:region:` ref routing | ✅ on `move` | `dispatch.mjs` rewrites region refs to `go_site` for `goto`/`goto_near`/`move` |
| Mark/region nav safety | ✅ with flag | `HERMES_MOVE_RESOLVE=1`: `go_site`/`go_mark` via `navigateToTarget`; legacy path without flag unchanged |
| `move` detour refusal | ✅ exists | `isDetourAllowed` / `detour-check.js`; **only on `move`, not raw `goto`/`--raw`** |
| `move` target grammar (`--near`/`--raw`/`@mark`/bare) | ✅ shipped | `dispatch.mjs` + `move.js` mark resolution; `--raw`/`--near`/`--force` in registry |
| `goto` mark-in-body | ✅ exists | `goto` `bodyFn` passes `mark`; facade records negative legs on marked failures |
| `deathpoint` nav | ⚠ own stack | `lifecycle.js` uses `pathfindGotoNear` (range 3), not `goto`/`move` |
| `retrace --trail` fallback | ✅ shipped | CLI `--trail` → `use_trail`; falls back to `lastDugSteps` when crumbs `< 2`; result reports `source` |
| Second trail writer | ❌ dead stub | `refreshNavTrailFromHistory` — no callers, refs bare `positionHistory` (would throw); fix-before-use if adopted |
| `mc reachable` proves a path? | ❌ no | geometry-only (foot/head/ground); does not verify a path from the bot |
| `pillar_up` self-terminating | ✅ exists | registry: "stops when it reaches a sky-open surface" |
| `go` name free? | ❌ taken | `goto` owns `go`/`g`; `buildAliasMap` throws on duplicates → **`move` canonical** |
| `perceive` category | ✅ shipped | CLI group **`perceive`**; `scene` alias `perceive` removed |
| BFS == Movements? | ❌ no | `computeReachability` is standability BFS, no doors/dig/scaffold |
| `annotateReachability` precedent | ✅ exists | `queries/find.js` (`mc find`) + `mining/scout.js` (powers `find_blocks`, **not** the `mc scout` hazard verb); reachable-first + `approach_cell`; copy for the brief, not observe |
| `nearby_marks` consumers | ✅ replaced when brief on | `HERMES_NAV_BRIEF=1` drops `nearby_marks`; GoalNear radius=2 for mark reachability |
| Per-round brief / `mc brief` | ✅ in `observe` | `nav-brief.js` + flags; dedicated `mc brief` verb still deferred |
| Within-round invalidation hook | ✅ shipped | `markBriefRefreshRequired` + reconcile on observe |
| Reconciliation / negative legs | ✅ shipped | negative legs + k=1 repair; recording via `move` / `navigateToTarget` |
| `HERMES_NAV_AUTO_RETRACE` | ✅ exists | `_nav-autoretrace.js`: auto `retrace` on `goto`/`move` `NAV_NO_PROGRESS` when dy>0 **and `lastDugSteps` ≥2** (stair trail, not crumbs) — don't double-fire with Pillar 2 |
| `route_preview` precedent | ✅ exists | `move` water-refusal emits one — align the brief's shape with it |

## Grounding in existing code

File paths are relative to `bot/lib/actions/` unless they carry an explicit prefix (`runtime/…` = `bot/lib/runtime/…`, `cli/…` = `bot/cli/…`, `data/…` = repo `data/`).

| Need | Symbol | File |
|------|--------|------|
| Path as read | `getPathTo` | `bot/lib/actions/queries/region.js` |
| Reachability flood | `computeReachability` | `bot/lib/actions/_nav-helpers.js` |
| `move` leg execution (today) | `getPathTo` + detour check | `movement/move.js` |
| Hop helper (exists, **unused**) | `navigateViaHops` | `_nav-helpers.js` |
| Honest reachability annotation | `annotateReachability` | `_nav-helpers.js` (used by `queries/find.js` + `find_blocks`, not `mc scout`) |
| Detour refusal (`move`) | `isDetourAllowed` | `movement/detour-check.js` |
| Standing | `standingState`, `mc standing` | `_nav-helpers.js`, `queries/standing.js` |
| Shelter | `is_sheltered`, `neighbor_*` | `queries/region.js` |
| Standable approach cell | `mc reachable` | `queries/region.js` |
| String lay (runs) | `sampleNavTrailCrumb`, watchdog caller | `runtime/nav-trail.js`, `runtime/manager.js` |
| String follow (partial) | `resolveRetraceTrail`, `mc retrace --trail` | `movement/retrace.js`, `cli/registry.mjs` |
| Ref routing (partial) | `:region:` rewrite to `go_site` | `cli/dispatch.mjs`, `movement/go_site.js` |
| Mark nav (facade) | `navigateToTarget`, `go_mark` | `movement/navigate-to-target.js`, `marks.js` |
| Alias map (collision guard) | `buildAliasMap` (throws on dup) | `cli/registry.mjs` |
| Brief injection | `computeNavBrief`, `buildObservePayload` | `runtime/nav-brief.js`, `runtime/observation.js` |
| Heavy cousins | `mc scout`, `mc advise --target` | registry |
| `route_preview` shape precedent | water-refusal emitter | `movement/water-refusal.js` |
| Marks | fleet JSON | `data/locations-base.json` |
| Protection | regions | `data/regions-world.json` |

---

## Caveats

- **Pathfinder can lie** — attach Part D metadata; no raw path-node dumps.
- **Probing cost** — cap marks, R_local, k edits, timeouts; skip if the bot barely moved.
- **Staleness** — across-round staleness is moot (recompute each cycle). Within-round: `brief_refresh_required` after mutations and negative legs after live nav failures; still prefer act-time `scene`/`standing` when the brief disagrees with what you just dug.
- **Fair-play** — `seen` vs `inferred`; repair only in loaded chunks.
- **Token budget** — brief + journey line must beat the `scene`/`map` loop it displaces (measure in Phase 3); must not duplicate `nearby_marks`.
- **Scope guard** — the architectural commitments here are deliberately small: the four-piece seam, the `nav_brief/1` envelope, typed degraded modes, one ranking-policy object, and flag-based rollout. **Explicitly out of scope for v1:** a generic perception/event bus, a persistent edge graph, cross-round caching, and splitting this doc into separate architecture/CLI/rollout specs (revisit only if the implementation outgrows one file). Add machinery when a measured need appears, not ahead of it.

---

## Staging (refactor migration)

All phases: within-round, zero disk persistence. The DSL ships as alias-over so nothing breaks mid-migration.

Sequenced so each phase ships behind existing behavior and is independently testable.

| Phase | Deliverable | Test / measure (◆ = new test/fixture, ○ = extend existing) |
|-------|-------------|----------------|
| **0a — string follow** | add `mc retrace --trail` (CLI flag → `use_trail:true`, already in `resolveRetraceTrail`); report `source` (`nav_trail`/`stair_down`) on the result; promote crumb junctions (`last_dig_site`); collinear merge | ◆ `resolveRetraceTrail({use_trail:true})` returns crumbs ≥2 **and** falls back to `lastDugSteps` when `<2` (today untested — `retrace.test.js` only covers `validateRetraceStepCell`/`ascentTargetsFromSteps`); ◆ assert the result reports which `source` it walked; ◆ dispatch/registry test that `--trail` puts `use_trail` in the POST body; ○ keep `egress-protection.test.js`; cheatsheet regen |
| **0b-i — nav facade + `go_site`** | add `navigateToTarget({target,near?,raw?,force?})`; route `go_site` through it (gains door/detour); `goto`/`g` aliases untouched | ○ `go-site.test.js` — swap the `goto` mock for the facade; ◆ `go_site` inherits detour/door behavior; external `go_site` codes/refs unchanged |
| **0b-ii — `go_mark` on facade** | route `go_mark` through `navigateToTarget`, preserving `pathfindGotoNear` arrival, 15s cap, `last_visited`/`visit_count` | ◆ `go_mark` external contract unchanged except door/detour; ○ `containers-split.test.js` |
| **0b-iii — CLI `move` resolution** | `move` resolves `@mark`/`:region:`/bare-name; `--raw` (= `goto`, keeps water-refusal, drops detour); keep `goto`/`g`; no alias stripped from `goto` | ◆ `dispatch.test.js`: `mc move :base1:/tower` → `go_site` (parity with the existing **goto-only** case); ◆ `mc move @mark`/bare resolves; ◆ `deathpoint` still reaches via `pathfindGotoNear`; alias-map uniqueness (`registry.test.js`); prompts-sync green |
| **0c — mode + journey (frame only)** | `nav_mode` from `standingState`; situated **header** + `journey` line in `observe` payload (typed block + render). No `paths:` list yet — just the situated frame around existing `nearby_marks` | ◆ observe-payload unit tests for `nav_mode`/`journey`/header (none today — `http-app.test.js` stubs `buildObservePayload` empty); confinement flip rate; key-set size |
| **1 — flat brief + ordering** | typed `nav_brief` + text render; the `paths:` list (`label: move/DO args` lines, inline tags, relevance order + `← suggested`); resource-gating; `back: retrace --trail`; **replaces** `nearby_marks` (version payload) | ◆ **forest fixture** (does not exist yet — must be authored); ◆ golden-file render; ◆ observe-payload test asserting `nearby_marks` replaced + schema version bumped; per-round `getPathTo` latency (gates any cache); copy-paste correctness |
| **2 — repair + confined + refresh hook** | k=1 repair; suppress strategic when confined; reconcile blocked lines before emit; **post-mutation `brief_refresh_required` hook** | ◆ pit/hut fixtures; ◆ protect refusal; ◆ "after dig, stale line suppressed"; reconcile with `HERMES_NAV_AUTO_RETRACE` so backtrack doesn't double-fire |
| **3 — perceive rename + A/B** | resolve the `scene` `perceive`-alias collision first; rename `observe` group → `perceive`; evict non-perception verbs; regenerate `docs/mc-cheatsheet.md` (`scripts/regenerate-artifacts.sh`) and migrate `mc observe`-group tokens in prompts/SOULs; doctrine A/B (confined no long `move`; hungry leg choice; `scene`/`nearby` displacement) | large `cheatsheet-sync.test.js` diff; `prompts-sync.test.js` (**note: only gates `*.starter.txt` + `*.wake-*.md`, not the big SOULs — migrate `flint.md`/`steward.md` etc. by hand or widen the gate**); `mc-call-survey`, `analyze-mc-failures` |

**Deferred:** water folding into `move` (keep `sail_to`); `collect` folding; cross-round edge cache (gated on Phase 1 latency).

### Rollout (de-risking each phase)

Reuse the existing `HERMES_*` env-flag pattern (`config/index.js`) — no new infra:

- **Per-phase flags** — e.g. `HERMES_NAV_BRIEF` (Phase 1), `HERMES_MOVE_RESOLVE` (0b), `HERMES_RETRACE_TRAIL` (0a). Default off; flip per environment.
- **Shadow mode for Phase 1** — compute `nav_brief` and **log it without surfacing to the agent**; diff against current `nearby_marks` + the live `move`/`goto` failure classes (`analyze-mc-failures.py`) before any agent reads it. Catches bad routes without risking a live bot.
- **Canary by role** — enable on **one worker profile** (e.g. gatherer-test) for a session before fleet-wide; Steward stays orchestration-only.
- **Agent visibility** — `nav_brief` is attached to **`mc observe` only**, not to `status` / `marks` / `nearby` / `scene`. Workers already start with `mc observe` in `*.starter.txt`. **Steward historically oriented with scattered perceive verbs and zero observe calls** — brief visibility stays at zero until `steward.md` / `steward.starter.txt` lead with `mc observe` each cycle (2026-05-30 genesis note).
- **Latency budget (SLO)** — the round-start precompute must fit the per-turn read; cap total `getPathTo` work (marks × profiles × timeout) and **degrade to `PARTIAL_BRIEF`** rather than blow the budget. The Phase 1 latency measure already gates whether a cross-round cache is ever needed.

This is rollout hygiene, not new architecture — flags + a log diff + one canary profile.

**CI gates touched:** new `retrace` body fields (0a) and a `brief` action (1) must keep `cli-action-sync.test.js` (every CLI POST action has a server handler) and `actions-manifest.test.js` (factory naming) green, on top of the cheatsheet/prompts gates already noted. `docs/mc-commands.md` is a **hand-maintained** summary and already drifts from the registry — do **not** sync it as a source of truth; the registry + generated `docs/mc-cheatsheet.md` are canonical.

**Test reality check (2026-05-30):** nav-brief, retrace `--trail`, observe payload, and negative-leg tests exist under `bot/test/runtime/` and `bot/test/actions/`. Steward prompt alignment for `mc observe` is separate from code gates — track via genesis postmortems / `mc-call-survey.py` observe call counts.

---

## v1 defaults (resolved from review)

Settled here so implementation isn't blocked on style/scope/phasing. Each is a default, overridable if a measurement says otherwise.

- **Compute budget (starting caps).** ≤8 strategic marks + a few local junctions; ≤2 profiles per mark on the first pass (`walk`, then `dig`); `getPathTo` timeout ~1.0–1.5s each; **hard ceiling on total brief compute, then degrade to `PARTIAL_BRIEF`** rather than overrun. The ceiling is calibrated from the Phase 1 shadow `compute_ms` distribution (decision D4) — set at a p95 under the per-turn read budget; the shape (cap × profiles × timeout → partial) is fixed.
- **Honesty per row type.** Strategic marks use `getPathTo` on the **`move` Movements profile** (doors/detour-true), not BFS — BFS (`computeReachability`/`annotateReachability`) is only for the *local* exit count and cheap reachable-first ordering. A strategic row never claims reachable on BFS alone (avoids repeating the known BFS≠Movements lie).
- **Ranking (v1).** Distance + `nav_mode` filter only; **food-on-route / hazard weighting deferred to the Phase 3 A/B** (open question G). One ranking-policy object regardless.
- **Composite repair hints.** Only on the `← suggested` row in v1 (open question J); other blocked rows just carry `⚠`.
- **Journey line.** In the `observe` payload only for v1 (no `mc journey` verb yet — open question P).
- **Backtrack surface.** Ship as **`mc retrace --trail`** flag (not a new `backtrack` verb) in v1 (open question T); a dedicated verb is a later option.
- **`retrace --trail` honesty.** When `--trail` is requested but the crumb trail is `<2` and it falls back to `lastDugSteps`, the action **reports which trail it used** (`source: nav_trail|stair_down`) so the agent/brief never assumes crumb-walk happened. If neither trail exists, fail loud (`RETRACE_NO_TRAIL`), unchanged.
- **Observe payload versioning.** When `nav_brief` replaces `nearby_marks`, bump a **root `payload_version` on `/observe`** (not only `schema_version` inside `nav_brief`), so external readers (dashboard, stubs) gate on one field.
- **Degraded-mode transport.** On a successful `200`, carry `nav_brief: null` + `nav_brief_status: NO_BRIEF|STALE_BRIEF|PARTIAL_BRIEF` (not an HTTP error) — the typed codes reuse `action-contract.js` vocabulary.
- **Shadow-mode log.** `HERMES_NAV_BRIEF=shadow` computes the brief and writes one structured log line per compute (`brief_id`, mark count, reachable/total, compute_ms, diff-vs-`nearby_marks`) to the existing action/auto-action log channel — no agent exposure, no new file store.
- **Planner home.** `runtime/nav-brief.js` (planner + pure renderer), alongside `nav-trail.js`/`observation.js`, out of the `actions/` dispatch path. Proposed, not load-bearing.
- **Forest fixture.** A deterministic **mock-bot unit fixture** (like `nav-helpers.test.js`'s `makeStandingMockBot`) is the gate for Phase 1; a live Multiverse world (`docs/guides/test-world.md`) is optional manual verification, not the CI gate.

## Decisions (resolved 2026-05-30)

These were the behavior/architecture calls beyond style/phasing. All now decided; the staging sequence below reflects them.

| # | Decision | Gates | Resolution |
|---|----------|-------|------------|
| **D1** | **Injection path** (open question C): extend `observe` vs dedicated `mc brief`. | 0c, 1 | **Extend `observe`** (lean slice) for v1. The cycle hook fires on the existing per-turn `observe`/`status` read. A dedicated `mc brief` is revisited only if observe bloat is measured (open question C stays as the *later* trigger, not a v1 fork). |
| **D2** | **Agent-facing surface**: rendered text in `mc observe` stdout vs JSON-only for the Hermes layer. | 0c, 1 | **Rendered text in `mc observe` output** (matches status prose); the typed struct stays in the payload for tooling/tests. Renderer is a pure function in `runtime/nav-brief.js`, projected through the CLI envelope. |
| **D3** | **0b unification scope**: refactor `move`+`go_site`+`go_mark` together vs facade-first then migrate. | 0b | **Sequenced within 0b, independently shippable:** (i) land the `navigateToTarget` facade + route `go_site` through it; (ii) route `go_mark` through it; (iii) add CLI `move` target resolution (`@mark`/`:region:`/bare). Each ships behind its own behavior with its own tests. |
| **D4** | **Brief compute SLO (the number)**: hard ms ceiling on a lean `observe` read. | 1 | **Set empirically from shadow mode**: collect `compute_ms` in Phase 1 shadow, set the ceiling at a p95 comfortably under the per-turn read budget, then enable agent exposure. The mechanism (caps → `PARTIAL_BRIEF`) is fixed; the number is calibrated, not guessed. |
| **D5** | **`move --raw` safety semantics**: does `--raw` bypass water-refusal + detour, or keep water-refusal? | 0b | **Verified + locked:** today **both `goto` and `move` run `preflightNav`** (`movement/index.js` → `refuseWaterRouteWithoutBoat`; `goto.js:64`, `move.js:132`). So `--raw` (= `goto` semantics) **keeps water-refusal** and drops only the **detour guard** — no behavior regression vs today's `goto`. |

## Open questions

| ID | Question |
|----|----------|
| **A** | Key-location cap and decay vs string TTL? |
| **B** | Which crumbs become labeled junctions? |
| **C** | Injection: extend `observe` vs dedicated `mc brief`? — **decided (D1): extend `observe` for v1**; `mc brief` is a later trigger if observe bloats |
| **D** | Repair k=1 only vs k=2? |
| **E** | Fair-play for inferred routes? |
| **F** | Consolidate BFS onto `getPathTo`? — partly resolved: strategic rows use `getPathTo`, BFS only for local exits (*v1 defaults*) |
| **G** | Server-side ordering weights (distance, hazard, food-on-route)? — v1 = distance + mode only; hazard/food in Phase 3 A/B (*v1 defaults*) |
| **G2** | Which of the *Other context-aware lenses* ship in v1 (resource-gating, backtrack, verdict, danger, delta) vs opt-in flags? |
| **H** | R_local for exit counting (8 vs 16 vs 32 m)? |
| **I** | `nav_mode` in SOUL vs payload-only? |
| **J** | Composite repair hints per brief — **resolved v1**: only the `← suggested` row (*v1 defaults*) |
| **K** | Within-round negative leg — suppress until recompute, or until position changes? |
| **L** | Stair/bridge promotion to `lt_` — auto vs Steward? |
| **N** | Provenance on all perception verbs in v1, or brief-only? |
| **O** | Reconciliation depth — flag vs suppress vs re-route? |
| **P** | Journey line — crumb count, transitions, in `observe` vs `mc journey`? — **resolved v1**: `observe`-only, no `mc journey` (*v1 defaults*) |
| **R** | Does `collect` fold into `move`, or stay separate (it embeds its own pathfinder)? |
| **S** | Does `flee` become `move --flee`, or stay in combat (retreat semantics)? |
| **T** | Crumb-backtrack surface — **resolved v1**: `retrace --trail` flag (not a `backtrack` verb) (*v1 defaults*) |
| **U** | When do `goto`/`g` aliases get retired (or do they stay permanently as `--raw` shorthands)? |

---

## Related work

- `docs/features/observation-verbs-redesign.md` (perception lanes + response shapes — the LOOK half), `docs/features/agent-scripting-layer.md`, `docs/features/designated-regions.md`, `docs/features/landfolk-plugin.md` (fleet-mark authority + planned `mark-drift.py` detector), `docs/guides/perception-digest.md` (`mc advise` / `perception_answer_v1`)
- `docs/conventions/coordinates.md` (`block_y` vs `surface_y` convention used on every brief cell)
- `bot/lib/actions/_nav-helpers.js`, `bot/lib/actions/movement/move.js`, `bot/lib/actions/movement/water-refusal.js` (`route_preview` precedent), `bot/lib/runtime/nav-trail.js`, `bot/lib/runtime/observation.js`
- `bot/test/actions/move-detour-check.test.js`, `bot/test/actions/queries-escape-characterization.test.js`
- `scripts/analyze-mc-failures.py`, `scripts/mc-call-survey.py`
- `reports/expedition/2026-05-24-flint-iron-mining-deep-shaft.md`, genesis shelter/neighbor postmortems

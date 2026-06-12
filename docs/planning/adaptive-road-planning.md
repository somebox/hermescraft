# Adaptive Road Planning — survey powertools + field judgment verbs

Status: IN PROGRESS (design agreed 2026-06-10, revised same day after code
review; this doc is the implementation contract). Phases 0–1 kernels (K1–K3),
the S2 RCON adapter, and natural torch placement are built and in-world
validated as of 2026-06-12 — field learnings and doctrine deltas in §11.
The planner-agent loop (`roadplan sample`/`confirm` + `skills/road-planner.md`)
is built and driven end-to-end on a live world 2026-06-12 — §12. Phases 2+
stand as planned.
Owner: agent-arch / proc-nav lab
Prior art: proc-nav trials 1781014144 and 1781079999, postmortems in
`data/postmortems/proc-nav-lab/`, fixed-graph generator
`prototypes/agent-arch/capstone/proc_scout_road_graph.py`.
Cross-links (add as part of Phase 0): proc-nav runbook
(`reports/agent-arch/proc-nav-scout-runbook.md`), `docs/architecture/README.md`
index, `docs/architecture/workspaces.md` interim notes — so the adaptive
strategy and the fixed-graph control arm are explicitly two arms of one
program, not two diverging road strategies.

---

## 1. Problem

The road-tier trials proved the *execution* layer works (clear_strip, level_ground
dispositions, bridge-fill, collocated per-bot card chains) but exposed two
structural weaknesses:

1. **The plan is frozen at graph-build time.** The orchestrator bakes ~21 cards
   with literal coordinates before any bot has seen the terrain. The planner
   agent's output is decorative. Surprises (deep dips, caves, dense canopy)
   dead-end in `gave_up` cascades because nothing upstream can replan.
2. **Agents reason block-by-block.** Reasoning logs show workers issuing dozens
   of probes and doing height arithmetic in-context, returning redundant data
   and making confident mistakes. The tooling returns *data*; agents need
   *judgments*.

Reframe (agreed with user): the task is not "build a road." It is the question
**"how much needs to be done to make this path clear and walkable?"** — asked
recursively, between pairs of points, with the answer sometimes being
*nothing*. A road's value is travel-time reduction; a 12-block bridge across a
ravine that removes a 200-block detour is worth more than 100 blocks of
cosmetic surface work.

## 2. Design principles

- **Walkability is the spec; travel time is the objective.** Optimize
  Δtravel-time per edit, not edits or straightness.
- **Samples are the currency.** Observing is cheap relative to construction,
  but not free — spend coarse samples broadly, fine samples only where the
  candidate route runs. *"Additional observations are cheaper than solving
  unforeseen construction issues."*
- **Judgments, not data.** Tools return run-length terrain narratives,
  verdicts against spec, and literal fix commands. Agents ratify; code
  computes. No per-block payloads.
- **The plan is physically visible.** Every confirmed waypoint carries a
  torch. When the route moves, the torch moves. A human (or bot) can watch
  planning unfold in-world and navigate by the torch chain at night.
  **Torches stand on existing natural ground only** — placement never
  fabricates a base block or pillar. A waypoint that cannot be lit naturally
  is a route-quality alarm (wrong Y, or a span that needs construction
  first), not a placement problem to patch (§11.1).
- **Agents confirm ground truth in-game.** RCON is a development/test data
  source only (Phases 0–1). Load-bearing route assumptions are confirmed by a
  bot standing on (or scanning) the point before work cards exist.
- **Recursive bisection.** `make_walkable(A, B)`: if already walkable → torches
  and done; if one small job → one card; else stake a midpoint (nudged to good
  terrain) and recurse. Easy terrain stays coarse; hard terrain self-refines.
  A curve is just where bisection chose to put marks.
- **Literal verbs bite** (trial 1780989125): card bodies carry exact `mc`
  commands — but now those commands are *generated* by the toolchain minutes
  before pickup, not hand-baked hours before.

## 3. Architecture

Three layers plus one shared state store:

| Layer | Does | Never does |
|---|---|---|
| **Bots** (in-game, `mc` verbs) | sample rows, walk lines, stand on points, place torches, execute work orders | decide anything |
| **`roadplan` script** (planner powertool, Python) | interpolation, A*, refinement targeting, stairs/bridge/tunnel classification, work-order + card generation, rendering | touch the world |
| **Planner agent** | runs the loop, ratifies routes, handles surprises (re-ingest → re-solve), authors cards via `kanban_create` | block-level arithmetic |

Shared state: the **survey ledger** (§5). Field verbs stay READ-pure — their
JSON output is *piped* into the ledger (`mc … --json | roadplan ingest`,
§5.1); `roadplan` reads it and writes solved state; observations append
forever so no measurement is paid for twice.

### Dataflow (steady state)

```
                 ┌──────────────── replan on surprise ────────────────┐
                 ▼                                                     │
  roadplan sample ──→ mc corridor_sample / survey_line ──→ roadplan ingest
                 │                                                     │
                 ▼                                                     │
  roadplan solve ──→ route + confidence ──→ roadplan sample --refine (loop ×2-3)
                 │
                 ▼
  roadplan confirm ──→ mc move + mc waypoint (torch) + mc survey_line per point
                 │
                 ▼
  roadplan workorders ──→ roadplan cards ──→ kanban_create (rolling wave, 2 legs/bot)
                 │
                 ▼
  workers execute ──→ mc survey_line --diff (verify) ──→ mc feedback on surprise
```

## 4. Walkability spec (single source of truth)

One JSON file, `data/walkability-spec.json`, loaded by **both** the JS verbs
and the Python script — the thresholds already exist in JS and must not fork:

```json
{
  "version": 1,
  "max_step_up": 1,
  "max_unguarded_drop": 2,
  "clearance_height": 3,
  "path_width": 3,
  "shoulder_width": 1,
  "fill_shallow_max_depth": 3,
  "max_bridge": 8,
  "forbidden_floor": ["water", "lava", "magma_block", "cactus"],
  "torch_spacing_max": 12
}
```

`path_width: 3` and `clearance_height: 3` deliberately match the shipped
road doctrine in `skills/minecraft-roadbuilding.md` (3-wide roads, ≥3 vertical
clearance) — the solver's "to-spec" and the workers' skill doctrine must be
the same numbers or Phase 5 metrics measure two different roads.

**Spec alignment table** (kept current as part of Phase 0; any change to one
column is a change to all three):

| Spec key | JS source today | Skill doctrine |
|---|---|---|
| `fill_shallow_max_depth: 3` | `FILL_SHALLOW_MAX_DEPTH` — `bot/lib/actions/building/terrain.js:629` | roadbuilding fill guidance |
| `max_bridge: 8` | `MAX_BRIDGE` — `terrain.js:387` | bridge-fill doctrine |
| `path_width: 3` | `clear_strip` road_mode width conventions | "3-wide roads" |
| `clearance_height: 3` | implicit in clear_strip/dispositions | "≥3 blocks vertical clearance" |
| `max_step_up: 1` | implicit in dispositions step classification | walkability framing |

Phase 0 migrates the JS constants to reads of this file and updates
`skills/minecraft-roadbuilding.md` to cite spec values instead of restating
them (skill deltas are an explicit Phase 0/4 deliverable, not an
afterthought).

A **leg is to-spec** when every path cell has solid non-forbidden floor,
`clearance_height` air above, steps ≤ `max_step_up` between consecutive cells,
no drop > `max_unguarded_drop` within `shoulder_width`, and torches ≤
`torch_spacing_max` apart along it.

## 5. Survey ledger

Per-project directory `data/runtime/survey/<project>/`, split to solve
concurrency by construction:

- **`samples.jsonl`** — append-only, any writer (workers, planner, RCON
  adapter). One line per sample batch:
  `{"ts", "src": "rcon|corridor_sample|survey_line|spot", "bot", "cells": [[x, z, y, "block_tag"], ...]}`
- **`observations.jsonl`** — append-only; worker surprises and field notes:
  `{"ts", "bot", "leg", "note", "cells": [...]}` (mirrors `mc feedback` but
  spatial and machine-readable).
- **`state.json`** — written **only by the planner** (via `roadplan`):
  ```json
  {
    "project": "road-overlook-return",
    "spec_version": 1,
    "endpoints": {"start": [x,y,z], "end": [x,y,z]},
    "waypoints": [
      {"name": "wp_3", "pos": [x,y,z], "status": "proposed|confirmed|moved",
       "torch_at": [x,y,z], "prev_pos": null}
    ],
    "legs": [
      {"from": "wp_2", "to": "wp_3",
       "status": "unsurveyed|surveyed|workorders|in_progress|to_spec",
       "deficits": [...], "est_minutes": 8, "card_slug": null}
    ],
    "routes": [
      {"solved_at": "...", "waypoints": [...], "est_travel_s": 96,
       "natural_path_s": 235, "confidence": 0.61, "samples_used": 412}
    ]
  }
  ```

Append-only JSONL for multi-writer files (O_APPEND, same pattern as
`data/runtime/feedback-<bot>.jsonl`); single-writer JSON for solved state.
No locks needed.

### 5.1 Mark + ingest contract (resolves the two riskiest wires)

**Waypoint marks — who writes shared state.** The shipped mark model is
strict: bots write only their private location files; `locations-base.json`
(shared) wins on read for fleet-prefix names (`mergeMarks`,
`bot/lib/runtime/locations.js:34-45`; invariants documented in
`bot/test/runtime/locations-shared-merge.test.js`). A bot privately moving a
fleet-prefix mark is therefore **invisible to other bots** the moment a stale
shared entry exists. Decision:

- `wp_*` IS added to `FLEET_MARK_PREFIXES` (`locations.js:22`) so all bots
  resolve waypoints, but **only `roadplan` writes them to
  `locations-base.json`** — it is host-side and planner-owned, which matches
  the existing "reconciler is the only shared writer" comment
  (`locations.js:31`).
- `mc waypoint` (the verb) sets the bot's *private* mark and places the
  torch. Promotion to shared happens when the planner runs
  `roadplan confirm` ingest — roadplan updates `state.json` AND
  `locations-base.json` in the same step. Moves likewise: roadplan rewrites
  the shared entry; the verb only handles the physical torch.
- `state.json` is the authority; `locations-base.json` is a projection of
  its confirmed waypoints. No timestamp-precedence merge changes needed.
- Phase 2 includes a two-bot spike: planner confirms `wp_3`, second bot
  resolves it via `verify at_mark` / `move @wp_3`, planner moves it, second
  bot sees the new position — all with the existing fleet-mark tests green.

**Ingest wire — how samples reach the ledger.** Field verbs stay READ-pure
(no side-effect writes from READ-class actions, per embodied-control).
The canonical wire is a pipe on the agent's shell:

```
mc survey_line <x1> <z1> <x2> <z2> --json | roadplan ingest
mc corridor_sample ...            --json | roadplan ingest
```

Card bodies include the full pipeline literally, so workers ingest as a
side effect of surveying/verifying. `--diff` *reads* the ledger (read-only —
the bot server runs on the same host and already reads `data/runtime`
files); it never writes it. If a future deployment splits hosts, the
`mc feedback` collector pattern becomes the transport (§10.12).

## 6. The `roadplan` powertool

`scripts/roadplan.py`, invoked as `roadplan <subcommand>` (thin bin wrapper,
same pattern as `mc`). Stateless between invocations except via the ledger.

### 6.1 `roadplan sample A B [--spacing 16] [--margin 24] [--refine]`

Emits (prints) the literal `mc` commands that acquire the needed samples —
it does not run them. Coarse pass: bounding box A→B inflated by `--margin`
on each side (detour room), sampled via `corridor_sample`'s existing `step`
parameter. A 120×60 box at step 8 is ~120 samples — often **one command**
(cap is 512/call, `bot/lib/actions/queries/region.js:141`).

`--refine` mode reads `state.json`'s current route and emits fine-grained
(step 2–4) sample commands **only** for route cells with low confidence or
high local variance. This is the "sub-divide the measurements until the path
emerges" loop, made mechanical.

Canopy/tree density signal: emit *paired* commands — `exclude_foliage=true`
(ground) and `exclude_foliage=false` (canopy top) for forested rows; the
per-cell Y difference is canopy depth, which feeds tree-cost in the solver.

### 6.2 `roadplan ingest [--rcon]`

Reads `mc` JSON envelopes from stdin (or files) and appends normalized cells
to `samples.jsonl`. `--rcon` mode (Phases 0–1 only) probes the same grid
directly via `mapcatalog.rcon_client.make_rcon` so the solver can be developed
without bots in the loop. **The ledger format is identical either way** — the
solver never knows where samples came from; swapping RCON → field verbs later
is a data-source change, not a code change.

### 6.3 `roadplan solve`

1. Build a 1-block-resolution height grid by interpolating `samples.jsonl`
   (bilinear). Track per-cell **confidence** = decay by distance to nearest
   real sample.
2. Cost grid: flat=1, step (|Δy|=1)=2, canopy/tree=3, shallow water=15,
   forbidden floor=∞, |Δy|≥2 between neighbors=∞ **unless** a construction
   edge applies:
   - **stairs edge**: sustained slope >1/block → cost = base + edits×w_edit
   - **bridge edge**: gap/water span ≤ `max_bridge` → cost = span×w_edit
   - **tunnel edge**: through-ridge bore where over-the-top ≫ through
     (v1: computed and *reported*, never auto-selected — see §10)
   - interpolated-cell penalty × (1 − confidence) — uncertainty is expensive,
     which is what drives refinement demand
3. A* (8-connected) start→end. Simplify the path to waypoints via
   Ramer-Douglas-Peucker (tolerance ~2 blocks).
4. Write route + confidence + `est_travel_s` (path length × per-cell move
   costs calibrated in Phase 3) + `natural_path_s` (A* with construction
   edges disabled — the "do nothing" baseline) to `state.json`.
5. Print the verdict and what to do next:
   ```
   route: 14 waypoints, est_travel 96s (natural path: 235s)
   confidence: 61% — route crosses 3 unsampled ridges
   next: roadplan sample --refine   (5 commands, ~310 samples)
   ```

Convergence: iterate solve → refine → ingest until route waypoints move < 2
blocks between rounds (typically 2–3 rounds).

**Algorithm ownership — A\* vs bisection.** The doc describes two planning
motions; they have a strict hierarchy:

- The **canonical route is always the `solve` output** (global A* + RDP).
  Waypoint names (`wp_<n>`) are allocated *only* by `roadplan` — single
  namer, no duplicates, `state.json` is the registry.
- **Bisection is a repair move, not a parallel planner.** It happens in
  exactly two cases: (a) `workorders` returns `split_hint` for a leg too
  complex for one card, or (b) `confirm` ground-truthing contradicts the
  interpolation badly enough that the leg must be re-solved. In both cases
  the agent feeds the new point/samples back through `roadplan` (which
  allocates the waypoint and re-solves the affected legs) — agents never
  stake waypoints the solver doesn't know about. The §2 `make_walkable`
  recursion is the *mental model*; `solve`/`split_hint` is its
  implementation.

### 6.4 `roadplan confirm`

Lists field-check commands for assumption-critical points — every waypoint,
plus the worst-confidence cells the route depends on (bridge abutments,
saddles). Per point (`mc move` is the canonical taxi-nav verb per
`docs/architecture/embodied-control.md` — new skills must not re-entrench
raw `goto`):

```
mc move <x> <z>
mc waypoint wp_3 <x> <y> <z>                                # private mark + torch (§7.1)
mc survey_line <prev-wp..> <this-wp..> --json | roadplan ingest   # ground-truth the leg
```

On ingest, roadplan marks the waypoint confirmed and **promotes it to
`locations-base.json`** (§5.1) — that is the moment it becomes fleet-visible.

If ground truth disagrees with interpolation, the agent re-ingests and
re-solves — **before any work card exists**. When `solve` moves a waypoint,
`confirm` emits the torch *move* (old position recorded in
`state.json.waypoints[].prev_pos`), so the in-world torch chain always shows
the current plan.

### 6.5 `roadplan workorders [--leg wp_2:wp_3]`

Classifies each surveyed leg from its profile runs and compiles literal fixes.

**Classifier single source.** The shipped dispositions classifier lives in
`level_ground` dry-run (`terrain.js` — level / cut / fill_shallow /
fill_deep / no_floor, dip_spans with deck/level_caps suggestions). We must
not grow a second, divergent classifier in Python. The contract:

- Once a leg is surveyed in-world, `workorders` **consumes `level_ground`
  dry-run output** (the card/agent runs the dry-run; output pipes through
  `roadplan ingest` like any sample) rather than re-deriving dispositions
  from the heightmap.
- Offline estimates (Phase 1, RCON-era) are tagged `provisional: true` and
  are never card-eligible until a dry-run confirms them.
- Phase 0/4 carry golden parity tests: Python classification of fixture
  terrain vs recorded `level_ground` dry-run envelopes for the same cells.

**Literal-verbs tension, resolved:** "literal verbs bite" means card bodies
carry exact commands — it does *not* require hand-compiled block-by-block
`place` sequences. Work orders are literal invocations of the shipped verbs
(parity by construction):

| Profile run | Order | Emitted commands |
|---|---|---|
| slope ≤ 1/block sustained | walk | (clear pass only) |
| slope > 1 over a run | stairs | per-rise `mc level <1-col rect> y=<step>` sequence — each rise its own literal call through the shipped verb |
| gap / water ≤ max_bridge | bridge | `mc level ... y=<deck>` (bridge-fill descends ≤ MAX_BRIDGE) or `deck` |
| ridge with through ≪ over | tunnel | flag-and-report (v1; see §10) |
| trees/canopy on line | clear | `mc fell_tree x y z` per trunk, `clear_strip ... road_mode=true` for brush |
| dips ≤ fill_shallow_max_depth | grade | `mc level ... y=<target>` |
| every leg, last | light | torch placements every ≤ `torch_spacing_max` |

Orders are sized to worker budget (≤16 columns per level call — the existing
cap — and ≤~30 min per card). Output per leg:

```
leg wp_2→wp_3: NEEDS_WORK (walkable 78%)
work_orders:
  - mc fell_tree 6 60 30
  - mc level 2 62 38 4 62 41 y=63
  - stairs: 5 rises z=44..48 → mc place ... (exact sequence)
est: ~8 min, materials: 12 cobble
split_hint: none — single card
```

When a leg is too complex for one card, the tool returns
`split_hint: bisect at (x,y,z) — deficit clusters on both sides`; the agent
ratifies the new waypoint and the recursion continues.

### 6.6 `roadplan cards [--wave 2]`

Turns to-spec-pending legs into ready-to-run card invocations, following
fleet kanban canon: the planner agent uses its `kanban_create` tool /
`scripts/kanban add`; the capstone harness keeps targeting the same
`hermes kanban create` vector `author.py` already uses — one card schema,
two entry points. Per card: title, assignee/bot (collocated — the bot that
surveys a leg clears it, per the b24d4f7 lesson), body with the literal work
orders + verify pipeline (`mc survey_line A.. B.. --diff --json | roadplan
ingest`), `--max-retries 3`, depends_on within the leg chain only. Emits at
most `--wave` legs per bot — rolling-wave planning: cards are written minutes
before pickup with fresh coordinates, so prescriptive bodies stop being a
rigidity problem.

### 6.7 `roadplan render`

ASCII overview (sampled heightfield, route, waypoints, leg statuses) for
agent context + an HTML map (reuse the postmortem `spatial-map.html`
machinery) for human inspection. Also the early-problem-detection tool for
Phases 0–1: we can *see* a bad solve before any bot moves.

## 7. Field judgment verbs (`mc`)

New handlers in `bot/lib/actions/`, registered in `bot/cli/registry.mjs`.
All READ-class except torch placement in `waypoint`.

### 7.1 `mc waypoint <name> <x> <y> <z>`

Mark + torch, with move semantics:
1. Set/update the bot's **private** mark `<name>` (existing `locations.js`
   mark persistence). Fleet-wide visibility is NOT this verb's job — `roadplan`
   promotes confirmed waypoints to `locations-base.json` per the §5.1 mark
   contract (bots never write shared state; shared wins on read for
   fleet-prefix names, `locations.js:34-45`).
2. Place a torch on the surface block at the point (bot must be adjacent —
   mineflayer constraint; doctrine pairs it with `mc move`). The torch must
   sit on existing natural ground: anchor-or-report per the S3 decision
   table — snap laterally ≤1 cell to natural grade if the exact cell can't
   hold a torch, else return `needs_construction`. **Never place a support
   block under a torch** (§11.1; `roadplan/torch_chain.py` is the RCON-wire
   reference implementation of the same contract).
3. If the mark previously existed elsewhere: dig the old torch if within
   reach/loaded; otherwise return
   `next_action_hint: "old torch at (x,y,z) — remove when nearby"` and record
   it in the result so the planner can queue cleanup.

Naming: `wp_<n>` by convention; `wp_*` joins `FLEET_MARK_PREFIXES`
(`locations.js:22`) so all bots resolve waypoints — with `roadplan` as the
sole shared writer (§5.1). Distinct from the fixed graph's `road_bound_*`
marks, which keep their existing (non-fleet, per-trial) lifecycle.

### 7.2 `mc survey_line <x1> <z1> <x2> <z2> [--diff] [width=3]`

(Named `survey_line`, not `path_profile`: `mc path` is an existing build verb
— `registry.mjs:993` — and "trail" already carries four meanings in the nav
vocabulary. This doc says "torch chain" for the waypoint lighting and never
"trail".)

The field workhorse. Bresenham the line, scan each cell's column (reusing the
`terrain_top` column logic — foliage-excluded ground + foliage delta for
canopy), classify against the walkability spec, **run-length encode**:

```
A→B 47 blocks, heading SE
profile: ▁▁▁▂▂▃▃TT▃▅▅▅~~~▅▅▇▇▆▅▅▃▃▁▁
runs:
  walk    14        (y 63→64, clear)
  climb   +4 over 5 (max step 2 — STAIRS needed, z 22..26)
  trees   3         (fell_tree 6 64 30; 9 64 31; 8 65 33)
  water   gap 4     (BRIDGE needed, z 35..38, depth 3)
  walk    21        (clear)
verdict: NOT walkable — 3 deficits
fixes: stairs×5 @ z22, fell×3, bridge×4 @ z35
est: ~11 min, 4 cobble + bridge material
```

JSON envelope carries the runs array + per-deficit fix commands — directly
ingestible by `roadplan`. Output size is O(terrain features), never O(blocks).

`--diff`: compare against the leg's last survey in the ledger (or pure spec
if none) and return **only deviations**:

```
3 changes since survey 14:32:
  z 35..38: water now bridged (4 planks) ✓
  z 22: step still 2 (stairs incomplete — 2 of 5 placed)
  z 30: NEW obstruction, gravel fall, 2 blocks → mc dig 6 64 30
verdict: NOT yet to spec — 2 items
```

A clean verify is one line. This is also the surprise-reporting channel: a
worker who hits the unexpected runs `--diff`, gets a one-screen delta, and
files exactly that via `mc feedback` / `observations.jsonl`.

Constraints:
- **Chunk loading**: scans need loaded chunks (cf. the corridor_sample
  "chunks unloaded?" guard, `region.js:171`). Cap line length at ~96 blocks;
  on unloaded cells return `unknown N (move closer: mc move <mid>)` runs
  rather than guessing. Walking the line *is* the design — but note the cost:
  partial profiles force `move` hops, and **wall time from hopping may
  dominate the sampling budget** on long legs. Phase 3 measures this; if
  hop time dominates, prefer more, shorter legs over wider scans.
- Width default = `path_width` (3), with drop hazards checked one block
  beyond each edge (`shoulder_width`).
- Runs under the 25s ACTION deadline easily (it is a read sweep, same family
  as corridor_sample).

### 7.3 Existing verbs already in place (no work)

`mc reachable` (real pathfinder + path length — answers "traversable now? how
long?"), `mc move` (canonical taxi nav) with movement failure reason strings,
`mc feedback`, `mc verify at_mark from=`, `corridor_sample` (the bulk sampler
`roadplan sample` targets), bridge-fill in `level` execute.

## 8. Phased roadmap

Each phase has an exit gate; later phases never start on a red gate.
Sequencing follows the user's directive: **script domain first (RCON fine
for testing), then field survey verbs, then real-world planning and full
execution.**

### 8.0 Workstream decomposition — kernels (senior) vs shells (junior)

The known-hard problems (§8.0.2) are isolated into **kernels**: pure
functions behind frozen I/O contracts, testable entirely from fixtures, with
no bot/world/CLI dependencies. Everything else is a **shell**: plumbing
around a kernel whose test suite already defines correctness. Seniors build
kernels and write shell *contracts* (including the enumerated failure-case
test list — the test list IS the spec); juniors build shells against those
contracts. Kernels and shells in different tracks proceed independently.

#### 8.0.1 Track F — fixture corpus + frozen contracts (senior, FIRST)

The keystone that makes every other track independent. One terrain fixture
format, consumed by **three** test suites (Python solver tests, JS classifier
tests, parity goldens):

- `data/fixtures/terrain/*.json` — generated by small Python builders
  (`flat()`, `ridge()`, `river()`, `ravine()`, `forest()`, `cliff()`,
  `dither()`, `overhang()`, `slab_stairs()`), **committed as JSON** so the JS
  suite reads them without running Python. Schema: per-column block stacks
  (not just a heightmap — overhangs/caves/partial blocks must be
  representable) + annotations (`expected_route_class`, `expected_runs`,
  `expected_dispositions`).
- Envelope/IO schemas, frozen before any implementation: `survey_line` runs
  JSON, `roadplan ingest` input lines, `state.json`, the solver's `Route`
  object. Schema validators usable from both languages.
- Golden-capture harness: a node script that runs `level_ground` dry-run
  against fixture terrain (via the existing action-harness mocks) and writes
  `*.golden.json` for the Python parity tests.
- Done when: fixtures + schemas committed; a trivial test in each suite
  loads them.

#### 8.0.2 Kernel tracks (senior — hard reasoning lives here, nowhere else)

| Kernel | Isolates | Contract (pure function) | Test strategy |
|---|---|---|---|
| **K1 walk-classify** (JS, `bot/lib/shared/walk-classify.js`) | column semantics, surface-pick under overhangs, partial-block heights, RLE hysteresis, swath path-elevation rule, diff alignment by world coords | `classifyLine(columns, spec) → runs[]`; `diffRuns(before, after) → deviations[]`. No mineflayer imports. | fixture columns → expected runs; dithering fixture must yield ≤N runs; overhang/slab fixtures; **parity goldens vs level_ground dry-run** |
| **K2 route solver** (Py, `scripts/roadplan/solver.py`) | construction edges, route stability, RDP corner-cutting, `natural_path=None` | `solve(samples, spec, weights) → Route` | golden route-class per fixture; **invariants**: every cell under every simplified leg has finite cost; incumbent wins cost ties (no flip-flop across refine rounds); visibility-mask property; ravine fixture → bridge edge, never free crossing |
| **K3 refine targeting** (Py, small) | sampling economics | `refine(samples, route, budget) → sample_requests[]` | property: requested samples strictly shrink route-cell variance; monotonic convergence on fixtures |
| **K4 supersede protocol** (doc + author checks, Phase 4) | replan vs in-flight cards | wave-size invariant: ≤1 potentially-stale card per bot; written protocol for stale-leg handling | author-side tests: emitted waves never violate the invariant |

K1 and K2 are the two components where "80% done" still builds wrong roads
(everything else fails loudly) — they get spiked first, against fixtures,
before any shell work is graded on them.

#### 8.0.3 Shell tracks (junior — contract + test list provided up front)

| Shell | Wraps | Senior provides | Junior builds |
|---|---|---|---|
| **S1 `mc survey_line` verb** | K1 | envelope schema, chunk-truncation rules | Bresenham cell walk, loaded-chunk checks, registry entry, `--diff` wiring, contract tests from fixtures |
| **S2 `roadplan` CLI** | K2/K3 | ingest **loud-failure contract** (exit ≠0 and no `ingested N cells` line ⇒ failure; enumerated cases: empty stdin, error envelope, garbage, partial JSON), cap arithmetic spec | argparse, sample-command generation, ledger IO (write-temp-rename), ASCII/HTML render, ingest with the enumerated tests |
| **S3 `mc waypoint` verb** | §5.1 contract | placement-fallback **decision table** (water/leaves/slab/air → anchor-or-report), idempotency rules (duplicate torch, popped torch) | verb + contract tests straight from the table |
| **S4 provisioning** | — | checklist (the W1 env_passthrough lesson: verify in the *worker's* spawned shell, not the planner's) | `roadplan` bin wrapper, PATH/spec-file checks added to relaunch preflight, two-bot mark-spike script |
| **S5 adaptive graph + cards** | K4 | collocation/wave invariants (test patterns exist in `test_proc_nav_road_graph.py`) | `proc_adaptive_road_graph.py`, card emission, author tests |

Dependency graph (everything else parallel):

```
F ──→ K1 ──→ S1          K2 ──→ S2 (render/solve wiring; ingest/ledger can start on F alone)
  └─→ K2 ──→ K3          K4 ──→ S5 (Phase 4)
S3, S4: only need F's schemas — start immediately
```

Stubs keep tracks unblocked: S1 may develop against a canned-runs K1 stub;
S2's ingest/ledger needs only F's schemas. No shell waits on another shell.

### Phase 0 — Fixtures, contracts, kernels (Tracks F, K1, K2, K3; S2/S3/S4 may start)

The phase IS the §8.0 foundation:

- **Track F first** (senior): fixture corpus — clean terrain classes (flat,
  ridge, river, ravine, forest, cliff) PLUS the gotcha fixtures (`dither`,
  `overhang`, `slab_stairs`) — frozen IO schemas, golden-capture harness
  (records `level_ground` dry-run envelopes for the fixtures per §6.5),
  `data/walkability-spec.json` + JS/Python loaders, spec-literal audit test
  (no inline JS constants left for migrated thresholds).
- **K1 + K2 kernel spikes** (senior, parallel): walk-classify and route
  solver against fixtures — the two "wrong roads while tests are green"
  risks retired before any shell is graded against them. K3 (refine
  targeting) follows K2. `render` (ASCII) lands here as K2's debugging eye.
- **Shells needing only F** (junior, parallel): S2 ledger module
  (write-temp-rename, JSONL append, ingest loud-failure cases), S3 waypoint
  verb from the decision table, S4 provisioning checklist items.
- Add the header cross-links (proc-nav runbook, architecture README,
  workspaces.md) so the two road arms are indexed together.
- Tests: per the §8.0.2 kernel table (goldens + invariants + properties),
  plus unit coverage for interpolation, confidence decay, cost edges, RDP
  revalidation, "refinement demand decreases monotonically".
- **Exit gate**: on every fixture, K2 picks the expected route class and
  converges in ≤3 refine rounds with no tie flip-flop; K1 matches parity
  goldens including dither/overhang/slab; ingest failure cases all loud;
  `render` output is human-checkable.

### Phase 1 — Real terrain via RCON adapter (script domain, no bots)

Tracks: S2 RCON adapter + render wiring (junior); route review, weight
calibration, visibility-mask rehearsal analysis (senior).

- `roadplan ingest --rcon`: probe the sample grid through
  `mapcatalog.rcon_client` on a freshly materialized world.
- Run the full sample→solve→refine loop over the actual
  overlook→return_post terrain; `render` HTML overlay; eyeball the route.
- RCON may also place/move waypoint torches in this phase only — the user
  watches planning unfold before any field verb exists.
- Calibrate cost weights roughly (slope/water/tree) against the rendered
  terrain.
- **Visibility-mask rehearsal** (anti-overfit guard for §10.1): re-run the
  same solve with samples masked to sliding view-distance windows along the
  route — simulating what a walking bot can actually see. The solver must
  still converge to the same route class. RCON's unlimited visibility must
  not become a hidden dependency; this is cheap to simulate and gates the
  phase.
- The RCON sampling adapter must mirror the field pairing exactly
  (`exclude_foliage` ground read + foliage-included canopy read per cell),
  or Phase 2 cross-validation will fail on methodology, not terrain.
- **Exit gate**: a stable, human-approved route over real terrain with
  `est_edits` and `natural_path_s` numbers that look sane; total samples
  ≤ ~1.5× the theoretical refine-only budget; visibility-mask rehearsal
  converges.

### Phase 2 — Field verbs (bot-side, contract tests)

Tracks: S1 + S3 + S4's two-bot spike (junior, against contracts/test lists
from Track F); K1↔RCON cross-validation analysis and any K1 fixes (senior —
disagreements here are column-semantics bugs, not plumbing).

- `mc waypoint` (private mark + torch + move semantics per §5.1/§7.1) and
  the `wp_*` fleet-prefix addition with `roadplan` as sole shared writer.
- **Two-bot mark spike** (the §5.1 contract proven early): planner confirms
  `wp_3` → roadplan writes `locations-base.json` → second bot resolves it;
  planner moves it → second bot sees the new position; existing
  `locations-shared-merge.test.js` invariants stay green throughout.
- `mc survey_line` + `--diff` (column scan reuse, RLE classifier reading
  the spec file, ledger-aware read-only diff).
- Contract tests via the action harness (`bot/test/_helpers/action-harness.js`)
  with mocked block columns: each fixture terrain type from Phase 0 gets a
  profile test; diff tests (work done / partial / new obstruction); unloaded
  chunk truncation; shoulder drop-hazard detection.
- **Cross-validation**: on the Phase-1 world, run `survey_line` along the
  approved route legs and assert agreement with RCON ground truth (same
  cells, same deficits — methodology already matched per Phase 1's pairing
  requirement). This is the gate that retires RCON.
- **Exit gate**: profile/RCON agreement ≥ 99% of cells on 3 legs; two-bot
  mark spike passes; full bot suite green (current count + new — don't pin
  a number here, it goes stale).

### Phase 3 — In-game confirm loop (one bot + planner agent, no kanban)

Tracks: exercise script + deploy wiring (junior); cost calibration, planner
skill doctrine, hop-overhead analysis (senior).

- Bot-driven sampling replaces `--rcon` end to end: a single planner agent
  with `mc` + `roadplan` runs sample→ingest→solve→refine→confirm on a fresh
  world, placing the real torch chain via `mc waypoint`.
- Calibrate `est_travel_s`: time actual `mc move` traversals over known legs;
  fit per-cell move costs. Also measure move-hop overhead for partial
  profiles (§7.2 constraint) — if hopping dominates, shorten default legs.
- Mini-exercise script (`scripts/roadplan-exercise.sh`): fresh world →
  planner session → **asserts** (not eyeballs) the gate: ledger converged,
  torch chain placed, every waypoint confirmed in-game, sampling-command
  count within budget. The budget is enforced by the script, not by planner
  discipline alone.
- Write the planner skill: `skills/road-planner.md` — the loop doctrine
  (coarse → solve → refine ×N → confirm → workorders), sampling budget
  discipline, when to bisect (§6.3 ownership rule), replan-on-observation
  reflex.
- Deploy wiring: `roadplan` bin wrapper on the agent PATH (agents must not
  reach into repo `scripts/` at runtime, per `workspaces.md`) — genesis/env
  setup includes it, same mechanism as `mc`.
- Check the draft `marks-sign-anchored.md` before hardening waypoint
  persistence — if sign-anchored marks land, torch+JSON waypoints should
  adopt rather than compete.
- **Exit gate**: one agent, zero RCON, produces a confirmed torched route in
  ≤30 min wall time with ≤6 sampling commands, enforced by the exercise
  script.

### Phase 4 — Work orders, cards, rolling wave

Tracks: K4 supersede protocol + workorder classifier contract (senior);
S5 graph module, card emission, doctrine edits (junior).

- `roadplan workorders` + `cards` (classification table §6.5, card emission
  §6.6).
- Trial graph: the bookends graph is a **new, parallel graph module**
  (e.g. `proc_adaptive_road_graph.py`) — orchestrator authors only one
  planning card (planner agent owns `roadplan` + `kanban_create` authority +
  card budget) and one final acceptance card. `proc_scout_road_graph.py` is
  left untouched as the control arm (tier/flag-selected); its test suite is
  pinned in CI so adaptive work can't silently regress it.
- Worker doctrine updates: `skills/kanban-worker.md` (+ builder/navigator) —
  execute work orders verbatim, verify with `survey_line --diff`, on
  surprise: stop, `mc feedback` + append observation, do **not** improvise
  decks; planner replans.
- Replan loop wiring: planner card polls `observations.jsonl` between waves;
  re-solve reroutes or reclassifies the leg; corrected card supersedes.
- Tests: workorder classifier goldens per fixture; card-emission tests
  (collocation invariant, wave size, max-retries, literal verbs present —
  extend `tests/test_proc_nav_road_graph.py` patterns).
- **Exit gate**: dry-run on Phase-3 ledger emits a complete, budget-sized,
  collocated card set; control-arm graph still passes its 19 tests.

### Phase 5 — Full trial (the experiment this was all for)

- Fresh world (`MATERIALIZE=true` preflight gate), same endpoints as trial
  1781079999. Planner gets: two endpoint marks, the spec, `roadplan`,
  `kanban_create`. Nothing else.
- Acceptance card: a bot traverses the torch chain mark-to-mark **at night**,
  timed; compare against the pre-road `reachable` baseline.
- Metrics vs the fixed-graph baseline:
  - % of route length needing **zero construction** (headline — the fixed
    centerline forced cuts through whatever was in the way)
  - edits per leg; total blocks placed/removed
  - Δ traversal time (natural path vs finished road)
  - replan events observed → handled (vs `gave_up`)
  - ready→running idle (rolling wave should beat even collocated-fixed)
  - cards authored by agent vs orchestrator (target: orchestrator ≤ 3)
  - sampling commands spent; profile calls per leg
- Postmortem mines reasoning logs for residual block-by-block probing — the
  metric this whole effort targets.

## 9. File map

| Path | Phase | Contents |
|---|---|---|
| `data/walkability-spec.json` | 0 | thresholds (single source, JS+Py) |
| `scripts/roadplan.py` + `scripts/roadplan/` (ledger, solver, classify, render modules) | 0–1, 4 | the powertool |
| `data/runtime/survey/<project>/` | 0+ | ledger (gitignored, like feedback JSONL) |
| `prototypes/agent-arch/tests/test_roadplan_*.py` | 0–1, 4 | fixtures + solver/classifier/cards tests |
| `bot/lib/actions/waypoint.js`, `bot/lib/actions/queries/survey-line.js` | 2 | field verbs |
| `bot/lib/runtime/locations.js` | 2 | `wp_*` fleet prefix (roadplan = sole shared writer, §5.1) |
| `bot/test/actions/{waypoint,survey-line}-contract.test.js` | 2 | contract tests |
| `bot/cli/registry.mjs` | 2 | verb registration + help |
| `skills/minecraft-roadbuilding.md` | 0 | cite spec values instead of restating them |
| `skills/road-planner.md` | 3 | planner loop doctrine |
| `skills/kanban-worker.md`, `skills/agent-builder.md`, `skills/agent-navigator.md` | 4 | worker doctrine deltas |
| `scripts/roadplan-exercise.sh` | 3 | single-agent end-to-end check (gate enforcer) |
| `prototypes/agent-arch/capstone/proc_adaptive_road_graph.py` (new) | 4 | bookends graph |
| `prototypes/agent-arch/capstone/proc_scout_road_graph.py` | — | control arm, untouched; tests pinned in CI |

## 10. Open problems (flagged now, resolved by phase)

1. **Chunk loading bounds every scan.** corridor_sample/survey_line see only
   loaded chunks (~view distance). Resolution: legs capped ~96 blocks;
   `unknown` runs with a `move` hint; sampling plans assume the bot walks the
   box. Surfaces in Phase 2 cross-validation; the Phase 1 visibility-mask
   rehearsal guards against overfitting the solver to RCON's unlimited
   visibility. Residual risk: move-hop wall time on partial profiles —
   measured in Phase 3.
2. **JS/Python spec drift.** Resolved structurally by
   `data/walkability-spec.json` (Phase 0). Risk: a JS constant we miss;
   mitigate with a registry/grep audit test asserting no inline literals for
   the migrated thresholds.
3. **Ledger concurrency.** Resolved by construction: append-only JSONL
   multi-writer + planner-owned `state.json` single-writer (§5).
4. **Torch placement needs adjacency.** A bot can't place a torch 80 blocks
   away. Resolution: `confirm` always pairs `move` + `waypoint`; stale-torch
   removal degrades to a hint when out of reach. RCON torch moves allowed in
   Phase 1 only.
5. **Interpolation hides cliffs between samples.** A 16-block spacing can
   miss a ravine entirely. Mitigations: confidence-weighted cost penalty
   (uncertain cells repel the route), refine pass, mandatory `confirm`
   ground-truthing, and Phase-0 fixtures that specifically punish this
   (hidden-ravine fixture must trigger refinement demand, not a confident
   wrong route).
6. **Cost calibration.** est_travel_s and w_edit are guesses until Phase 3
   measures real traversal times. Keep weights in one config block;
   recalibrate from measured traversals.
7. **Tree density isn't in a heightmap.** Resolution: paired
   foliage-included/excluded sampling; canopy depth per cell as tree cost
   (§6.1). Validate against the forest fixture + Phase-2 cross-check.
8. **Tunnels.** Cost model computes through-ridge candidates but v1
   *reports* them (`tunnel candidate: saves ~Ns — needs approval`) rather
   than auto-routing. Tunneling has cave-in/lighting/water complications the
   spec doesn't model yet. Revisit after Phase 5 data.
9. **`wp_*` fleet-prefix semantics.** RESOLVED by the §5.1 mark contract:
   shared-wins merge (`locations.js:34-45`) means bot-private moves can't
   propagate, so `roadplan` is the sole `locations-base.json` writer and
   `state.json` is the authority; `mc waypoint` writes private marks + torch
   only. Proven by the Phase 2 two-bot spike against
   `locations-shared-merge.test.js` invariants.
10. **Planner reliability.** If the planning agent stalls, nothing downstream
    exists (vs a fixed graph that limps). Mitigations: card budget + deadline
    on the planner card; the control-arm fixed graph remains one flag away;
    `roadplan` state is durable, so a replacement planner card resumes from
    the ledger.
11. **Sampling budget caps.** 512 samples/call (`region.js:141`,
    `SAMPLE_CAP`); refine passes must split rows. `roadplan sample` owns this
    arithmetic — agents never see the cap.
12. **Worker write-access to the ledger.** Workers run on the same host and
    can append JSONL directly (via the ingest pipe, §5.1); if a future
    deployment splits hosts, the `mc feedback` JSONL collector (already
    per-bot) becomes the transport. Related: spatial surprises stay in the
    local ledger for now — no promotion into fleet recall streams
    (`data-api.md`) in v1; revisit if other projects need road observations.
13. **Three "road plan" homes.** `data/runtime/proc-nav-road-plan.json`
    (fixed graph), `data/runtime/survey/<project>/state.json` (adaptive), and
    the aspirational workspace `geo/` layout (`workspaces.md`). Interim rule:
    the fixed graph keeps its file; adaptive uses only the survey ledger; the
    architecture cross-links (header) note both. Consolidation is a
    workspaces decision, not this plan's.
14. **Two classifiers risk.** RESOLVED by §6.5: `level_ground` dry-run is the
    classification oracle; Python `workorders` consumes dry-run output for
    surveyed legs, offline estimates are provisional-only, and Phase 0 parity
    goldens keep them honest.

## 11. Phase 0–1 field learnings (2026-06-12)

K1–K3, the S2 RCON adapter (`scripts/roadplan/`), and natural torch
placement ran end-to-end on the live `proc-nav` world twice: a diagnostic
corridor (29 waypoints, audited node-by-node after a "torches in mid-air /
underground" report) and a clean spawn → (24,97,168) demo — 2,749 cells
sampled in 283s, natural route, 22 waypoints, **zero construction edits**,
22/22 torches verified on natural ground at grade. The audit surfaced two
root-cause bugs and four doctrine lessons. Each entry names the code that
embodies it and the rule that must survive into `skills/road-planner.md`
(Phase 3) — these apply to **any planner agent computing routes or
placements** (roads, pads, canals), not just this pipeline.

### 11.1 Torches are verification, not decoration

The first in-world repair "fixed" unplaceable torches by placing cobble
anchors and pillars under them — which masked Y errors: bad waypoints got
anchored high in the air or deep underground and looked "placed" anyway.
User doctrine (binding): *if a torch cannot be placed naturally (without
any base block) then it's likely in the wrong place.* Natural-anchor-only
placement turns a placement failure into a route-quality signal.

- Code: `scripts/roadplan/torch_chain.py` (`place_chain`: in-column natural
  anchor → lateral snap ≤1 cell at grade → `needs_construction` report,
  never a fabricated block; idempotent on already-lit cells). The bot wire
  (`mc waypoint` → pickTorchAnchor) already complies.
- Planner doctrine: a `needs_construction` torch report triggers re-solve
  or a construction card for that span — never "fix" placement by adding
  blocks. Worker cards must not instruct anchor fabrication either.

### 11.2 Waypoint elevation is walk grade, never raw cell Y

Root cause of "torches buried 4–5 blocks deep": RDP simplification lands
waypoints on `gap`/`water` cells, and `solve` emitted that cell's measured
floor Y — the bottom of a 1-wide pit, not the elevation a walker crosses it
at. Gap/water floor Y exists for bridging economics; the route's elevation
across those cells is the grade interpolated between the adjacent walkable
cells.

- Code: `solver._walk_elevations` (interpolates waypoint Y across
  gap/water cells from flanking walkable samples).
- Generalizes: any solver output consumed for *physical placement* must
  distinguish "measured floor" from "travel elevation". Same rule for pad
  corners, bridge abutments, stair landings.

### 11.3 Top-down column scans report roofs; neighbor continuity repairs them

Root cause of "torch in mid-air": a 9-block-thick natural overhang shelf
captured its column — the descent reported feet on the shelf roof (y=111)
while the route ran on the ground below (y=97). Pure column data cannot
distinguish roof from floor; **neighbor continuity can**: a column whose
feet exceed its 8-neighbor median by more than `rcon_spike_threshold`
resumes the descent below the roof and takes the surface nearest the
neighbor median. Genuine one-column bumps survive (solid all the way down
→ no second surface).

- Code: `rcon_adapter._repair_spikes`. Tests: overhang and genuine-bump
  fixtures.
- Generalizes: the K1 swath classifier and any field column-top sampler
  (`survey_line`, `corridor_sample`) share this blind spot — Phase 2
  cross-validation must include an overhang leg, and K1 should adopt the
  same median-continuity check if disagreements show up there.

### 11.4 Probe economics: coarse-then-fine, at every layer

The exhaustive descent (14 passable predicates × every Y × every column)
cost ~390–450s per 450-cell segment over RCON — each probe is one
`execute if block` round-trip share. Replaced with a two-phase scan
(§rcon_adapter docstring): coarse `#minecraft:air`-only grid at y_step=4
(+ fine air-only rescan for columns the grid misses — floors thinner than
the step exist), one bracket batch to pin the topmost non-air block, then
full-predicate refinement only from that boundary down. Same answers
(regression suite unchanged), **6–11× faster in the field**; a budget test
pins the probe count so it can't regress.

- Accepted blind spot: a thin (<4) floating shell above deeper ground is
  skipped in favor of the ground — which is what road semantics want; the
  exhaustive scan had the inverse problem (§11.3) and needed repair anyway.
- Generalizes: this is the same shape as `roadplan sample` → `--refine`
  (§2 "samples are the currency"). Observation budgets bind at every layer
  — solver sampling, RCON probing, and field `survey_line` hops alike.

### 11.5 Ingest long corridors in segments with a rolling y_hint

`gap` is judged against the corridor-wide reference (`y_hint + 1`), so a
single ingest over steadily climbing/descending terrain misreads the far
end (deep-floor "gaps" that are really just lower ground, or missed real
gaps on higher ground). The demo corridor climbed 64 → 96 cleanly by
ingesting in ~24-line-cell segments with each segment's `y_hint` set to
the previous segment's median feet.

- Planner doctrine: never single-shot a corridor whose endpoints differ by
  more than a few blocks of elevation; chain segments and roll the hint
  forward. `roadplan sample` should own this arithmetic eventually (same
  spirit as §10.11 — agents never see the cap).

### 11.6 Verify the chain after placement

Placement reports are claims. The demo's acceptance check re-probed every
node: torch present, solid natural support beneath, |torch Y − 4-neighbor
median feet| ≤ 1.5. Cheap (a handful of probes per node) and it caught a
silently-skipped node in the diagnostic corridor that every earlier "looks
done" pass had missed.

- Planner doctrine: after `confirm`/placement, run the verification sweep
  before authoring work cards; in Phase 2+ this is `survey_line --diff`
  along each leg. A chain is "lit" when verification says so, not when
  placement returns.

## 12. Agent-loop build + live validation (2026-06-12)

The §3 dataflow's two missing pieces — `roadplan sample` (§6.1) and
`roadplan confirm` (§6.4) — are built as general-purpose CLI subcommands
that **emit literal `mc` commands** for a planner agent to run (never
execute them); the agent pipes `--json` output back through
`roadplan ingest`. `ingest` now accepts three envelope kinds
(corridor_sample, survey_line, waypoint). New skill `skills/road-planner.md`
carries the loop doctrine. Pure decision logic lives in
`scripts/roadplan/emit.py` (fixture-tested); the live world only runs the
emitted strings.

The loop was driven end-to-end on the live `proc-nav` world (operator acting
as the planner agent, running the emitted commands verbatim against bot Mox):
a clean ~14-block corridor converged, solved `natural` (0 edits), and
`confirm` staked + lit a 3-waypoint torch chain — **3/3 verified on natural
ground**. A parallel clearing-class corridor exercised the construction
guard. Going live surfaced eight bugs that fixture tests could not; all are
fixed and regression-tested (88 Python + 176 JS green):

1. **`mc move` needs X Y Z, not X Z** (the doc's §6.4 examples were wrong).
   The sampling-approach surface Y isn't known until you sample it, so
   `sample` emits `mc goto_near <x> <y> <z> <range>` (tolerant of an
   approximate Y from `--y-hint`/ledger median) instead.
2. **Confirm-walk vs construction.** A route with construction edits is not
   yet traversable — the bot can't reach its waypoints, and a torch on an
   unbuilt span hangs in mid-air. `confirm` now **refuses** non-natural
   routes (exit 3) and points to the build role; `--force` overrides. Build
   first, then light.
3. **Prior torches poisoned re-samples.** `corridor_sample` reported a route
   torch as a 1-block "surface", lifting the next solve onto it. Torches
   (and soul variants) are now see-through in the `exclude_foliage` path
   (`dig-tools.js` `isFoliageName`), like snow — only surveys are affected,
   not dig/place.
4. **Piped stdout truncated at 64 KB.** `mc … --json | roadplan ingest`
   lost large samples because the CLI called `process.exit()` before the
   async pipe write drained (classic Node footgun). `bot/cli/index.mjs` now
   flushes before exit — fixes every large `mc --json` pipe, not just
   roadplan.
5. **Flat error-envelope shape crashed ingest.** `mc` emits both
   `{error:{code,message}}` and flat `{error:"msg", code}`; ingest now
   handles both so the §11.1 alarm reaches the agent loudly.
6. **`promote` looked in the wrong dir** — `bin/roadplan` runs from
   `scripts/`, so its relative `--data-dir data` default missed the repo
   `data/`. Now defaults to repo-root `data/`.
7. **Torch provisioning.** `mc waypoint` lights from inventory; an unstocked
   bot fails `INVENTORY_MISSING`. Documented in the skill (check `mc status`
   before confirm; restock mid-chain).
8. **Self-occupied torch cell.** The torch goes in the route's standable
   feet cell, so a bot standing there to light it blocks its own placement
   (`TARGET_SELF_OCCUPIED`). `mc waypoint` now **steps off** the cell (exact
   GoalBlock to an adjacent standable cell) before placing.

Doctrine these feed into `skills/road-planner.md` and Phase 3: the loop is
`sample→ingest until converged → solve → render → refine×N → confirm →
verify`; `confirm` refuses construction routes; tools emit commands, agents
ratify. Deferred to the next iteration: deriving the sampling approach-Y
per-rect from the ledger (vs one `--y-hint`), and re-requesting
unloaded-null cells instead of treating them as covered gap.

## 13. What this generalizes to

`sample/ingest/confirm`, the ledger, `waypoint`, `survey_line`, and
rolling-wave card emission are task-agnostic. A structure project swaps the
A* road solver for a "cheapest level N×M pad near X" solver and reuses
everything else: stake corner marks → survey footprint → workorders
(cut/fill courses sized per worker) → observe → replan → functional
acceptance ("door reachable, interior lit"). The road is the first solver,
not the product.

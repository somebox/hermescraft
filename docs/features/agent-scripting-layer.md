# Agent scripting layer — region selectors and a query/actuation language

Status: draft / planning. No implementation yet. This document captures a design exploration; it does not lock syntax or commit to a runtime.

Companion to the observation-verbs redesign (`observation-verbs-redesign.md`). That document reorganizes the `mc` *verbs* (the four lanes: self / locale / expedition / chart) and their *response shapes* (typed nouns, `delta`/`goal` blocks). This document explores the next layer down: letting agents express observation and action as **composable expressions and scripts** instead of one-shot CLI strings.

## Why consider this

Two observations drive it:

1. **LLMs are strong at code.** Chaining a few CLI calls and parsing prose to answer "how many stone blocks are in this box?" is more awkward for a model than writing `box(p1,p2).find('stone').count`. The data backs the friction: `find` / `find_blocks` / `discover` are three separate habits for one question, and `find_blocks` wins only because it returns coordinates.
2. **Addressing is re-learned per verb.** Today each verb hard-codes how you point at the world (`dig x y z`, `dig_area y1 y2`, `scout radius`, `find_blocks radius`). There is no shared way to say "the cells around my body", "3m ahead", "this box", or "around the base mark".

The goal is a layer where **finding a resource is writing a scanner, and acting is executing a procedure** — and where useful procedures can be saved, inspected, and regression-tested instead of re-derived from prose each session.

## Hard constraints (learned from this repo)

Any scripting surface has to respect what the framework already enforces. These are not optional:

- **The verb layer is the enforcement boundary.** Every fair-play LOS check, `PROTECTED_BLOCK` / region permission, place-repeat guard, and the `ok()/fail()` action contract lives **inside the verb handlers** (`bot/lib/shared/action-contract.js`, the region store, `bot/lib/runtime/fair-play.js`). Code must call *through* those handlers, never raw mineflayer beneath them.
- **A second execution surface must not bypass operator control.** A live incident had Steward re-run an operator-*denied* operation through the Python sandbox (`from hermes_tools import terminal`); commit `870c4e3` added the SOUL rule "a deny is a deny — no routing through another tool surface" (`reports/genesis/.../mid-p1-issues.md`). A code surface with game access is a larger version of that hole unless denies are enforced at the shared boundary, surface-independent.
- **Macros lock out re-evaluation.** The reactive layer is deliberately per-tick micro-actions, *not* a macro engine, because a long-running macro stops the bot noticing HP/threat/terrain changes (`docs/design/phase-2/reactive-layer.md`, `docs/patterns.md`). Any batch or long action in a script must yield so the reactive layer can still interrupt.
- **Models hallucinate un-documented grammar.** The grammar A/B study found models score 0% extrapolating parallel verbs and "invent commands from their training prior" (`scripts/eval-grammar/RESULTS.md`). A bespoke API must be **small, real, and documented**, or agents will write plausible methods that don't exist.
- **`block_y` vs `surface_y`.** The off-by-one between "the block" and "where feet stand" is a recurring live-fleet bug; the convention (`docs/conventions/coordinates.md`) must be baked into any geometry helpers, not left to raw vector math.

## Part 1 — region selectors (low risk, do regardless)

The first, safe move is independent of any scripting runtime: standardize **how a verb's target is addressed**, so one region grammar feeds every verb. The verb stays the same; its target argument becomes a region expression.

| Form | Meaning |
|------|---------|
| `x,y,z` | one cell (today's default) |
| `x,y,z r=2` | cube/sphere around a point |
| `p1 p2` | box between two corners |
| `me r=1` | the cells around the bot's ~2m body |
| `3m north` | relative offset from facing / bearing |
| `@base r=8` | region around a mark (reuses the marks store) |
| `look 5` | cell(s) along the view ray (reuses `blockAtCursor`) |

One region resolver then feeds `inspect`, `dig_area`, `search`, `scene`, `place_fill`, etc. The agent learns addressing once, and results come back in the shared typed-noun shape (`pos` / `dist` / `bearing`) regardless of how the region was expressed.

Two rules the resolver must follow:

- Declare **`block_y` vs `surface_y`** for any Y-bearing region.
- Tag results **`seen` vs `inferred`** so honesty (fair-play LOS) is not silently broken when a region spans beyond the view cone (an `inspect p1 p2` box is x-ray; `inspect me r=1` is honest).

This is pure addressing — it changes *what you point at*, not *who executes* — so it is testable in isolation and worth doing on its own merits.

## Part 2 — a query/actuation language

The core design decision: **dot-chains are pure reads; `call()` is the only thing that mutates the world.** Mutation is marked syntactically, not by convention.

```js
// pure query: snapshot + filter, no side effects
targets = box(p1, p2).find('cobblestone').reachable

// actuation: explicit, guarded, budgeted, resumable
dug = targets.call('dig')        // → { attempted, succeeded, skipped[], interrupted_by }

if (call('move_to', midpoint(p2)).ok()) {
  floor = inspect(below(player.feet))   // typed Block noun
  if (floor.kind() == 'stone') {
    call('place', look(), 'torch')
  }
}
```

### Why `call()` for mutation

Making mutation a `call()` rather than a dot-method turns the read/write split into a property you can enforce and reason about:

1. **Static mutation footprint.** A script's effect on the world equals the set of `call()` verbs it contains. A script can be parsed *before* running to report "this touches `dig` and `move_to`, nothing else" — enabling per-verb operator allow/deny and pre-flight rejection of unknown verbs.
2. **One enforcement boundary, two surfaces.** `call('dig', x, y, z)` resolves to the **same handler** as `mc dig x y z`. The CLI is "string → handler"; the script API is "code → handler". There is no lower level for code to reach. The registry already supports this exactly: `createActionRegistry` (`bot/lib/server/action-registry.js`) exposes `has(name)` / `get(name)` / `names()` over the same handler map the CLI dispatches through. `call()` is a thin bridge over that registry.
3. **Response shapes come back for free.** `call(...)` returns the action-contract envelope, so `.ok()`, `.error`, and the proposed `delta` / `goal` / `subject` fields are first-class accessors. `.ok()` is an explicit (Go-style) branch — preferable to thrown exceptions for an LLM because it forces the model to handle the failure path, matching the existing `{ ok, error }` contract.

### The vocabulary split (anti-hallucination)

- The **pure dot-API is small and new**, so it must be tightly documented: `find`, `where`, `count`, `nearest`, `first`, `reachable`, `kind`, plus accessors on typed nouns. Without documentation the model will invent `.filter()` / `.closest()`.
- The **actuation vocabulary is the existing verb registry, unchanged.** `call('dig')`, `call('move_to')`, `call('place')` reuse names the fleet has invoked tens of thousands of times. Agents learn *one bridge* (`call(verb, args)`) over verbs they already know — not a new method per action.

Sharp rule: **dot = a small, documented, pure query language; `call()` = the entire existing `mc` verb set.**

### Geometry stdlib + the coordinate convention

Raw vector math reintroduces the bugs the conventions exist to prevent. Consider a hand-written floor check:

```js
inspect(player.pos() - vect(0, -1, 0)).kind() == 'stone'
```

Two traps in one line: `pos() - vect(0,-1,0)` is actually the block *above* (sign error), and `pos().y` is a `surface_y` (feet) while the floor block is a `block_y = surface_y - 1`. The fix is named helpers that encode the convention once, so the agent expresses intent and the library does the arithmetic:

```js
inspect(below(player.feet)).kind() == 'stone'   // below() knows feet→block_y
scene().passage('north')                          // not a hand-rolled raycast
box(p1, p2).find('cobblestone')                   // box() bakes in inclusive bounds
ahead('north', 3)                                 // relative offset from bearing
mark('base').box(8)                               // region around a mark
```

The pure layer ships origins and regions (`player.feet`, `below()`, `above()`, `look()`, `ahead(dir, n)`, `mark(id)`, `box`, `sphere`, `rect`, `midpoint`, `vect`) so agents rarely touch raw coordinates. Same philosophy as the `block_y`/`surface_y` dual-return: don't make the agent compute the easy-to-get-wrong thing.

### Batch and control-flow semantics

`box(p1,p2).find('cobblestone').call('dig')` digs many blocks — i.e. a macro, the thing the reactive doctrine pushed out. To reconcile:

- **Yield between items** so the reactive layer can interrupt (low HP, hostile, drowning).
- Run under a **step / energy budget** and return a **resumable, partial-result set**: `{ attempted, succeeded, skipped: [{ pos, reason }], interrupted_by }` — mirroring how `collect` reports `mined N/M` with causes.
- **Re-validate each target at execution time.** There is a gap between `find` (snapshot) and `call('dig')` (later); blocks may be gone, occluded, or newly protected. Because `call('dig')` is the real handler, it re-checks per target and records skips. The collection is a *plan*, not a guarantee; `skipped[]` is how reality pushes back.

### Regions and named places and players

Another possibility is to add helper functions that make it easier to pass context:

```js
targets = region('mine1/hall3').find('cobblestone').reachable
has_axe = player('axeman').has('axe')
place('base').chest_search()

```


### What stays out

Event handlers, callbacks, and schedulers (`on(threat, flee)`) do **not** belong in this layer. Reactions are the reactive layer's job, expressed as *policy data*, not agent-authored code, per the per-tick re-evaluation doctrine. This scripting layer is request/response; reactions are a separate mechanism.

## Staging

Three layers, in increasing risk. Only the first is clearly worth doing soon.

- **Layer A — read-only query DSL.** Pure expressions over observation primitives (`box(...).find(...).count`). Server-side, inside the fair-play/region context, deterministic, unit-testable. Collapses the find/find_blocks/discover/scene token thrash into one expression that returns the exact scalar/list the agent wanted (moves filtering server-side: returns `47`, not 200 blocks). This is the safe ~80% and the first thing to prototype.
- **Layer B — scripted procedures with actuation.** Adds `call()` over the verb registry, with yielding, budgets, and resumable partial results. Every actuation routes through the existing guarded handlers. Reconcilable with the reactive doctrine only because actuation is cooperative, not blocking.
- **Layer C — event handlers / schedulers.** Highest risk; conflicts with per-tick re-evaluation and operator control. Out of scope until A and B prove out, and even then prefer reactive-layer policies over agent code.

## Where patterns emerge

The exciting part is Layer A plus a **save/name** mechanism: an agent writes a scanner that works, names it (`find_exposed_iron`), and it becomes a reusable, inspectable, regression-tested artifact. That is an *executable* skill — version-controlled and assertable — versus today's prose skills (`skills/*.md`) that the model re-interprets each run. It fits the existing context-tests philosophy: a saved scanner can be pinned and asserted; prose can only be judged.

## How to validate

- **Static two-tier check:** parse a script, reject/flag `call()` verbs not in the registry *before* execution. Cheap, deterministic, catches hallucinated actuation.
- **Pure layer unit tests** against a mock world (the repo's existing pattern; cf. `bot/test/perception.test.js` and the L0 fixtures). `box(p1,p2).find('stone').count` over a fixture is a pure assertion.
- **Actuation reuses action-contract tests** — because `call('dig')` *is* `dig`, its guards already have coverage.
- **Token measurement** with `scripts/agent-context.py`: does a query expression returning a scalar cost less than the multi-verb sequence it replaces?
- **Context-tests** (`data/context-tests/`): scenarios where the right move depends on a filter the agent currently can't express cheaply; does the DSL change the first action?
- **Live A/B** with `scripts/mc-call-survey.py`: does the query layer absorb find/find_blocks/discover, and does "which verb?" thrash drop?

Pre-register success criteria (fewer observation calls per completed card, no regression in completion) and treat any single run as signal, not proof — the same caution as the goals-gap context reports (`docs/context-tests/reports/`).

## Open questions

- **A.** Keep `.ok()` explicit (no throwing) for control flow; reserve exceptions for sandbox errors (timeout, unknown verb). (Leaning yes.)
- **B.** Scalar `call()` vs collection `call()`: one method with a return shape that varies by receiver, or two names? (Leaning one name, documented shapes.)
- **C.** Where does the runtime live — JS in-process near the verb handlers (closest to the registry), or the existing Hermes Python sandbox (already present, but further from the guards)?
- **D.** How much can the pure layer compute per call before it stops being low-cost? Measure latency in Layer A, don't guess.
- **E.** Save/name persistence: where do executable skills live, how are they versioned, and how do they enter the context-test suite?

## Related work

- Observation-verbs redesign (verbs + response shapes): `observation-verbs-redesign.md` (companion).
- Coordinate convention: `docs/conventions/coordinates.md`.
- Action contract: `bot/lib/shared/action-contract.js`; registry: `bot/lib/server/action-registry.js`.
- Reactive-layer doctrine (macros vs micro-actions): `docs/design/phase-2/reactive-layer.md`, `docs/patterns.md`.
- Grammar extrapolation study: `scripts/eval-grammar/RESULTS.md`.
- Sandbox-bypass incident and the "deny is a deny" rule: `reports/genesis/2026-05-28-mid-p1-issues.md` (and commit `870c4e3`).
- Verb-usage survey: `scripts/mc-call-survey.py`.

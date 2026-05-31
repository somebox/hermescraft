# Agent scripting layer: runtime substrate for queries and composed actuation

Status: **design** (2026-05-31). Scope: the eventual runtime that
[`agent-playbooks.md`](agent-playbooks.md) will execute through. This doc is
the substrate spec; playbooks are the orchestration spec built atop it. The
earlier draft (which proposed agents authoring `call()` scripts at run-time)
is preserved in the Appendix.

Companion to
[`observation-verbs-redesign.md`](observation-verbs-redesign.md) (verb
lanes + typed response shapes) and the delivery vehicle
[`followup-improvement-pass.md`](followup-improvement-pass.md).

## Why a substrate layer

Two observations from the live fleet drive it:

1. **LLMs are strong at code.** Chaining a few CLI calls and parsing prose
   to answer "how many stone blocks are in this box?" is more awkward for a
   model than `box(p1,p2).find('stone').count`. The data backs the
   friction: `find` / `find_blocks` / `discover` are three habits for one
   question.
2. **Addressing is re-learned per verb.** Today each verb hard-codes how
   you point at the world (`dig x y z`, `dig_area y1 y2`, `scout radius`,
   `find_blocks radius`). There is no shared way to say "the cells around
   my body", "3m ahead", "this box", or "around the base mark".

The goal is a layer where **expressing a question is writing a tiny scanner,
and composing actions is naming the verb that mutates** — and where the
plumbing serves both the playbook engine (today's orchestration) and
future agent-authored composition (deferred).

**Status of adoption.** The companion
[`agent-playbooks.md`](agent-playbooks.md) is the *orchestration spec* that
ships first. Playbooks are documented phase tables; the worker SOUL walks
them; there is no run-time engine yet. The substrate in this doc — region
selectors (Part 1), query DSL (Layer A), `call()` engine (Layer B) —
becomes the eventual runtime that playbook phases execute through, in that
order of risk.

## Hard constraints (unchanged from earlier draft)

Any scripting surface has to respect what the framework already enforces.
These are not optional:

- **The verb layer is the enforcement boundary.** Every fair-play LOS
  check, `PROTECTED_BLOCK` / region permission, place-repeat guard, and
  the `ok()/fail()` action contract lives **inside the verb handlers**
  (`bot/lib/shared/action-contract.js`, the region store,
  `bot/lib/runtime/fair-play.js`). Code must call *through* those
  handlers, never raw mineflayer beneath them.
- **A second execution surface must not bypass operator control.** A live
  incident had Steward re-run an operator-*denied* operation through the
  Python sandbox (`from hermes_tools import terminal`); commit `870c4e3`
  added the SOUL rule "a deny is a deny — no routing through another tool
  surface" (`reports/genesis/.../mid-p1-issues.md`). A code surface with
  game access is a larger version of that hole unless denies are enforced
  at the shared boundary, surface-independent.
- **Macros lock out re-evaluation.** The reactive layer is deliberately
  per-tick micro-actions, *not* a macro engine, because a long-running
  macro stops the bot noticing HP/threat/terrain changes
  (`docs/design/phase-2/reactive-layer.md`, `docs/patterns.md`). Any batch
  or long action in a script must yield so the reactive layer can still
  interrupt.
- **Models hallucinate un-documented grammar.** The grammar A/B study
  found models score 0% extrapolating parallel verbs and "invent commands
  from their training prior" (`scripts/eval-grammar/RESULTS.md`). A
  bespoke API must be **small, real, and documented**, or agents will
  write plausible methods that don't exist.
- **`block_y` vs `surface_y`.** The off-by-one between "the block" and
  "where feet stand" is a recurring live-fleet bug; the convention
  (`docs/conventions/coordinates.md`) must be baked into any geometry
  helpers, not left to raw vector math.

## Part 1 — region selectors (low risk, do regardless)

The first safe move is independent of any runtime: standardize **how a
verb's target is addressed**, so one region grammar feeds every verb. The
verb stays the same; its target argument becomes a region expression.

| Form | Meaning |
|------|---------|
| `x,y,z` | one cell (today's default) |
| `x,y,z r=2` | cube/sphere around a point |
| `p1 p2` | box between two corners |
| `me r=1` | the cells around the bot's ~2m body |
| `3m north` | relative offset from facing / bearing |
| `@base r=8` | region around a mark (reuses the marks store) |
| `look 5` | cell(s) along the view ray (reuses `blockAtCursor`) |

One region resolver then feeds `inspect`, `dig_area`, `search`, `scene`,
`place_fill`, etc. The agent learns addressing once, and results come back
in the shared typed-noun shape (`pos` / `dist` / `bearing`) regardless of
how the region was expressed.

Two rules the resolver must follow:

- Declare **`block_y` vs `surface_y`** for any Y-bearing region.
- Tag results **`seen` vs `inferred`** so honesty (fair-play LOS) is not
  silently broken when a region spans beyond the view cone (an `inspect
  p1 p2` box is x-ray; `inspect me r=1` is honest).

This is pure addressing — it changes *what you point at*, not *who
executes* — so it is testable in isolation and worth doing on its own
merits. **It is also what playbook `act:` rows already need today:**
the mining `chamber` phase says "dig a 4×3×4 box at landing" — the
unified region selector is how that becomes a single call instead of a
hand-written cube of `dig` invocations.

## Part 2 — Layer A: pure-query DSL

The next layer is **read-only**: composable expressions over observation
primitives, server-side, deterministic, unit-testable. Collapses the
find / find_blocks / discover / scene / nearby thrash into one expression
that returns the exact scalar / list the agent wanted.

```js
// pure query: snapshot + filter, no side effects
exposed_iron = box(@mine_entrance.r(32)).find('iron_ore').reachable.count

// boolean predicate (playbook verify use case)
chamber_safe = scene().passage('back_to_stair').ok() && light_level(here) >= 8
```

The pure dot-API must be **small, named, and documented**, so it must be
tightly scoped: `find`, `where`, `count`, `nearest`, `first`, `reachable`,
`kind`, plus accessors on typed nouns. Without documentation the model
will invent `.filter()` / `.closest()`.

**Predicates as playbook preflight/verify.** Layer A's predicates are
exactly what playbook phase `preflight` and `verify` rows need:

```yaml
# inside a playbook phase, written today as worker discipline,
# tomorrow as a Layer A expression:
preflight:
  - have_tool: stone_pickaxe
  - mark_reachable: { mark: lt_stone_west, max_distance: 256 }
verify:
  - inventory.count(cobblestone) >= 128
  - can_retrace: true
```

Today the worker walks these as a sequence of read-only `mc` calls.
Layer A would let `preflight` be one server-side expression evaluated in
one round-trip.

### Geometry stdlib + the coordinate convention

Raw vector math reintroduces the bugs the conventions exist to prevent:

```js
inspect(player.pos() - vect(0, -1, 0)).kind() == 'stone'
```

Two traps in one line: `pos() - vect(0,-1,0)` is actually the block
*above* (sign error), and `pos().y` is a `surface_y` (feet) while the
floor block is a `block_y = surface_y - 1`. Named helpers encode the
convention once:

```js
inspect(below(player.feet)).kind() == 'stone'   // below() knows feet→block_y
scene().passage('north')                          // not a hand-rolled raycast
box(p1, p2).find('cobblestone')                   // box() bakes in inclusive bounds
ahead('north', 3)                                 // relative offset from bearing
mark('base').box(8)                               // region around a mark
```

The pure layer ships origins and regions (`player.feet`, `below()`,
`above()`, `look()`, `ahead(dir, n)`, `mark(id)`, `box`, `sphere`,
`rect`, `midpoint`, `vect`) so agents rarely touch raw coordinates. Same
philosophy as the `block_y`/`surface_y` dual-return: don't make the
agent compute the easy-to-get-wrong thing.

## Part 3 — Layer B: `call()` for composed actuation

When Layer A exists and playbook phases prove stable as documentation, the
next step is making the procedure executable as code, not just markdown.
**Mutation marked syntactically:** dot-chains are pure reads; `call()` is
the only thing that touches the world.

```js
// the chamber phase of mine.underground_target, as eventual Layer B
function chamber(ctx) {
  // Layer A read
  const path_back = scene().passage('back_to_stair');
  if (!path_back.ok()) {
    // Layer B actuation
    const r = call('dig_area', box(ctx.landing.r(2)).asArgs());
    if (!r.ok()) return r;
  }
  call('place', look(), 'torch');
  // verify
  return { ok: light_level(here) >= 8 && scene().passage('back_to_stair').ok() };
}
```

Three guarantees the substrate must give:

1. **Static mutation footprint.** A function's effect on the world equals
   the set of `call()` verbs it contains. Can be parsed before running
   to report "this touches `dig_area`, `place`, nothing else" — enabling
   per-verb operator allow/deny.
2. **One enforcement boundary, two surfaces.** `call('dig_area', args)`
   resolves to the **same handler** as `mc dig_area args`. The CLI is
   "string → handler"; the script API is "code → handler". The
   registry already supports this exactly: `createActionRegistry`
   (`bot/lib/server/action-registry.js`) exposes `has(name)` / `get(name)`
   / `names()` over the same handler map the CLI dispatches through.
   `call()` is a thin bridge over that registry.
3. **Response shapes come back unchanged.** `call(...)` returns the
   action-contract envelope — `.ok()`, `.error.code`,
   `.error.next_action_hint` — so existing branch tables in playbooks
   keep working when phases migrate from markdown to code.

### Vocabulary split (anti-hallucination, unchanged from earlier draft)

- The **pure dot-API is small and new**, so it must be tightly
  documented.
- The **actuation vocabulary is the existing verb registry, unchanged.**
  Agents learn *one bridge* (`call(verb, args)`) over verbs they already
  know.

Sharp rule: **dot = small, documented, pure query language; `call()` =
the entire existing `mc` verb set.**

### Batch and control-flow semantics

`box(p1,p2).find('cobblestone').call('dig')` digs many blocks — i.e. a
macro, the thing the reactive doctrine pushed out. To reconcile:

- **Yield between items** so the reactive layer can interrupt (low HP,
  hostile, drowning).
- Run under a **step / energy budget** and return a **resumable, partial-
  result set**: `{ attempted, succeeded, skipped: [{ pos, reason }],
  interrupted_by }` — mirroring how `collect` reports `mined N/M` with
  causes.
- **Re-validate each target at execution time.** There is a gap between
  `find` (snapshot) and `call('dig')` (later); blocks may be gone,
  occluded, or newly protected. Because `call('dig')` is the real
  handler, it re-checks per target and records skips. The collection is
  a *plan*, not a guarantee; `skipped[]` is how reality pushes back.

## Staging

Three layers, in increasing risk. The first is the safe ~80%; the second
unlocks playbook-as-code; the third stays deferred.

| Layer | Content | Status |
|---|---|---|
| **Part 1** region selectors | One addressing grammar feeding every verb's target arg | Worth doing now as a refactor; benefits playbook `act:` rows too |
| **Layer A** read-only query DSL | `box(...).find(...).count`, predicates, geometry stdlib | First runtime addition; absorbs playbook `preflight:` / `verify:` rows |
| **Layer B** `call()` engine | Composed procedures as code that re-uses the verb registry | Next runtime addition once Layer A is proven; playbook phases migrate phase-by-phase |
| **Layer C** event handlers / schedulers (`on(threat, flee)`) | Conflicts with per-tick reactive doctrine. Stays out. | Out of scope; reactive policy lives in the reactive layer, expressed as policy data, not agent-authored code |

## How playbooks use this substrate

[`agent-playbooks.md`](agent-playbooks.md) ships the orchestration spec
*before* any of this layer is built. The interaction over time:

- **Today (playbooks v1):** markdown phase tables; worker SOUL walks them;
  preflight / verify rows are sequences of existing read-only `mc` calls.
  Region selectors (Part 1) would shorten `act:` row arguments.
- **Layer A lands:** playbook preflight / verify rows can be single-call
  expressions, reducing turns per phase. Branch tables remain markdown.
- **Layer B lands:** playbook phases migrate from markdown tables to
  inspectable, fixture-testable JS functions. Branch tables remain
  documented as code paths in the function.
- **Layer C:** still deferred. Reactions stay in the reactive layer.

## How to validate

- **Static two-tier check:** parse a script, reject/flag `call()` verbs
  not in the registry *before* execution. Cheap, deterministic, catches
  hallucinated actuation. Stage 0 of the follow-up plan already adds the
  underlying `envelope.fromAction` adapter that makes this trivial.
- **Pure layer unit tests** against a mock world (the repo's existing
  pattern; cf. `bot/test/perception.test.js` and the L0 fixtures).
  `box(p1,p2).find('stone').count` over a fixture is a pure assertion.
- **Actuation reuses action-contract tests** — because `call('dig')` *is*
  `dig`, its guards already have coverage.
- **Token measurement** with `scripts/agent-context.py`: does a query
  expression returning a scalar cost less than the multi-verb sequence
  it replaces?
- **Context-tests** (`data/context-tests/`): scenarios where the right
  move depends on a filter the agent currently can't express cheaply;
  does the DSL change the first action?

Pre-register success criteria (fewer observation calls per completed
card, no regression in completion) and treat any single run as signal,
not proof — the same caution as the goals-gap context reports
(`docs/context-tests/reports/`).

## Open questions

- **A.** Keep `.ok()` explicit (no throwing) for control flow; reserve
  exceptions for sandbox errors (timeout, unknown verb). (Leaning yes.)
- **B.** Scalar `call()` vs collection `call()`: one method with a return
  shape that varies by receiver, or two names? (Leaning one name,
  documented shapes.)
- **C.** Where does the runtime live — JS in-process near the verb
  handlers (closest to the registry), or the existing Hermes Python
  sandbox (already present, but further from the guards)? (Leaning JS
  in-process for proximity to `bot/lib/shared/action-contract.js`.)
- **D.** How much can the pure layer compute per call before it stops
  being low-cost? Measure latency in Layer A, don't guess.
- **E.** Save/name persistence for executable skills: when Layer B lands,
  playbook phases as functions can be versioned alongside the markdown
  table. Phase definition becomes the canonical artifact; the table is
  generated from it.

## Appendix: earlier draft (agent-authored Layer B)

The earlier version of this doc proposed letting *agents* freely
compose Layer B scripts at the moment of need:

```js
box(p1,p2).find('cobblestone').reachable.call('dig')
```

That direction had three live tensions that the playbook orchestration
spec now sidesteps:

1. **Hallucination.** A new dot-API documented in a skill page would
   still drift; the grammar A/B study found models score 0% on parallel-
   verb extrapolation. Procedures-as-documentation (playbooks) with a
   closed id registry sidesteps this until Layer B lands as a thin
   bridge over real handlers.
2. **Operator control.** A second mutation surface agents author at
   run-time made the "deny is a deny" rule harder to enforce. Playbooks
   authored by Steward against a closed registry keep the existing
   surface; the registry is the deny point.
3. **Macros vs reactive.** A long script `box.find.call` blocked
   reactive re-evaluation. Layer B's yielding contract handles this
   when it lands; until then, playbooks step verb-by-verb through the
   reactive doctrine.

The Layer A pure-query thinking is preserved verbatim above. Layer B as
the eventual runtime for playbook phases is preserved here. Layer C
(event handlers / schedulers) stays out for the same reasons as before.

If templates and SOUL-walked phase tables prove insufficient and we
genuinely need agent-authored control flow inside a phase, we can
revisit Layer B with the same engine, predicate library, and verb
registry already in this design.

## Related work

- Orchestration spec built on this substrate:
  [`agent-playbooks.md`](agent-playbooks.md).
- Delivery vehicle:
  [`followup-improvement-pass.md`](followup-improvement-pass.md).
- Observation-verbs redesign (verbs + response shapes):
  [`observation-verbs-redesign.md`](observation-verbs-redesign.md).
- Coordinate convention: `docs/conventions/coordinates.md`.
- Action contract: `bot/lib/shared/action-contract.js`; registry:
  `bot/lib/server/action-registry.js`.
- Reactive-layer doctrine: `docs/design/phase-2/reactive-layer.md`,
  `docs/patterns.md`.
- Grammar extrapolation study: `scripts/eval-grammar/RESULTS.md`.
- Sandbox-bypass incident and the "deny is a deny" rule:
  `reports/genesis/2026-05-28-mid-p1-issues.md` (commit `870c4e3`).
- Verb-usage survey: `scripts/mc-call-survey.py`.
- Registry audit and cheatsheet cadence:
  [`docs/mc-command-audit-2026-05-29.md`](../mc-command-audit-2026-05-29.md).
- Playbook pass closure (defer Layer B runtime; prose vs structured by task):
  [`playbook-improvement-pass-closure.md`](playbook-improvement-pass-closure.md),
  [`wave-6-granularity-lab.md`](wave-6-granularity-lab.md).

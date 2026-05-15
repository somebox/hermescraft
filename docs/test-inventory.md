# Test inventory

A living catalog of every test and test-like artifact in the HermesCraft
repo, organized by tier (unit / functional / integration / fixture /
benchmark). This document is the Round 2 deliverable that Round 3 will
use to decide which tests to merge, fix, or delete.

Each suspected overlap and gap below was validated by reading the
actual source files (not just filename heuristics) — see "Validation
notes" at the end of each section.

**Last verified:** 2026-05-15
**Verification baseline:** 113 Node unit tests + 6 pytest unit tests green.

---

## Counts at a glance

| Tier | Count | Total LOC | Runner |
|---|---|---|---|
| **Node unit** | 23 files (~50 cases) | 1,607 | `cd bot && npm test` |
| **Python functional** | 44 files | 8,678 | individual `scripts/test-*.py --bot-url ...` |
| **Python unit (mjs)** | 1 file | 350 | `node scripts/test-pathfind-watchdog-unit.mjs` |
| **Agent integration (YAML)** | 33 files (F: 7, G: 21, M: 4, P: 1) | — | `scripts/agent-test.py <yaml>` |
| **World fixtures** | 105 YAML (L0: 16, L3: 59, L8: 8, L9: 10, L10: 8, B: 4) | — | `scripts/run-fixture.sh` |
| **Benchmark** | 2 runners + ~70 tasks | ~825 (run.mjs+run-two-tier.mjs) | `node scripts/benchmark/run.mjs` |
| **Generators** | 4 (`scripts/gen-*.{py,mjs}`) | ~280 | one-shot tools |

---

## Tier 1 — Node unit tests (`bot/test/`)

**Status: healthy.** No reorg needed; tightly coupled to `bot/lib/...` via
relative imports, runs in <1s, gates CI. Stays in place.

| File | LOC | What it tests |
|---|---|---|
| `crafting.test.js` | 269 | Recipe validation, inventory crafting logic |
| `cli/dispatch.test.js` | 164 | Action dispatch routing, method matching |
| `chat.test.js` | 103 | Message parsing, routing, broadcast logic |
| `cli/results.test.js` | 88 | Result aggregation, status codes |
| `dig-tools.test.js` | 86 | Tool tier matching, hardness calculations |
| `perception.test.js` | 69 | Block observation, entity tracking |
| `goals.test.js` | 54 | Goal parsing, inheritance chains |
| `resolver.test.js` | 118 | Action resolution, context binding |
| `cli/args.test.js` | 47 | CLI arg parsing |
| `cli/execute.test.js` | 44 | Shell execution, env passing |
| `cli/registry.test.js` | 42 | Command definition parsing |
| `recipe-ingredients.test.js` | 41 | Recipe component matching |
| `cli/output.test.js` | 33 | Response formatting |
| `cli/http.test.js` | 34 | HTTP client response handling |
| `http-app.test.js` | 26 | HTTP route stubs |
| `dashboard-reasoning-format.test.js` | 21 | Brain output formatting |
| `bot-manager.test.js` | 19 | Bot lifecycle stub |
| `schemas-domains.test.js` | 55 | Schema validation |
| `cli-action-sync.test.js` | 59 | CLI ↔ action handler naming contract |
| `spatial.test.js` | 17 | 3D math: distance, direction, LOS |
| `action-registry.test.js` | 15 | Action registration dedup |
| `fair-play-constants.test.js` | 9 | Fair-play rule constants |
| `integration/listener-health.test.js` | 194 | HTTP listener heartbeat (with stubbed deps) |

**Naming asymmetry to remember:** `bot/test/integration/listener-health.test.js`
is named "integration" but under our taxonomy it's a *unit* test (no MC, no
LLM — uses stubbed deps). Leave it where it is; the path is grandfathered.

---

## Tier 2 — Python functional tests (`scripts/test-*.py`)

44 tests, all requiring: live MC server + running bot at the test's
configured URL + SSH/rcon access to the MC host. Every test reimplements
`rcon`, `rcon_batch`, `http_get`, `http_post` and a near-identical setup
preamble (kill mobs, peaceful, time noon, clear inv, give saturation).

### Inventory (sorted by LOC desc)

| File | LOC | F-series | What it tests |
|---|---|---|---|
| `test-dig-walk-pickup-chain.py` | 765 | F72 | Dig → walk → pickup chain across pillar obstacle geometry |
| `test-mine-behind-wall.py` | 413 | F40-ish | Fair-play LOS check: don't "stab through" intervening blocks |
| `test-recovery-protocols.py` | 356 | F45–F48 | R1/R2/R3 recovery contracts (head-blocked, target-occupied, inv-missing) |
| `test-attack-through-wall.py` | 349 | F40-ish | Fair-play LOS check on combat (no swing-through-wall) |
| `test-mine-collect-grid.py` | 302 | (general) | 3×3 cobble grid mining + collection, block-collision |
| `test-door-pathfind.py` | 256 | F66/F69 | Door traversal matrix (open/closed × hinge × approach direction) |
| `test-stuck-loop-prevention.py` | 253 | F57 | Escape recurring stuck loop |
| `test-task-semantics.py` | 247 | F46 | `/task` endpoint sync/finished slots |
| `test-flee-no-threat.py` | 239 | F47 | `mc flee` doesn't auto-target players |
| `test-nav-reachable.py` | 227 | F48/F73 | `/reachable` predicates + nav error enrichment |
| `test-region-predicates.py` | 226 | F45 | Region predicates (indoors, sheltered, at-water) |
| `test-movement-precondition.py` | 215 | F50/F51 | Liquid/suffocation preconditions |
| `test-drown-protection.py` | 205 | F50 | Liquid suffocation detection |
| `test-pickup-blocked.py` | 198 | F50 | Blocked-pickup error envelope |
| `test-fill-self-displace.py` | 196 | F50 | Self-block + displacement chain |
| `test-action-reach-pathing.py` | 194 | (general) | Reach constraint on dig/place |
| `test-movement-errors-enriched.py` | 191 | F48 | Stuck-cell tracking in nav errors |
| `test-escape-multidir.py` | 191 | F57 | Multi-direction escape |
| `test-through-fresh-door.py` | 174 | F55.4 | `mc through` re-fetches block state for freshly-placed doors |
| `test-stuck-recenter.py` | 174 | F45 | Stuck watchdog re-centers off-axis wedge |
| `test-collect-underwater.py` | 187 | (general) | Underwater item collection |
| `test-through-recovery.py` | 181 | F55 | Door passage with recovery fallback |
| `test-through-elevated-door.py` | 179 | F56 | Step-up + jump-nudge through elevated platform door |
| `test-corner-cut-prevention.py` | 179 | F60 | Pathfinder corner-cutting prevention |
| `test-dig-door-support.py` | 170 | F54.1 | Dig-under-door support destruction prevention |
| `test-wait-chat-interrupt.py` | 165 | (general) | Chat interrupt on `/wait` |
| `test-place-fresh-craft.py` | 164 | F54.5 | Fresh placement + immediate crafting (no pickup gap) |
| `test-fill-self-blocking.py` | 163 | F50 | Self-block doesn't break reachable-path |
| `test-is-sheltered-wall-check.py` | 163 | F45 | Shelter predicate (4-wall test) |
| `test-inspect.py` | 143 | (general) | `/inspect` entity/block state lookup |
| `test-place-los.py` | 147 | F62 | Place action requires LOS to target |
| `test-chest-los.py` | 142 | F64 | `openContainer` LOS guard |
| `test-interact-los.py` | 139 | F65 | `activateBlock` LOS guard |
| `test-inventory-advisories.py` | 150 | F54.3 | Inventory advisories (full/empty/delta) |
| `test-action-timeouts.py` | 169 | F45 | Wallclock caps on dig/place/move |
| `test-whisper-as-mention.py` | 131 | (general) | Whisper routing as broadcast mention |
| `test-collect-recent-pickup.py` | 116 | F72 | Recent-dig short-circuit |
| `test-goto-near-los.py` | 105 | F66 | Goto_near respects LOS occlusion |
| `test-goto-near-reachability.py` | 90 | F73 | Reachability hints (F73/F74) |
| `test-stall-reachability.py` | 78 | F73 | Stall detection on reachability boundary |
| `test-dig-los.py` | 67 | F66 | Dig requires LOS |
| `test-through-los.py` | 66 | F55 | `mc through` LOS validation |
| `test-goto-near-landing.py` | 161 | F60 | Goto_near finds stable landing near obstacles |
| `test-door-simple.py` | ~90 | F66 | Simple door open + walk-through |

### Suspected overlaps — validated

The Explore agent flagged six pairs of suspicious overlaps. After reading
each test's docstring and main scenario:

1. **`test-chest-los.py` (F64) vs `test-interact-los.py` (F65)**
   — **NOT a true overlap.** Different code paths: `openContainer` in
   `bot/lib/actions/containers.js` vs `activateBlock` in
   `bot/lib/actions/world.js`. Each maps to a specific F-fix. Keep both.

2. **`test-mine-behind-wall.py` vs `test-attack-through-wall.py`**
   — **NOT a true overlap.** Both test "fair-play LOS" but on different
   action modules: `world.js` (mining) vs `combat.js` (attack). Each
   exercises a different swing-packet / dig-packet code path. Keep both.

3. **`test-through-fresh-door.py` (F55.4) vs `test-through-elevated-door.py`
   (F56) vs `test-door-pathfind.py` (F66/F69)**
   — **NOT a true overlap.** Three distinct concerns:
   - F55.4: stale-snapshot fix (re-fetch block state)
   - F56: step-up + jump-nudge for elevated platforms
   - F66/F69: open/closed door matrix with hinge variants
   Each exercises code that the others don't. Keep all three.

4. **`test-movement-errors-enriched.py` (F48) vs `test-nav-reachable.py`
   (F48/F73)** — **PARTIAL overlap.** Both inspect nav error envelopes.
   Reading the docstrings: errors-enriched focuses on the `stuck_cell`
   field; nav-reachable focuses on the `closest_standable` and
   `reachability` fields. Adjacent but not duplicate. **Round 3
   recommendation:** merge into one `test-nav-error-envelopes.py` with
   sections per field, ~half the LOC of the two.

5. **`test-stuck-loop-prevention.py` (F57) vs `test-stuck-recenter.py`
   (F45) vs `test-recovery-protocols.py` (F45–F48)** — **NOT redundant.**
   - Recovery-protocols is the broad contract test (R1/R2/R3 envelopes)
   - Stuck-recenter is a specific watchdog scenario (off-axis wedge)
   - Stuck-loop-prevention tests the escape recurring-loop guard
   Different scenarios; recovery-protocols subsumes the *envelope* shape
   but not the *behavior* the other two probe.

6. **The 7-test LOS cluster** (`test-{dig,place,interact,chest,through,
   goto-near}-los.py` + `test-mine-behind-wall.py` +
   `test-attack-through-wall.py`) — **NOT redundant individually**, but
   could be consolidated for *runtime efficiency* into a parametric
   test with a shared arena. **Round 3 recommendation:** keep as separate
   tests for clarity, but a shared `fixtures/los_arena.py` helper could
   reduce per-test setup duplication ~150 LOC.

### Suspected gaps — flagged for Round 3+

Validated by reading `bot/lib/actions/` and checking for corresponding tests:

1. **Action-handler unit tests are missing.** 12 action files in
   `bot/lib/actions/`, none have a `bot/test/actions/` mock-bot unit
   test. Every action is exercised only via Tier 2 functional tests
   against a live MC. **Recommendation:** add `bot/test/actions/*.test.js`
   with stubbed-deps tests (same pattern as `listener-health.test.js`).
   ~200–400 LOC of new tests.

2. **Pathfinder constraints lack unit tests beyond
   `test-pathfind-watchdog-unit.mjs`.** Specifically untested at the
   unit level: parkour toggle, fluid avoidance, reach constraints,
   door/slab detection. **Recommendation:** expand the .mjs test or
   add a `bot/test/pathfinder.test.js`.

3. **`scripts/agent-test.py` itself (948 LOC) has no tests.** Critical
   harness code with predicate evaluation and rich session parsing.
   The Round 2 work extracts predicates into `tests/_lib/predicates.py`
   *with* a unit test — this gap is partially addressed by the harness
   library. **Recommendation:** add `tests/unit/test_agent_test_predicates.py`
   to extend `test_predicates_evaluate_passes_and_fails` (in
   `tests/unit/test_smoke.py`) with edge cases the original
   `predicate_results()` handled.

4. **Region predicates (`is_sheltered`, `is_indoors`, `is_at_water`)**
   only tested via the live Tier 2 `test-region-predicates.py` and
   `test-is-sheltered-wall-check.py`. **Recommendation:** the
   underlying geometry math should have a unit test in `bot/test/spatial.test.js`
   (currently only 17 LOC).

5. **No tests for the `mc` CLI's argument parsing for compound
   coordinates** (e.g. `~X+offset`). `bot/test/cli/args.test.js` (47
   LOC) covers simple parsing only.

### Suspected obsolescence — flagged for Round 3+

None of the 44 Python tests is obviously obsolete. Every one was added
in the past 4 weeks (F45–F74 = 2026-04–2026-05 sprint) and references
a still-existing code path. **Round 3 should re-validate** after the
larger code is split (e.g. `bot/lib/actions/world.js` 4121 LOC). Tests
that exercise a section of `world.js` may need updating if the split
moves logic to `world-build.js` / `world-excavate.js` / `world-query.js`.

---

## Tier 3 — Agent integration tests (`data/agent-tests/*.yaml`)

33 YAMLs driven by `scripts/agent-test.py`. Each is a Hermes-agent
scenario: prompt + skills + expected end-state predicates.

| Prefix | Count | Theme |
|---|---|---|
| `F1`–`F7` | 7 | Failure modes (literal names, phantom search, door blockade, ...) |
| `G1`–`G21` | 21 | Goal chains (survival, farming, animals, two-bot coordination at G21) |
| `M1`–`M3` | 4 | Mission tests (maze nav, navigate-build, collect-place) |
| `P1` | 1 | Persona test (mixed blocks) |

These are Round 3 migration candidates — `agent-test.py` becomes a
pytest collector (`tests/integration/conftest.py:pytest_collect_file`)
that reads each YAML as a test case.

---

## Tier 4 — World fixtures (`data/test-fixtures/`)

105 declarative YAMLs (prep + cleanup + verify) run via
`scripts/run-fixture.sh`. Grouped by level:

| Level | Count | Theme |
|---|---|---|
| L0 | 16 | Basic health/connected/perception checks |
| L3 | 59 | Actions (dig, collect, craft, interact) — largest tier |
| L8 | 8 | Crops (till, plant, bonemeal, harvest) |
| L9 | 10 | Animals (breed, shear, milk, hunt, lure) |
| L10 | 8 | Water (fish, place_boat, board, disembark) |
| behavior (B) | 4 | Multi-step composition (fetch + smelt variants) |

**Gap:** levels L1, L2, L4, L5, L6, L7 are missing — the level numbering
is non-sequential. Either rename L8/L9/L10 to L4/L5/L6 to close the gap,
or document why these specific numbers (perhaps reserved for future
mechanics).

---

## Tier 5 — Benchmark suite (`scripts/benchmark/`)

- `run.mjs` (~475 LOC) — LLM grading on `mc` command correctness
- `run-two-tier.mjs` — two-tier ranking
- `tasks/` (60+ tasks across `challenges.json`, `direct.json`, `composition.json`)
- `fixtures/` (~15KB benchmark fixture files)

LLM-only — no live MC. Round 2 leaves this in place; Round 3+ may
move tasks into `tests/fixtures/benchmark/` and the runner stays
under `scripts/` (different value model from pytest).

---

## Orchestrators — **not tests**

- `scripts/g20-bench.py` (160 LOC) — multi-run sampler for G20 (N passes
  per model, pass-rate stats)
- `scripts/g21-orchestrator.py` (1634 LOC) — 2-bot coordination state
  machine, phase-keyword dispatch
- `scripts/orchestrator-v0.sh`, `scripts/combat-suite.sh` — older
  orchestrators (look for obsolescence in Round 3)

These run tests but aren't themselves tests. Out of scope for migration.

---

## Generators — also not tests

- `scripts/gen-place-test.py`, `gen-place-focused.py`, `gen-maze-test.py`
  — fixture generators
- `scripts/gen-mc-cheatsheet.mjs` — cheatsheet doc generator

Stay under `scripts/`. Useful tools; not test code.

---

## Naming asymmetries to remember

1. `bot/test/integration/listener-health.test.js` — named "integration"
   but is unit by our taxonomy (stubbed deps, no MC). Grandfathered.
2. `scripts/test-pathfind-watchdog-unit.mjs` — only `.mjs` test in
   `scripts/`; it's a unit test. Round 3 could move it into
   `bot/test/pathfinder.test.js` next to the other Node tests.
3. The `B*` fixtures (behavior tests) overlap conceptually with the
   `M*` agent-tests (missions). The distinction: B's are pure fixtures
   (declarative world prep), M's drive an agent. Document this clearly
   when migrating.

---

## Tests-per-area heatmap

```
bot/lib/actions/world.js     ████████████████ 16+ tests touch this
bot/lib/actions/mining.js    ███████ 7+
bot/lib/actions/movement.js  ██████ 6+
bot/lib/actions/combat.js    ████ 4+
bot/lib/actions/containers.js ███ 3+
bot/lib/actions/crafting.js  ██ 2+ (mostly via agent-tests)
bot/lib/actions/farming.js   █ 1+ (mostly L8/L9 fixtures)
bot/lib/actions/animals.js   █ 1+ (mostly L9 fixtures)
bot/lib/actions/water.js     █ 1+ (mostly L10 fixtures)
bot/lib/runtime/manager.js   ░ 0 unit-level (only integration cover)
bot/lib/runtime/reactive.js  ░ 0 unit-level
bot/lib/runtime/observation.js ░ 0 unit-level (covered by listener-health stub)
bot/lib/goals/engine.js      █ 1 unit test (goals.test.js)
```

`bot/lib/runtime/` is the most under-tested area at unit level. Its
behavior IS covered by Tier 2/3 tests via the live bot, but it has no
dedicated mock-bot unit tests. Round 3+ priority.

---

## Round 3 candidate list (priority order)

1. **Migrate one functional test as exemplar.** `test-nav-reachable.py`
   → `tests/functional/test_nav_reachable.py` (already covered by Round 2
   Step 6).
2. **Merge `test-movement-errors-enriched.py` + `test-nav-reachable.py`**
   into one parametric test (~half the LOC).
3. **Add `bot/test/actions/` mock-bot unit tests** for the 12 action
   modules (~300 LOC of new tests).
4. **Migrate the agent-test YAML driver** to pytest. `agent-test.py`
   becomes `tests/integration/conftest.py` collector.
5. **Move `data/test-fixtures/` → `tests/fixtures/`** as part of step 4.
6. **Cluster the 7-test LOS suite** behind a shared `los_arena` helper.
7. **Migrate the remaining 42 functional tests** in batches of 10.
8. **Add unit tests for `bot/lib/runtime/{manager,reactive,observation}.js`.**

---

*If you spot anything wrong or stale, edit this file and update the
"Last verified" date at the top. The file:line references should resolve
on the current `main`.*

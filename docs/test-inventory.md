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

44 tests, all requiring: live MC server + running bot at the role's
configured URL + SSH/rcon access to the MC host.

**Standardized in Round 2.5:** all 44 tests now import
`scripts/_test_lib.default_bot_url(role)` instead of hardcoding a port.
Role resolution: `flint` → `localhost:3001` (38 tests); `tester` →
`localhost:3004` (6 tests). The shared helper reads
`config/hermescraft.yaml`; override per-run by exporting
`HERMESCRAFT_BOT_URL`. Run the whole suite with `scripts/run-functional.sh`
(supports `--filter`, `--exclude`, `--role`, `--bail`).

Each test still reimplements `rcon`, `rcon_batch`, `http_get`,
`http_post` locally — Round 3 will fold these into `_test_lib` too
(currently only `default_bot_url` is shared).

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

4. **`test-movement-errors-enriched.py` (F50.6) vs `test-nav-reachable.py`
   (F48)** — **NOT a true overlap** (corrected on re-read). Both inspect
   the nav error envelope but on **orthogonal facets**:
   - `nav-reachable` checks the *target-side* fields: `target_standable`,
     `target_reason`, `closest_standable`, `best_stand`.
   - `movement-errors-enriched` checks the *bot-side* field:
     `your_standing_state.classification` (corner / alley / trapped) on
     every error code path (`NAV_TARGET_OCCUPIED`, `NAV_BLOCKED`,
     `BOT_TRAPPED`).
   They exercise different code paths in the bot's state assembler.
   Keep both.

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

### Within-test setup boilerplate (not redundancy, but pytest will fix it)

A user observation prompted an audit of the mining/pickup test family:

| Test | LOC | Distinct concern |
|---|---|---|
| `test-mine-collect-grid` | 350 | `mc collect` high-level verb, multi-iteration LOS re-eval |
| `test-mine-behind-wall` | 414 | `mc collect` fair-play LOS guard |
| `test-dig-walk-pickup-chain` | 766 | `mc dig + goto_near + pickup` primitives, corner-touch wedge |
| `test-collect-recent-pickup` | 115 | F72 recent-dig short-circuit |
| `test-collect-underwater` | 188 | Liquid suffocation during collect |
| `test-pickup-blocked` | 199 | G20 v28 — pickup wedge on drops behind walls |

**Verdict:** none of these is redundant — each maps to a specific
F-fix or G-incident with a different code path. But the **setup
boilerplate is heavily duplicated**: each test reimplements its own
3×3 grid placer, its own deep-clean, and its own per-scenario reset
loop (~50 LOC each). Within a single test, scenarios call
`setup_scenario()` 4-5 times consecutively, each rebuilding the same
geometry from scratch.

This duplication is what Round 3's pytest harness solves directly: a
shared `arena.clean()` fixture (already in `tests/_lib/arena.py`)
plus a `grid_3x3` fixture parameterized by height would let the 6
tests above share one arena with per-scenario reset. Estimated dedup:
~250 LOC across the family, plus runtime savings (each `setup_scenario`
batch is 1–2s of rcon round-trips that pytest fixtures would reuse).

For now, the tests stay individually correct. The dedup is a
Round 3 batch-migration target.

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

### Tests with potentially invalid conclusions — flagged for Round 3+

These tests pass when their HTTP response says `ok=true` but don't
verify the *side effect* the test name implies. A regression where the
bot returns `ok=true` without actually changing world state (e.g. dig
says success but the block is still there, place says success but
nothing is placed) would slip through silently.

| Test | Scenario | Pass condition | What's missing |
|---|---|---|---|
| `test-action-reach-pathing.py:86` | A: chest_far | `passed = ok` | Should verify bot moved within reach of chest (pos delta) |
| `test-action-reach-pathing.py:157` | D: lever_far | `passed = ok` | Should verify bot moved within reach of lever |
| `test-dig-door-support.py:108` | B: dig_with_force | `passed = ok` | Should verify the block is now air |
| `test-dig-door-support.py:119` | C: plain_cobble | `passed = ok` | Should verify the block is now air + cobble in inventory |
| `test-collect-underwater.py:126` | A: dry_sand_baseline | `passed = ok` | Should verify sand inventory delta |
| `test-place-fresh-craft.py:96` | A: ... | `passed = ok` | Should verify block placed at target coord |
| `test-place-fresh-craft.py:115` | B: ... | `passed = ok` | Should verify block placed at target coord |
| `test-through-recovery.py:143` | ... | `passed = ok` | Should verify bot crossed the gate |

**Pattern fix (~3 lines per callsite):** add a single rcon `if block
<x> <y> <z> minecraft:<kind>` check or a pre/post inventory delta via
the bot's `/inventory` endpoint. The legacy tests already have helpers
that show how — see `test-mine-collect-grid.py:cobble_count` for the
inventory pattern, and `test-mine-behind-wall.py` for the `if block`
pattern.

**Severity ranking:** dig-door-support scenarios B/C and
place-fresh-craft are the riskiest — a real regression in dig/place
returning false-ok could go un-noticed. The reach-pathing tests are
less risky because the auto-pathfind code rarely returns ok=true
without moving (would require a serious framework bug).

### `test-dig-door-support.py` — F66 LOS guard invalidated original geometry (fixed)

The original geometry placed cobble supports AT y=64 (the floor level)
with doors above at y=65/66. When F66 added the dig LOS guard, the
bot's raycast from eye (~y=66.62) down to the cobble face had to
traverse y=64 cells full of surrounding floor stone, and got refused
for `NO_LINE_OF_SIGHT`. Three further compounding issues:

1. Scenarios A, B, C, D placed targets at x=3, 5, 7 along the same z-row,
   so even after lifting the supports out of the floor, scenario B's
   raycast to (5, 65, 0) still transited the cobble at (3, 65, 0)
   placed for scenario D.

**Fixes landed in this round:**
- Lifted all support cobbles to y=65 (above the y=64 floor) and shifted
  the doors/fence-gates above each to y=66/67.
- Added `tp_adjacent(x, z)` helper that teleports the bot one block
  west of each scenario's target before the dig. Each scenario's LOS
  is now isolated from sibling-scenario blocks.

All 4 scenarios now PASS against live infra. The state-verification
assertions added earlier (Round 2.5 cleanup) continue to catch any
regression where the dig returns ok=true without actually breaking
the block.

### `test-fill-self-blocking.py` — DELETED (obsoleted by F60)

Was testing F55.2 (post-hoc "bot was inside fill region" detection).
F60 supersedes that with prevention (auto-displace before placement),
so the bot is never inside the region during fill — the detection
flag is never set. Test couldn't pass against current code without
also disabling F60.

Coverage of F60's prevention path is now in `test-fill-self-displace.py`.
If F60 ever gains a `bypass_displace` flag (e.g. for testing F55.2
in isolation), a replacement test should be added.

### `test-fill-self-displace.py` — docstring/code mismatch in scenario C

The module-level docstring claims scenario C is:

> C — Bot stands on the wall (head cell in region, feet below). Expected:
> bot auto-moves sideways off the wall, fill completes.

But the implementation does something different — it puts the bot's **foot
cell** in the region (same family as scenario A, just on a 5×3 fill instead
of 3×3):

```python
def scenario_on_wall(bot_url: str) -> bool:
    print("\n=== C: bot inside large 5×3 region — must displace and complete ===")
    # ... bot tp'd to (2, 65, 1) with floor at y=64 → feet at y=65, foot cell IN region
```

The `print` line correctly describes what happens; the docstring at the top
of the file claims something else. The "head in region, feet below" case
(bot standing on a y=64 block while the fill is at y=66) is never tested.

**Visual effect users may notice:** During scenario C the bot briefly
appears "inside a wall" as cobble is placed around it before F60's
auto-displace moves it out. The behavior is correct — F60's whole purpose
is to detect and resolve this — but the appearance can mislead a viewer.

**Fixed in this round:**
- Updated docstring to match the actual implementation.
- Added a post-fill safety assertion: query the bot's final position and
  verify its foot cell is air (not stuck inside a placed cobble block).
  A regression where F60 displaces to an unsafe cell would have slipped
  through under the prior `not bot_inside` check alone.

**Still TODO (Round 3):** implement the originally-claimed "head in
region, feet below" scenario if it adds coverage, OR drop the claim from
the docstring permanently. The current implementation tests larger-region
displacement, which is a valid scenario in its own right.

### `test-recovery-protocols.py` — "PARTIAL pass returns True"

This test's docstring claims:

> Asserts the final goal state was achieved AND each intermediate
> step produced the contract-promised data.

But scenarios R1 (line 192–194) and R2 (line 240) **return `True` even
when the end-to-end recovery did not work**:

```python
# scenario_R1, line 192:
if not r2.get("ok"):
    print(f"    PARTIAL: retry to closest_standable+r=2 failed code={c2}")
    print("    contract delivered correct data; full recovery still needs more work")
    return True  # contract check passed even if recovery didn't

# scenario_R2, line ~234:
# NOTE: end-to-end recovery (mc dig the table) currently fails because
# mineflayer's getDigTime reports ~95s for wooden_axe on crafting_table
# (real MC value is ~1.25s). guardSlowDigEstimate rejects. Separate from
# F48 — tracked as a carry-forward for a future framework sprint.
return True
```

So the test passes when the contract data is correctly delivered, *even
if the documented recovery procedure ultimately fails*. The author is
explicit about this in the print output ("PARTIAL"), but the test's
exit code is still 0 → CI sees PASS.

**Round 3 fix options:**
- **A**: Restructure the scenarios to return three states (`PASS`,
  `PARTIAL`, `FAIL`). Main exit code = 0 only if all `PASS`.
- **B**: Use pytest `xfail(reason="...")` after the test is migrated
  — fail-by-default, succeed if the framework issue is fixed.
- **C**: Mark these scenarios skip-by-default and require an
  explicit `--include-blocked` flag to run them.

Recommendation: **B** during Round 3 migration. The xfail captures
the carry-forward intent without lying about test status.

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

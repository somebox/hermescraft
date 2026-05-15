# Patterns and conventions

Maintenance-oriented patterns extracted from real lessons. Each entry says
**what** the pattern is, **why** it matters, and **how to check** it (or "soft —
review-time").

The goal is consistency that survives across sessions and contributors. When
in doubt, follow these. When you find a new pattern that's worked twice, add
it here.

---

## P1. Validate hypotheses before refactoring

**Pattern:** if you can run a cheap experiment that gates an expensive change,
run it first.

**Why:** a few cents of OpenRouter calls falsified the categorical-grammar
refactor (predicted ~10pp accuracy gain → measured +2pp, within noise).
~700 LOC of churn avoided. See `scripts/eval-grammar/RESULTS.md`.

**How to check:** review-time. Before any refactor that touches >200 LOC or
crosses architectural boundaries, ask: "What's the smallest experiment that
would tell us this is wrong?" If you can't think of one, the refactor is
purely aesthetic — that's fine, but be honest about the motivation.

---

## P2. Generated docs from a single source of truth

**Pattern:** if a doc describes structured data (commands, capabilities,
fixtures), generate it from the data, not from prose.

**Examples:**
- `docs/mc-cheatsheet.md` is generated from `bot/cli/registry.mjs` via
  `scripts/gen-mc-cheatsheet.mjs`. Hand-edited docs go stale; this one
  cannot.
- `data/capability-matrix.yaml` is the source for capability tracking; any
  rollup view should be rendered from it.

**How to check:** if a doc duplicates information that exists elsewhere as
structured data, replace it with a generator. Don't accept hand-curated
duplicates of registry data in PR review.

---

## P3. Discoverability via `--help` on every command

**Pattern:** every `mc` command supports `--help` and `mc help <command>`.
Skills reference command names; agents pull detail on demand instead of
loading 50KB of prompt context.

**How to check:** registry validity test (see `scripts/check-conventions.mjs`)
asserts every entry has a `description`. Examples can be sparse but
description is non-negotiable.

---

## P4. Test fixtures: uniform world, safe-home cleanup, target tags

**Pattern:** every fixture must:
- Use `landfolk-test` as its world (no production overworld for tests).
- Tag entities to be counted/killed with `Tags:["target"]` so suite runners
  can identify them.
- Cleanup teleports Flint back to `(52, 65, 52)` (the walled, lit safe-home).
- Never use `mvtp Flint world` (cross-dimension to production overworld).

**Why:** fixtures must be repeatable. Carry-over state (poison, stuck arrows,
respawn into a mob-spawning chunk) makes the next test start dirty. This is
how F40 got bug-hunted for 30 minutes — bad reset state.

**How to check:** see `scripts/check-conventions.mjs`. Lints all
`data/test-fixtures/**/*.yaml`.

---

## P5. The reset is owned by the SUITE RUNNER, not individual fixtures

**Pattern:** suite-level concerns (kill+respawn for visual reset, clamp
gamerules, set spawnpoint, fully clear effects/inventory) live in the
suite runner. Per-fixture prep handles only the **arena geometry and
the things being tested**.

**Why:** if every fixture re-implements reset logic, drift accumulates and
you end up with 60 slightly-different prep blocks. `scripts/combat-suite.sh`
shows the canonical reset; new suites should follow the same shape.

**How to check:** soft — review-time. If a fixture's prep is duplicating
gamerule clamps or `kill @e` calls that the suite runner already does,
move them to the runner.

---

## P6. `/kill Flint` is the only reliable visual reset on Paper players

**Pattern:** Paper blocks `data merge entity` on players, which means
`StuckArrowCount`, hit-cooldown, and damage-tilt animations cannot be
zeroed directly. The only fix is `/kill Flint` + auto-respawn at a
pre-set spawnpoint. Mineflayer reconnects in ~1s.

**Why:** "data merge entity Flint" returns "Unable to modify player data."
We discovered this after 30 minutes of trying NBT paths.

**How to check:** documented here so the next session doesn't re-discover.

---

## P7. Findings log (F-numbered)

**Pattern:** when something surprises you (a bug, an unexpected limitation,
a non-obvious root cause), log it with an F-number in
`docs/experiments/phase-2-sprint-log.md`. Each entry: **symptom** → **root
cause** → **fix** → **verification**.

**Why:** F40 alone documents three pitfalls (Paper + bow auto-equip, rcon
suppressing entity-`say`, tag-counter reuse) any of which would otherwise
cost a future session 30+ minutes to re-diagnose. The log is institutional
memory.

**How to check:** review-time. If a debugging session yielded a non-obvious
finding, ask "is this in the F-log?" before closing the work.

---

## P8. Layered architecture, no upward calls

**Pattern:** the bot is three layers (per `docs/phase-2-architecture.md` §16):
- **Layer 1** — macros (`mc *` actions, run on demand, may be long-running).
- **Layer 2** — reactive autopilot (per-tick micro-actions, ≤500ms each).
- **Layer 3** — strategic agent (LLM-driven, observe-decide-act over seconds).

Each layer can call DOWN (Layer 3 calls Layer 1 actions; Layer 2 watches state
the bot library exposes). It cannot call UP. Layer 2 must NEVER invoke
long-running Layer 1 macros — that breaks the per-tick re-evaluation
property and was the original Layer 2 mistake before the F39–F42 refactor.

**How to check:** soft. If Layer 2 code (`bot/lib/runtime/reactive.js`) ever
imports a Layer 1 action handler that runs longer than one tick, it's a
violation.

---

## P9. Action contract shape

**Pattern:** every `mc *` action handler returns one of:
- `{ ok: true, data: {...}, result: 'human readable summary' }` — success.
- `{ ok: false, error: { code, message, observed_state, retry_safe } }` — failure.

`code` is a SCREAMING_SNAKE constant; `retry_safe` is a boolean indicating
whether the agent can retry the same call as-is. See `docs/phase-2-architecture.md` §8.

**Why:** agents key off `error.code` and `retry_safe` to decide whether to
retry, replan, or surface to the human. Inconsistent shapes break that
decision logic.

**How to check:** soft for now (review-time). Could be promoted to a runtime
contract test that exercises every handler.

---

## P10. Symmetric verb pairs

**Pattern:** when an action has a natural inverse, name them as a pair:
- `mine` / `place` / `dig` / `build`
- `fill_bucket` / `empty_bucket`
- `equip` / `unequip`
- `mark` / `unmark`
- `start` / `stop`

The empirical eval showed LLMs don't reliably *extrapolate* these (0% on
prediction tasks), but humans do — so this is a maintainer benefit, not
an agent benefit.

**How to check:** soft — review-time. When adding a new action, look at the
existing surface for its natural pair. If there's no pair, ask whether one
should exist.

---

## P11. CRUD quartet for collection-shaped APIs

**Pattern:** if a verb manages a collection (goals, marks, tasks,
reminders), implement the standard quartet:
- `add`, `list`, `update` (or `set`), `remove`

Existing examples: `goal_add` / `goals` / `goal_set` / `goal_remove`.
Future examples should follow the same shape.

**How to check:** review-time. If a new collection type only has 2–3 of
the four, ask whether the missing ones are intentional.

---

## P12. Backwards compatibility is not a project value

**Pattern:** this project does not maintain backwards compatibility. Renames
and refactors are free; old names get deleted in the same commit.

**Why:** the codebase has one production user (Foz). Carrying a
deprecation tail would be pure overhead.

**How to check:** review-time. If a PR adds a "legacy" alias or "deprecated"
shim, ask why.

---

## P13. Benchmark LLM accuracy on `mc` after pattern changes

**Pattern:** when the registry, cheatsheet, or skill text changes, run
`scripts/benchmark/run.mjs` to verify LLM accuracy didn't regress. Outputs land
under `scripts/benchmark/runs/<model_slug>/` (one JSON per model per run). Use
`scripts/benchmark/compare.mjs --model <id>` to diff the last two runs for that
model, or pass two explicit paths; **>5pp drop in accuracy or in average
`semantic_score` per (model, group)** is a failure.

**Why:** the v1-vs-v2 grammar eval (one-off) showed that intuitions about
"this should be clearer for LLMs" don't always hold. The benchmark is the
durable version of that experiment — run continuously, it catches the
opposite failure mode (a "small" change accidentally making the surface
harder to compose against).

**How to check:** `node scripts/benchmark/run.mjs` after the change;
`node scripts/benchmark/compare.mjs --model <openrouter-model-id>` (or two JSON paths).
Sprint exit gates require this to pass.

---

## P14. `script/check-conventions.mjs` is the gate

**Pattern:** convention violations that can be detected programmatically
should be detected programmatically. Run before commit:

```
node scripts/check-conventions.mjs
```

If the check fails, fix the violation (don't suppress the check).

**Currently checked:**
- Registry: every command has a `description`.
- Fixtures: every cleanup uses safe-home tp (no `mvtp Flint world`).
- Fixtures: every prep uses `landfolk-test` as the world.
- Fixtures: combat fixtures tag spawned mobs with `Tags:["target"]`.

**How to extend:** add a check function in the script. Each check should
return a list of violations with file/line. The script exits non-zero if
any check fails.

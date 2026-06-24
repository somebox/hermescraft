# Execution kernel (bulk motor)

Bulk world-edit handlers share a small runtime module under `bot/lib/runtime/execution-kernel/` instead of ad-hoc per-verb loops. Verbs keep domain logic (hazards, standpoints, bridge-fill); the kernel owns **visit order**, **pacing**, **partial progress**, and **cancel**.

## Exports

| Export | Role |
|--------|------|
| `orderCells(cells, opts)` | Pure sort. `mode`: `remove` \| `add`. `shape`: `auto` \| `volume` \| `column`. `preserveOrder`, `deferIds`, `botPos`, `anchor`. |
| `runCells(ctx, ordered, hooks, opts)` | Motor loop: cancel/deadline → `allowUnit` → `shouldSkip` → `preflight` → `beforeUnit` → `act` → `afterUnit`. |
| `progressEnvelope` / `envelopeToObservedState` | Unified partial/resume shape for handlers. |

## Ordering convention

- **Remove + volume:** Y high → low; boustrophedon XZ within each layer; optional `deferIds` (e.g. bot foot) last on that layer.
- **Remove + column:** group by `(x,z)`; columns in boustrophedon order; within column Y high → low.
- **Add:** same grouping; Y low → high.
- **Auto shape:** single `(x,z)` stack → `column`; else `volume`.

## Feature flag

- `HERMES_EXEC_KERNEL=1` or alias **`HERMES_BULK_MOTOR=1`** — enables kernel path where wired (`dig_area`, `level` dig stack, `clear_strip` preserveOrder batches).
- **`dig_area` default (2026-06-23):** kernel path stays **opt-in** — unset env + no `_useKernel` → legacy Chebyshev ring loop. Flip default only after a fleet bake-off (genesis run notes + optional `HERMES_EXEC_KERNEL=1` on workers). Tests and arena use `_useKernel` or env explicitly.
- Per-call: `args._useKernel` on `dig_area`.
- Level: `deps.useExecKernel === true` (tests) or env flag.

## Construct mode hook (schematic MVP)

Bulk handlers must not re-implement clipping loops. Construct session code ([`bot/lib/runtime/construct-context.js`](../../bot/lib/runtime/construct-context.js)) supplies:

| Piece | Role |
|-------|------|
| `buildWorksetIndex(entries)` | Map `x,y,z` → `{ category, expected_block, phase_id }` from blueprint verify mismatches + optional ok cells |
| `parseMutationPolicy(['missing','wrong',…])` | Default greenfield: `missing`, `wrong` |
| `unitAllowedInWorkset(cell, motorMode, policy)` | Pure rule: **add** → missing (+ wrong if policy); **remove** → wrong/extra per policy; **ok** → deny both |
| `createConstructAllowUnit(index, { motorMode, mutationPolicy, phase_id, plan_revision })` | Returns kernel `allowUnit` — deny → `scope_denied`, cursor still advances |
| `attachConstructUnitMeta(unit, cell, ctxMeta)` | Sets `unit.meta` for `envelope.construct` counter rollup |
| `getConstructContext` / `setConstructContext` | `ctx.runtime.construct_context` slot (begin/show/end fill this — schematic plan Track B) |

**Begin pipeline** ([`construct-lifecycle.js`](../../bot/lib/runtime/construct-lifecycle.js) + [`construct-begin-gates.js`](../../bot/lib/runtime/construct-begin-gates.js)): before verify/session grant — optional **`plan_revision`** card field vs `plan.revision` (`PLAN_REVISION_MISMATCH`), worksite **`plan=`** vs target plan (`PLAN_SITE_MISMATCH`), region sign vs `anchor.marker.coords` (`ANCHOR_DRIFT`). Success returns `plan_revision` on `construct_context`. Skip gates with `skip_revision_gate` / `skip_anchor_gate` (tests).

Handler adapters (schematic Track C): clip requested cells to allowed workset **before** `orderCells`, attach meta per unit, pass `createConstructAllowUnit` into `runCells`. Typed agent errors (`CONSTRUCT_WRONG_BLOCK`, `CONSTRUCT_ALREADY_OK`) are raised in the **handler** when `allowUnit` would deny and the verb is single-cell (`place`); bulk paths aggregate `scope_denied` in the envelope.

**Tier A verbs during construct session** (`HERMES_CONSTRUCT_CONTEXT=1` + active `construct_context`):

| Verb | Construct behavior |
|------|---------------------|
| `place_fill`, `dig_area` | Workset clip + kernel `allowUnit`; **32-cell cap applies to eligible cells after clip**, not raw box volume. |
| `place`, `dig` | Per-cell `evaluateConstructMutation`. |
| `wall`, `level`, `clear_strip` | Rejected (`BLUEPRINT_WALL_DISABLED`, `CONSTRUCT_LEVEL_DISABLED`, `CONSTRUCT_CLEAR_STRIP_DISABLED`) — use scoped fill/dig slices on plan cells. |

**Region policy (B6):** while `construct_context` is active, [`buildRegionResolveArgs`](../../bot/lib/runtime/regions/policy-guard.js) sets `guided: true` / `ad_hoc: false` so protect-intent worksite grants use `allow_guided_edit` instead of ad-hoc dig/place overrides.

Tests: `bot/test/runtime/execution-kernel/workset-scope.test.js`. Plan shape and construct rollout: [`blueprints-grabcraft.md`](../specs/world/blueprints-grabcraft.md), [`construct-canary.md`](construct-canary.md).

## Task progress (v1)

When `ctx.tasks.currentTask` is **running**, `runCells` mirrors `ProgressEnvelope` cursor/counters into `currentTask.progress.bulk_motor` every **8** units and on abort/complete. Agents can poll `/task/status` during long bulk jobs without parsing handler prose.

## Hooks

- **`allowUnit`** — construct-ready scope filter (v0 default: allow all). `false` → `scope_denied`, cursor advances, no `act`.
- **`preflight` abort** — hazard/tool gate; cursor does not advance past aborted unit.
- **`failFastOnTool`** — `TOOL_MISSING` envelope + early exit (level dig stack).

## Progress envelope

Handlers map `ProgressEnvelope` into existing `ok()` / `fail()` / `observed_state`:

- `cursor.next_index`, `cursor.units_done`, `cursor.units_total`
- `resume.plan_hash` — stable idempotency for re-run same command
- `counters.dug` / `placed` / `skipped` / `failed` / `scope_denied`
- `CANCELLED`, `TOOL_MISSING`, `OPERATION_TIMEOUT` (via adapter)

## Port tiers (v0)

| Tier | Verbs | Kernel use |
|------|-------|------------|
| A | `dig_area`, `clear_strip`, `level`, `place_fill`, `wall` | `orderCells` +/or `runCells` (see building README) |
| B | `fell_tree`, trunk `collect` | `runCells` / `orderCells` column ordering |
| C | `tunnel`, `chamber`, `dig_pit` | inherit via `dig_area` |
| D | `collect` strip refresh, `deck`, pillars | ordering helper only or none |

Construct mode (schematic MVP) adds **`allowUnit` + `unit.meta`** on the same runner — no second bulk loop in place handlers. Plan terminology: [`docs/specs/world/blueprints-grabcraft.md`](../specs/world/blueprints-grabcraft.md). Rollout: [`construct-canary.md`](construct-canary.md).

See also: [embodied-control.md](./embodied-control.md), [handler-response-contracts.md](../reference/bot/handler-response-contracts.md).

## Arena verification

Functional coverage lives in `tests/functional/terrain/test_execution_kernel_bulk.py` (pytest `@functional`, Tester `:3004`). `dig_area` tests pass `_useKernel: true` in the HTTP body; `level` / `clear_strip` column ordering on the bot process needs `HERMES_EXEC_KERNEL=1` when starting Tester ([test-arena-quickstart.md](../guides/test-arena-quickstart.md)). Node unit tests under `bot/test/runtime/execution-kernel/` and action contract files cover ordering and partial envelopes without live MC.

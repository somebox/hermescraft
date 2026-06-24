# Action handler contract (ADR)

Per-verb requirements and L0–L4 hot-path contracts live in [phase-2/action-contracts.md](./phase-2/action-contracts.md). Runtime helpers are in `bot/lib/shared/action-contract.js` (`ok`, `fail`, `validate`).

This document records **cross-cutting decisions** and a **checklist** for tests and handler changes under `bot/lib/actions/`. Link this ADR from new action test files.

## Decisions

### Throws vs structured failure

- **User-facing paths** (every `mc <verb>` handler invoked by HTTP/CLI): return `fail(code, message, opts)` or `ok(...)`. Do **not** `throw` for expected failures (missing item, out of range, hazard, validation).
- **`throw`** is reserved for programmer errors (missing required dependency at module load, impossible internal state) and should not reach the agent as an unstructured 500 when avoidable.

### Top-level `ok` vs `data.success`

- **`ok` is authoritative** for whether the action succeeded from the agent’s perspective.
- If a verb reports structured progress in `data.success`, it **must agree** with `ok`: when the verb did not achieve its goal, use `ok: false` with a stable `error.code`, not `ok: true` with `data.success: false`.

### Failure envelope

When `ok: false`, `error` must include:

| Field | Required | Notes |
|--------|----------|--------|
| `code` | yes | `SCREAMING_SNAKE_CASE` |
| `message` | yes | Actionable: subject, observed problem, suggested next step |
| `retry_safe` | yes | boolean |
| `observed_state` | when world-referenced | e.g. block at coord, inventory snapshot |
| `next_action_hint` | optional | Prefer concrete `mc …` command |

### Legacy success shapes

- Some handlers still return `{ result, … }` without explicit `ok: true`.
- **Normalize incrementally**: when a handler gains contract tests or is modified in a refactor pass, bring it to `{ ok: true, … }` via `ok()` and meet the failure-handling quality bar below.

## Failure-handling quality bar (checklist)

Use for code review and test assertions (`assertContract` / `assertFailure` in `bot/test/_helpers/action-harness.js`).

- [ ] No throws on user-facing failure paths
- [ ] Inputs validated at handler entry; bad args → `INVALID_ARGS` (or handler-specific code) with `observed_state`
- [ ] Stable `error.code` per failure kind; tests assert exact code strings
- [ ] `error.message` names verb, state, and unblock step (not bare “failed”)
- [ ] `observed_state` present when message references world state
- [ ] `next_action_hint` is a concrete `mc` command when one exists
- [ ] `retry_safe` reflects whether repeat is side-effect safe
- [ ] No empty `catch {}` without `fail()` or documented justification
- [ ] Production navigation uses helpers from `bot/lib/actions/_helpers.js`: **`pathfindGotoNear`** (watchdog + cap), **`pathfindGoalCapped`** (escape micro-moves), or **`ensureWithinReach`**
- [ ] Block-target verbs use **`canSeeBlockFaces`** (`bot/lib/actions/_los.js`) when fair-play LOS is enabled

## Argument normalization (handler entry)

Pure parsers live in `bot/lib/actions/_args.js`. Canonical shapes are documented in [`docs/reference/mc-command-reference.md`](../reference/mc-command-reference.md) Section B.

| Helper | Purpose | Failure code |
|--------|---------|--------------|
| `coord3(args)` | `{x,y,z}` finite numbers | `INVALID_ARGS` |
| `box6(args)` | `{x1…z2}` AABB | `INVALID_ARGS` |
| `boxXZ(args)` | building box or `dig_pit` `{x,z,w,l}` | `INVALID_ARGS` |
| `itemName(args, { keys })` | block/item name string | `INVALID_ARGS` |
| `count(args)` | positive integer | `INVALID_ARGS` |

**Two layers:** `_args` returns `INVALID_ARGS` for shape/parse errors only. Semantic validation after parsing keeps existing codes (`INVALID_COORD`, `UNKNOWN_BLOCK`, `AREA_TOO_LARGE`, etc.).

Adoption is incremental: handlers call `_args` at the top and `return parsed.response` on failure.

> **Archive note (2026-06):** Construct MVP shipped under `mc construct` with `HERMES_CONSTRUCT_CONTEXT=1`. Canonical contracts: [`docs/reference/bot/handler-contract-adr.md`](../../reference/bot/handler-contract-adr.md), [`docs/architecture/construct-canary.md`](../../architecture/construct-canary.md).

## Blueprint verify envelope

`mc blueprint verify` uses the standard success/failure envelope. It does **not** emit `guided_edit_progress`.

On success (`ok()`), `data` includes:

| Field | Notes |
|--------|--------|
| `blueprint_verify` | `true` |
| `summary` | `{ ok, missing, wrong, extra, scanned }` — footprint cells only |
| `mismatches` | Sample of `{ cell, local, expected, observed, category, compare_note? }` where `category` is `missing` \| `wrong` \| `extra` |
| `truncated` | When scan hit `BLUEPRINT_VERIFY_MAX_CELLS_PER_CALL` |
| `next_hint` | e.g. rerun with `--level` or `--range` |

Inside the footprint, any cell not listed in `cells[]` is expected **air**. Failures use stable codes such as `NO_PLAN_CONTEXT`, `PLAN_NOT_FOUND`, `BLUEPRINT_SIZE_EXCEEDED`, `WRITE_LOCKED`, `POLICY_DENY` (adopt/capture).

## Guided edit progress (construct / repair)

When construct context is active, scoped handlers emit `guided_edit_progress`. See the non-archive ADR § Guided edit progress and [`docs/architecture/execution-kernel.md`](../../architecture/execution-kernel.md).

## Test tagging

- **`# spec`**: defines correct behavior; failing test → fix code.
- **`# characterization`**: golden-master before refactor; change only with explicit sign-off.

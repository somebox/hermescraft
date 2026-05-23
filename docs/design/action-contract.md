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
- [ ] Production `pathfinder.goto` uses `pathfindWithProgressWatchdog` / `withWallclockCap` from `bot/lib/actions/_helpers.js`

## Test tagging

- **`# spec`**: defines correct behavior; failing test → fix code.
- **`# characterization`**: golden-master before refactor; change only with explicit sign-off.

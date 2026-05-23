# Water actions

Ferrying, buckets, fishing, and the **`mc sail_to`** orchestrator. Routing math lives in `bot/lib/runtime/water-route.js` and `boat-path.js`, not here.

## Public vs internal verbs

| Verb | Agent CLI | Notes |
|------|-----------|--------|
| `sail_to` | Yes | Full journey: plan → walk → mount → sail → disembark → land leg |
| `disembark` | Yes | Recovery / force off boat |
| `bucket_fill` / `bucket_empty` | Yes | |
| `fish` | Yes | |
| `sail`, `board`, `place_boat` | **Refused** | [`_refusal.js`](./_refusal.js) → `USE_SAIL_TO_INSTEAD` unless `_from_sail_to: true` (in-process only) |

Do not change refusal messages or codes without updating boat integration tests (`bot/test/integration/boat-workflow.test.js`).

## `sail-to/` pipeline

[`orchestrate.js`](./sail-to/orchestrate.js) wires three phases:

1. **`preflight.js`** — Coords, retry loop, at-target, boat ticket  
2. **`plan.js`** — `planWaterRoute`, route refusals, `sailLegs`  
3. **`mount-safety.js`** — Walk to entry, mount safety checks, sail, disembark, `walk_to_target`  

Shared logging: **`sail-diagnostics.js`**. Wrapper + retry state: **`sail-to/wrapper.js`**.

**Behavior freeze (A10):** error codes, hints, phase order, and mount-safety checks are regression-gated. Refactors must be behavior-neutral; run boat + water-route tests after edits.

## Failures

Prefer **`fail()`** / **`ok()`** from [`../../shared/action-contract.js`](../../shared/action-contract.js) (or the local re-export [`./_contract.js`](./_contract.js)) over inline `{ ok: false, error: … }` so `HERMES_VALIDATE=1` stays clean. Preserve existing `code`, `message`, `observed_state`, and hints when converting.

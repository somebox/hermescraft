# `mc escape`

Standing-state dispatch in [`action.js`](./action.js): `standingState()` classifies the bot cell, then a strategy runs (sidestep, pillar, water recovery, etc.).

- **Sidesteps** (corner / wedge / edge): each open cardinal uses [`pathfindGoalCapped`](../../_helpers.js) with a ~1.2s cap before brute-force burst.
- **Strategies** live in [`strategies.js`](./strategies.js); failures return **`fail()`** from [`../../../shared/action-contract.js`](../../../shared/action-contract.js) (same shape as other `mc` verbs).
- Success paths keep `recordEscapeSuccess` envelopes with `ok: true` unchanged.

When adding or changing escape behavior, follow the checklist in [docs/reference/bot/handler-contract-adr.md](../../../../docs/reference/bot/handler-contract-adr.md) (codes, `retry_safe`, hints, `HERMES_VALIDATE=1`).

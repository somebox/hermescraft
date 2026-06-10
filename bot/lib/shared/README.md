# Shared bot libraries

Cross-cutting modules used by action handlers, runtime, and the HTTP API.

## `action-contract.js`

Every `mc <verb>` handler returns an **ActionResult**:

- Success: `{ ok: true, data?, result?, …extras }`
- Failure: `{ ok: false, error: { code, message, observed_state?, next_action_hint?, retry_safe } }`

Handlers should build results with **`ok()`** and **`fail()`** so shape and `retry_safe` stay consistent. **`validate(result)`** checks conformance (used when `HERMES_VALIDATE=1`).

Design reference: [`docs/reference/bot/handler-contract-adr.md`](../../docs/reference/bot/handler-contract-adr.md).
Strategic context (reflex-first envelopes as “spinal protocol”): [`docs/architecture/embodied-control.md`](../../docs/architecture/embodied-control.md).

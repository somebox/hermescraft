# Refactor plan — archived

The 2026 refactor of `bot/lib/` completed in March 2026 (Phases 1–7 + 10).
The plan itself has moved to **[`docs/archive/refactor-plan-2026.md`](archive/refactor-plan-2026.md)**.

For the post-refactor layout — module ownership, state slices, middleware
pipeline, conventions — see **[`docs/architecture-map.md`](architecture-map.md)**.

Two phases were deferred indefinitely (still relevant if their pain returns):

- **Phase 8** — `defineAction` self-describing handlers. Would collapse the
  six parallel action-name behavior lists (`LONG_VERBS`,
  `POSITION_DEPENDENT_VERBS`, `STUCK_MOVEMENT_ACTIONS`,
  `SYNC_STUCK_ACTIONS`, `noBanner`, the CLI registry) into handler-side
  metadata. Trigger: behavior-flag duplication becomes painful or actions
  are being added frequently enough to justify the wrapper.

- **Phase 9** — `mining.js` collect/dig decomposition. `collect` (~750L)
  and `dig` (~250L) become coordinators over named helpers. Trigger:
  mining reliability needs investment, or the `@size-exempt` annotation
  on `mining.js` stops being defensible.

# ADR: Door gap vs door block (GATE-DOOR)

**Status:** accepted (gv2-12 pilot)

**Context:** Plan uses an **air gap** on the south face; gv2-11 had no `oak_door` card. `door_traversable` end gate still applies on final `construct end`.

**Decision:** Keep **air gap only** in the plan for gv2-12. Enrich worker feedback via `construct show` slice metadata (`verify_scope`, `phase_key`) and gate payloads (`door_traversable` offenders) — no mandatory `oak_door` CONSTRUCT card for the pilot.

**Consequences:** Workers should not fill the gap with solid blocks; `construct show` + end gate failures surface gap cells when blocked.

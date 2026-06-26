# Deferred: mark/fixture repair automation

**Status:** deferred until after the short pinned pilot (`docs/guides/gv2-short-pinned-pilot.md`).

## Decision (2026-06-26)

Do **not** build a broad `mark-drift.py` / `gv2-world-audit.py` repair loop yet.

gv2-2026-06-25-3 completed the plank shell once `verify.js` treated fixture blocks as
intended interior content. Offline policy checks now live in
`scripts/lib/gv2_fixture_policy.py` and the scorecard `fixture_policy` metric.

## If the pilot still shows drift

Scope a **single** repair path first:

1. Compare `chest_wood` / `chest_food` marks vs `expected_chest_depot_coords`
2. Emit exact world coords and a one-card CONSTRUCT body (no per-worker polling spam)
3. Run from `colony-planner` / overseer tooling only — not a fleet-wide worker loop

Avoid reviving stale “Steward” wording in gv2 runbooks; consumers are colony-planner,
genesis poller/overseer, and workers.

# Terrain-shaping runtime promotion

**Status:** Phase 1–2 implemented in `bot/` (2026-06-19). Context and embodied suites remain the regression guard; live workers now get matching hint precedence on NAV failures and on `mc observe`.

## Problem

Context fixtures carried `next_action_hints[]` and copy-paste-safe `mc move` lines, but live NAV errors often suggested `dig_area` / sculpt paths before a standable `mc move`, and observe JSON had no hint array. Protect-region nav failures could mirror destructive sculpt hints.

## What shipped (runtime)

| Area | Change |
|------|--------|
| `nav-hints.js` | Standable target + \|Δy\|≤2 → **`mc move` before** reach/sculpt/hop; protect-aware filtering via `observed_state.nav_in_protect_region`; `NAV_TARGET_UNSTANDABLE` helper |
| `_preflight.js` | `enrichWithStand(..., ctx)` adds `regions_here`, protect flag, `region_nav_exit_hint`; UNSTANDABLE envelope gets `next_action_hint` |
| `next-action-hints.js` | Capped (5), priority-ordered, deduped `next_action_hints[]` for observe |
| `observation.js` | Populates `next_action_hints` from nav header + brief paths; empty when `STALE_BRIEF` / `brief_refresh_required` |
| `cli/output.mjs` | Human observe block **Suggested next commands** |
| Skills / prompts | `mc deck` (not `mc bridge`); hint-weigh note; `minecraft-roadbuilding` skill_view on worker; gatherer-test stuck recovery + no pillar for “see farther” |

Fleet impact: all bots using shared `bot/lib` (landfolk + genesis-v2 bodies). Genesis workers use the same `worker.md` / navigation skill surfaces; no separate `minecraft-fundamentals.md` exists in-repo.

## Verification (2026-06-19)

```bash
cd bot && node --test test/actions/nav-hints.test.js test/runtime/next-action-hints.test.js \
  test/integration/region-protection.test.js test/runtime/observation-nav-payload.test.js test/cli/output.test.js
cd bot && HERMES_VALIDATE=1 npm test   # 1706/1707 pass; unrelated flake: test/runtime/base-goals.test.js
./scripts/terrain-shaping-batch.sh baseline --runs 3 --yes   # r_2026-06-19T10-41-41-874Z — 11/11 stable
./scripts/terrain-agent-tests.sh all   # 6/6 on Tester
```

## Non-goals (unchanged)

- 11/11 context @ n=5 is not a merge gate.
- No SOUL terrain tables; no promotion of `terrain-shaping-hint-promote` prior_patch experiment.

## References

- Context closure: [../testing/context-tuner/reports/2026-06-17-terrain-shaping-closure.md](../testing/context-tuner/reports/2026-06-17-terrain-shaping-closure.md)
- Status rollup: [../testing/context-tuner/reports/2026-06-19-terrain-shaping-status.md](../testing/context-tuner/reports/2026-06-19-terrain-shaping-status.md)
- Learnings: [../testing/context-tuner/learnings-promotion.md](../testing/context-tuner/learnings-promotion.md)

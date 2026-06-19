# Terrain-shaping — status rollup (2026-06-19)

## Layers

| Layer | Guard | Latest signal |
|-------|--------|----------------|
| Context (11 scenarios) | `./scripts/terrain-shaping-batch.sh baseline --runs 3 --yes` | **11/11 stable** — `r_2026-06-19T10-41-41-874Z` (post-runtime promotion) |
| Embodied (F_*) | `./scripts/terrain-agent-tests.sh all` | **6/6** on Tester (2026-06-19 session) |
| Bot unit/integration | `cd bot && HERMES_VALIDATE=1 npm test` | Nav hints, observe `next_action_hints`, CLI block, region nav hints covered; 1 unrelated fail: `base-goals.test.js` (threshold data) |

## Runtime promotion (closed)

Live parity work landed in `bot/`:

- NAV blocked hints: standable walk-first, protect-region non-destructive exits, UNSTANDABLE `next_action_hint`.
- Observe: `next_action_hints[]` + CLI **Suggested next commands**; suppressed when brief is stale.
- Minimal skill/prompt sync (`mc deck`, hint weigh, roadbuilding skill_view, gatherer-test pillar doctrine).

Details: [../../planning/terrain-shaping-runtime-promotion.md](../../planning/terrain-shaping-runtime-promotion.md).

## Experiments

- **`terrain-shaping-hint-promote` (prior_patch step-up):** null at n=3 — do not promote ([learnings](../learnings-promotion.md#2026-06-19--terrain-shaping-hint-promote-ab)).

## Next options

- A) Split or clarify `goals_gap_not_withdraw` gate smoke before treating mixed gate as terrain-only.
- B) Add genesis-v2 targeted smoke for shared observe/nav if a dedicated test is wanted (currently shared bot tests + embodied landfolk path).
- C) Fix `base-goals.test.js` / `data/base-goals.yaml` drift when stewards touch goal thresholds.

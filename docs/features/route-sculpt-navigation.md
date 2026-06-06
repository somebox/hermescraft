# Route-sculpt navigation (hints)

## Problem

Pathfinder failures on natural terrain (2-block lips, slopes with Δ2–5 over 16m, cliffs Δ≥6) previously surfaced generic `dig_area` or `stair_up` hints. Workers retried the same `mc move` and used `pillar_up` for horizontal scouting.

## Phase 1 (current)

- **`route-sculpt-hint.js`** — pure resolver used by `navBlockedNextActionHint`, `BOT_TRAPPED` preflight, and nav brief `suggested_hint`.
- **Standability first** — when `target_standable=false`, hints mandate `mc reachable` and `mc goto_near` to `closest_standable`.
- **Terrain-aware** — `slope_*` → `mc build_stairs`; trapped / `step_up_only` → 2-high lip `mc dig`; `cliff_above` → stairs or pillar anchor waypoint.
- **Worker rubric** — `skills/kanban-worker.md` mandatory `read_chat` + `reachable` before retry loops; `scripts/auto-stuck-check.py` echoes the same in `[AUTO_STUCK]` comments.

Classifier bands live in `bot/lib/shared/scene-landscape.js`: `slope_*` (relief 2–5), `cliff_above` (≥6).

## Phase 2 (deferred)

`mc sculpt_path` — iterative place/dig loop with edit budget; registry + cheatsheet sync when implemented.

## Tests

- `bot/test/actions/route-sculpt-hint.test.js`
- `bot/test/actions/nav-hints.test.js` (standability case)
- `bot/test/runtime/nav-brief-route-hint.test.js`

Run: `cd bot && node --test test/actions/route-sculpt-hint.test.js test/actions/nav-hints.test.js test/runtime/nav-brief-route-hint.test.js`

## Out of scope here

Kanban atomic reassign/reclaim, orchestrator 403 message copy, and `MC_API_URL` spawn routing are tracked separately; this feature does not change those surfaces.

## Bench (optional)

Steep-slope procedural acceptance can use a future `requirements/scenario_scouting_steep_slope.yaml` entry; manual check = NAV_BLOCKED hint contains `build_stairs` or lip `dig` on a seeded slope map.

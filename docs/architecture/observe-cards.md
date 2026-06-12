# Observation cards (W2)

Desk agents plan from **live worker observations**, not RCON or dashboard god-view.

## Card kinds

| `metadata.card_kind` | Title pattern | Bot prefix | Skills |
|----------------------|---------------|------------|--------|
| `research` | `[RESEARCH]` | none | planner / engineer desk |
| `observe` | `[VERIFY]` | `[bot:mox]` | `minecraft-observe` |

## Handoff: `verify_results`

Child observe card completion metadata should include:

- `observation_source`: `live_worker`
- `bot`, `mark`, `predicates[]`, `position_at_complete`

Planner cards (`pv003`) read this payload and update playbooks / `farm_plan`.

## Fairplay

World reads use bound bot HTTP (`mc verify`, `mc inspect --mark`) only.

See also [`bots-and-mc.md`](bots-and-mc.md) and [`epic-lifecycle.md`](epic-lifecycle.md).

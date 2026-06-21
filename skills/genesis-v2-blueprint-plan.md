# genesis-v2-blueprint-plan

Blueprint decomposition workflow for `colony-planner` on `genesis-v2`.

Use this when a card includes a GrabCraft URL or a multi-layer structure plan.

## Workflow

1. Read the source card (`scripts/kanban card <id>`).
2. Resolve a concrete anchor first (coords or resolved mark).
3. Run:

```bash
python3 scripts/blueprint-plan.py "<grabcraft_url>" --out data/ops/plans/<plan_id>-plan.json --plan-id <plan_id> --anchor X,Y,Z
```

4. Decompose into small cards (default shape = `genesis-v2-worker-card-schema`):
   - `[SUPPLY]` cards for material deficits
   - optional prep/region cards if the site is not ready
   - `[CONSTRUCT]` layer cards with explicit ranges/targets

## Genesis-v2 requirements

- Route to `colony-*` assignees only.
- Keep card bodies literal; no prose-only instructions.
- Include `mc bot checkout ...` first and `mc bot release` last in body-using cards.
- Do not set a `skills` field on worker cards.
- Use `parents`/`after:` only for real sibling dependencies.

## Anchor and handoff contract

Downstream workers read their own card body. Always materialize required handoff
data in that body:

- resolved anchor coordinates
- supply chest or deposit target
- worksite/mark names used by subsequent steps

Do not point workers to sibling-card comments as the only source of coordinates.

## Anti-patterns

- No legacy `scripts/board*` workflows.
- No giant all-in-one construct card; split by small reviewable increments.
- No live-debug decomposition in terminal loops while the run is active.

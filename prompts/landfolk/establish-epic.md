# Establishment epic — Steward reference (proc-lab exploration-first base)

When `[ESTABLISH:BASE]` is on the board:

1. **`scripts/reconcile-marks.py --auto`** then **`scripts/kanban board`**.
2. File missing **`[EXPLORE]`** cards from [`data/establish/templates/establish-explore-cards.yaml`](../../data/establish/templates/establish-explore-cards.yaml) using **`scripts/kanban add ... --for <epic_id>`** — never `--after` the epic.
3. When explores finish: read completes + chat; pick site (flat, defensible, central to `lt_*`); epic comment `base_anchor: X,Y,Z`; pin mark; add Mason **`[CONSTRUCT] Pad 9x9 cobble`** with coords in body.
4. Each wake: reconcile before board read (see [`skills/minecraft-scouting-site.md`](../../skills/minecraft-scouting-site.md)).

Workers use **`mc scene`** for biome, Y-band, cardinal relief, trees — not preset catalog coords.

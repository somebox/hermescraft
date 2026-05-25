---
name: minecraft-blueprints
description: "Read, verify, and adopt committed blueprint plans bound to regions via plan= on signs. Load when verifying builds, reading layer cells, or steward plan mutations."
triggers:
  - blueprint verify
  - mc blueprint
  - plan_id
  - footprint
version: 1.0.0
---

# Minecraft blueprints

Plans live at `data/ops/plans/<plan_id>-plan.json`. Regions bind with `plan=<plan_id>` on the placemark sign (see [designated-regions](../docs/features/designated-regions.md)).

## Read-only

```bash
mc blueprint show :hut3:              # or bare plan_id
mc blueprint cell :hut3: --at 370 65 -608
mc blueprint layer dystopian-hut-3 --y 5
mc blueprint materials dystopian-hut-3
mc blueprint verify :hut3: --level 5
mc blueprint verify :hut3: --range 1..3
```

Verify returns `summary: { ok, missing, wrong, extra }` and sample `mismatches`. Inside the footprint, unlisted cells expect **air**.

Phase flags: `--level N`, `--range Y1..Y2`, `--at X Y Z`. Full scans truncate at `BLUEPRINT_VERIFY_MAX_CELLS_PER_CALL` — rerun by layer/range.

Offline: `python3 scripts/blueprint-tool.py show|cell|layer|materials|verify-offline|audit …`

## Steward mutations

```bash
# Requires HERMES_BLUEPRINT_MUTATORS=<bot-usernames>
mc blueprint adopt :hut3: --at X Y Z --note "reason"
mc blueprint capture cabin1 --region :cabin1: --force
```

Air at adopt target **removes** the cell from `cells[]`. Capture scans a region and writes a new plan file.

## Workers

1. `mc task_context set <worksite>` when the construct card grants a region.
2. `mc blueprint layer <plan_id> --y N` for expected blocks.
3. Build with `mc fill`, `mc wall`, `mc place` until phase verify is clean:
   `mc blueprint verify :region: --level N`
4. `missing` → place; `wrong` → dig/replace; `extra` → dig (respect region policy).

`mc construct` / blueprint `mc repair` return `NOT_IMPLEMENTED` until Phase 2c — do not wait on them.

## Docs

- [`docs/features/blueprints.md`](../docs/features/blueprints.md)
- [`docs/design/action-contract.md`](../docs/design/action-contract.md) — verify envelope

---
name: minecraft-blueprints
description: "Read, verify, and adopt committed blueprint plans bound to regions via plan= on signs. Load when verifying builds, reading layer cells, or steward plan mutations."
triggers:
  - blueprint verify
  - mc blueprint
  - plan_id
  - footprint
version: 1.2.0
---

# Minecraft blueprints

Canonical plan shape and terminology: [blueprints-grabcraft](../docs/specs/world/blueprints-grabcraft.md). Plans live at `data/ops/plans/<plan_id>-plan.json`. Regions bind with `plan=<plan_id>` on the placemark sign (see [designated-regions](../docs/specs/world/designated-regions.md)).

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

**RCON capture/paste** (no bot, ops/tests): `scripts/capture-schematic-rcon.py` → blueprint plan JSON; `scripts/place-schematic-rcon.py` → world (`--sign-front`, `--at` / `--at-player`). Same on-disk format as bot capture.

## Steward mutations

```bash
# Requires HERMES_BLUEPRINT_MUTATORS=<bot-usernames>
mc blueprint adopt :hut3: --at X Y Z --note "reason"
mc blueprint capture cabin1 --region :cabin1: --force   # in-bot region scan → plan file
```

Air at adopt target **removes** the cell from `cells[]`. Bot capture requires `--region :id:` (v1).

## Workers

**Construct mode** (CONSTRUCT cards, `HERMES_CONSTRUCT_CONTEXT=1`): follow [`minecraft-building.md`](minecraft-building.md) § Schematic construct mode — `mc task_context set`, scoped `fill`/`place`/`dig`, `mc construct show` / `end`. Do not use `mc wall` inside the workset.

**Phase flags on verify must match the card:** If CONSTRUCT uses `--range 2..4`, VERIFY and `construct end` use the same range — not a narrower band. **`blueprint verify` missing=0** on a slice does not replace **`construct end`** success on that slice.

**L3 `starter_shelter` walls:** plan block id is **`oak_log`** (not planks-only); see [`docs/architecture/adr-schematic-gate-material.md`](../docs/architecture/adr-schematic-gate-material.md).

**Verify-only / legacy layer builds:**

1. `mc task_context set <worksite>` when the card grants a region.
2. `mc blueprint layer <plan_id> --y N` for expected blocks.
3. Build with `mc fill`, `mc wall`, `mc place` until phase verify is clean:
   `mc blueprint verify :region: --level N`
4. `missing` → place; `wrong` → dig/replace; `extra` → dig (respect region policy).

`mc blueprint verify` is always valid for read-only audits. Blueprint-aware **`mc repair`** is not the primary worker path.

## Docs

- [`docs/specs/world/blueprints-grabcraft.md`](../docs/specs/world/blueprints-grabcraft.md)
- [`docs/reference/bot/handler-contract-adr.md`](../docs/reference/bot/handler-contract-adr.md) — verify envelope

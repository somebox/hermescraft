# Blueprints (Grabcraft)

Committed **blueprint plans** under `data/ops/plans/<plan_id>-plan.json` are the **single source of truth** for what should exist inside a blueprint **footprint**. Region placemark signs bind with `plan=<plan_id>`. Bots verify against the world; the steward mutates the plan (JSON edit or `mc blueprint adopt`) when in-world changes should become design.

See also: [designated-regions.md](./designated-regions.md), [construct-canary.md](../../architecture/construct-canary.md), [handler-contract ADR blueprint verify](../../reference/bot/handler-contract-adr.md#blueprint-verify-envelope), skill [`skills/minecraft-blueprints.md`](../../../skills/minecraft-blueprints.md).

## Terminology

| Term | Meaning |
|------|---------|
| **Plan** / **blueprint plan** | On-disk JSON at `data/ops/plans/<plan_id>-plan.json` (not the raw GrabCraft download format). |
| **Footprint** | Axis-aligned box in **plan-local** coordinates (`footprint.local` inclusive ranges). World position: `localToWorld(anchor.coords, footprint, lx, ly, lz)` — anchor is the world block at the footprint **minimum** local corner (`footprint_mins`). |
| **Schematic** (informal) | Same plan file; used in ops script names (`capture-schematic-rcon`, `place-schematic-rcon`) for RCON capture/paste workflows. |
| **Construct mode** | Scoped `mc fill` / `place` / `dig` against a plan **workset** when `HERMES_CONSTRUCT_CONTEXT=1` and a CONSTRUCT card binds `plan` + `phase` + `worksite` (or `mc construct begin`). See [construct-canary.md](../../architecture/construct-canary.md). |
| **Verify** | Read-only `mc blueprint verify` — compares world blocks to `cells[]` inside the footprint (block **states** are a v1 gap; see below). |

## Plan file shape

Required for all committed plans:

| Field | Notes |
|-------|--------|
| `plan_id` | Lowercase slug matching `^[a-z0-9][a-z0-9_-]{1,40}$` (loaders normalize). |
| `footprint` | `local`: `{ x: [min,max], y: [min,max], z: [min,max] }` inclusive; `mode` documents origin (see below). |
| `anchor.coords` | World `[x,y,z]` of the footprint **minimum** local corner (same as `footprint_mins`; not always local `[0,0,0]` for `metadata` footprints). |
| `cells[]` | `{ local: [x,y,z], block }` — non-air blocks only unless you intentionally model air as a cell. |

Common optional fields:

| Field | Notes |
|-------|--------|
| `kind` | e.g. `"construct"` for construct-MVP fixtures. |
| `revision` | Plan revision string for card `plan_revision` / `PLAN_REVISION_MISMATCH` (E5). |
| `source` | Provenance (`genesis`, `captured`, GrabCraft import metadata, etc.). |
| `anchor.marker` | World `coords`, plan `local`, and `note` for origin sign / door reference. |
| `phases`, `gates`, `materials_by_phase` | Construct cards and `mc construct end` gates (`starter_shelter` fixture). |
| `door_gap.face` | Optional perimeter face for `door_traversable` end gate: `min_z` \| `max_z` \| `min_x` \| `max_x`. Default: face with the most wall-height gaps. |
| `materials_planned` | Aggregate counts (GrabCraft import or RCON capture). |
| `history[]` | Steward/adopt/capture audit trail. |
| Per-cell `block_state` | Full predicate string for paste/import (RCON capture, future verify). |
| Per-cell `sign_text` | Captured sign lines; RCON paste applies front line 1 via `data modify` unless overridden. |
| Per-cell `block_entity_data` | Debug/audit from capture; not replayed on paste. |

**`cells_index` is never stored on disk** — loaders build it in memory.

**Footprint `mode` values:**

| `mode` | Typical source |
|--------|----------------|
| `tight` | Derived from `cells[]` or explicit genesis/construct fixture. |
| `metadata` | GrabCraft width/height/depth box from `blueprint-plan.py`. |
| `capture_bounds` | RCON capture box (`capture-schematic-rcon.py`). |

**Footprint rule:** inside `footprint.local`, any coordinate not present in `cells[]` is expected **air**. Outside the footprint, verify is silent (staging chests, crafting tables, etc.).

Reference fixtures: [`starter_shelter-plan.json`](../../data/ops/plans/starter_shelter-plan.json) (construct MVP), [`re44-house-plan.json`](../../data/ops/plans/re44-house-plan.json) (RCON capture sample).

Import from GrabCraft:

```bash
python3 scripts/blueprint-plan.py "<url>" \
  --out data/ops/plans/dystopian-hut-3-plan.json \
  --plan-id dystopian-hut-3 \
  --anchor 370,65,-608 --site :hut3:/anchor
```

Offline inspection:

```bash
python3 scripts/blueprint-tool.py show dystopian-hut-3
python3 scripts/blueprint-tool.py audit
```

### RCON schematic capture and paste (ops / tests)

For hand-built structures or construct canary fixtures without GrabCraft, use read-only RCON capture and paste scripts (same `server.local.yaml` / mapcatalog client as genesis). They read and write the same **blueprint plan** JSON under `data/ops/plans/` (not a separate file format).

**Capture** a bounded volume into a plan:

```bash
python3 scripts/capture-schematic-rcon.py my-shelter \
  --corners 380,86,-612 385,90,-607 \
  --expand-xz 1 \
  --origin-marker 386,87,-607 \
  --world minecraft:overworld \
  --force
```

**Paste** a plan at coordinates or centered on a player (chunks must be loaded at the destination):

```bash
python3 scripts/place-schematic-rcon.py my-shelter --at 409,79,-596 --anchor-mode min_corner
python3 scripts/place-schematic-rcon.py re44-house --at-player re44
python3 scripts/place-schematic-rcon.py re44-house --at-player re44 --sign-front "Canary A"
python3 scripts/place-schematic-rcon.py re44-house --at 409,79,-596 --dry-run
```

| Script | Role |
|--------|------|
| [`scripts/capture-schematic-rcon.py`](../../scripts/capture-schematic-rcon.py) | Scan bounds → `cells[]`, optional `sign_text` / block states |
| [`scripts/place-schematic-rcon.py`](../../scripts/place-schematic-rcon.py) | `setblock` paste; `--sign-front` or plan `sign_text` on signs |

Paste applies **block state** from capture; **chest contents** are not restored. Sign front line 1 is set with `data modify` after paste — from plan `sign_text` by default (`--no-plan-sign-text` to skip) or from `--sign-front`.

Useful for Tier 2 fixture prep, construct canary pad sites, and cloning reference builds before `mc construct` scenarios — see [`docs/guides/test-overview.md`](../guides/test-overview.md) and [`docs/architecture/construct-canary.md`](../architecture/construct-canary.md).

In-game (bot HTTP / `mc` CLI):

```bash
mc blueprint show :hut3:
mc blueprint verify dystopian-hut-3 --level 5
mc blueprint adopt :hut3: --at 370 65 -608 --note "approved change"
```

Target resolution: `:region:` requires `plan=` on the region row; bare `plan_id` loads the file and uses `anchor.coords` (or `--site`).

## Block compare (v1 gaps)

[`bot/lib/runtime/blueprints/compare.js`](../../bot/lib/runtime/blueprints/compare.js) and [`scripts/blueprint_lib.py`](../../scripts/blueprint_lib.py) normalize GrabCraft-style suffixes and Mineflayer `block.name` to a comparable base id (doors, ladders, bed parts). **Block states** (facing, half, waterlogged) are not verified in v1 — mismatches may appear as `wrong` until adopt/construct learn states. Entity/tile contents are out of scope.

## Size limits

Env-overridable caps (shared JS + Python): `BLUEPRINT_MAX_CELLS` (50k), `BLUEPRINT_MAX_FOOTPRINT_VOLUME` (200k), `BLUEPRINT_VERIFY_MAX_CELLS_PER_CALL` (2k), `BLUEPRINT_CAPTURE_MAX_REGION_RADIUS` (64). Verify `--all` truncates with `truncated: true` and `next_hint`.

## Construct, verify, and repair

| Path | When |
|------|------|
| **`mc blueprint verify`** | Read-only audit anytime (`summary: ok/missing/wrong/extra`). No bot construct flag required. |
| **Construct mode** | `HERMES_CONSTRUCT_CONTEXT=1` + CONSTRUCT card (`plan`, `phase`, `worksite`) or `mc construct begin` / `show` / `end`. Workers use scoped **`mc fill` / `place` / `dig`** (not `mc wall`). Responses include `guided_edit_progress` when context is active. |
| **`mc blueprint adopt` / `capture`** | Steward mutations (`HERMES_BLUEPRINT_MUTATORS`); in-bot region capture writes the same plan shape as offline tools. |
| **RCON paste** | `place-schematic-rcon.py` — instant world stamp for tests/fixtures; not a substitute for construct session gates. |

Blueprint-aware **`mc repair`** remains partial / fleet-rare; prefer verify + adopt or construct workset edits.

Rollout checklist: [`docs/architecture/construct-canary.md`](../../architecture/construct-canary.md). Worker skill: [`skills/minecraft-building.md`](../../../skills/minecraft-building.md) § Schematic construct mode. Card emit: [`scripts/construct-plan-cards.py`](../../scripts/construct-plan-cards.py) + [`scripts/lib/plan_supply.py`](../../scripts/lib/plan_supply.py).

**May 2026 fleet note:** `mc construct` is implemented behind `HERMES_CONSTRUCT_CONTEXT`; production workers may still run unscoped motors until G1 rollout. Cheatsheet survey: [`observation-verb-grammar.md`](../mc/observation-verb-grammar.md).

## GrabCraft downloader

Script: [`grabcraft_downloader.py`](./grabcraft_downloader.py) (run from repo root or pass the full path).

Steward-facing **build plan** (substitutions + simplify + kanban-oriented JSON):

[`scripts/blueprint-plan.py`](../../scripts/blueprint-plan.py) — wraps the downloader; see skill [`skills/minecraft-steward-blueprint-plan.md`](../../../skills/minecraft-steward-blueprint-plan.md).

A Python CLI tool that downloads Minecraft blueprints from [grabcraft.com](https://www.grabcraft.com) and converts them into a clean, automation-ready JSON format.

### Usage

```bash
# Pretty-printed JSON (default)
python scripts/grabcraft_downloader.py <url> [output.json]

# Compact single-line JSON
python scripts/grabcraft_downloader.py --compact <url> output.json

# Examples
python scripts/grabcraft_downloader.py "https://www.grabcraft.com/minecraft/dystopian-village-hut-3/other-193" hut.json
python scripts/grabcraft_downloader.py --compact "https://www.grabcraft.com/minecraft/age-of-empires-castle/medieval-castles" castle.json
```

### Output JSON Structure

```json
{
  "metadata": {
    "name": "Dystopian Village Hut 3",
    "author": "matioshka",
    "block_count": 169,
    "views": 2760,
    "width": 4,
    "height": 10,
    "depth": 6,
    "skill_level": 1,
    "tags": ["dystopia", "dystopian village", "hut", "small house", "apocalypse"],
    "description": "...",
    "url": "...",
    "blueprint_image_base": "https://bprints.grabcraft.com/5012/Y/combined/",
    "preview_image": "..."
  },
  "materials": [
    {"name": "Clay", "count": 53},
    {"name": "Stone", "count": 40}
  ],
  "layers": [
    {
      "level": 1,
      "blocks": [
        {"x": 1, "y": 1, "z": 2, "name": "Cobblestone", "mat_id": "18", "hex": "#595959", "rgb": [89,89,89], "texture": "4_0.png", "transparent": false}
      ]
    }
  ],
  "blocks_3d": {
    "1,1,2": {"x": 1, "y": 1, "z": 2, "name": "Cobblestone"}
  },
  "layer_image_map": {
    "1": [{"x": 5, "y": 291, "s": 21, "h": "Cobblestone", "y1": 185, "x2": 91}]
  }
}
```

### How It Works

1. **Fetches the HTML** of the blueprint page with a realistic browser User-Agent
2. **Extracts metadata** from the page's structured parameters (name, author, dimensions, views, tags, description)
3. **Parses materials** from the Highcharts data (most reliable for exact counts)
4. **Discovers** the two companion JS files embedded in the page:
   - `myRenderObject_{id}.js` — contains the full 3D block data (xyz coordinates, material names, colors, textures)
   - `LayerMap_{id}.js` — contains image-overlay coordinates for each block on the blueprint PNGs
5. **Assembles** everything into a single JSON output

### Verified Against Two Blueprints

| Blueprint | Blocks | Layers | Materials |
|-----------|--------|--------|-----------|
| Dystopian Village Hut 3 | 169 | 10 | 9 |
| Age of Empires Castle | 12,405 | 40 | 10 |

The `blocks_3d` flat dictionary is especially useful for automation — you can look up any coordinate directly with `"x,y,z"` keys.

### Other Interesting Blueprints

- https://www.grabcraft.com/minecraft/restaurant-in-the-woods/restaurants
- https://www.grabcraft.com/minecraft/medieval-colonial-inn/restaurants
- https://www.grabcraft.com/minecraft/medieval-kingdom-saxon-hall/medieval-houses

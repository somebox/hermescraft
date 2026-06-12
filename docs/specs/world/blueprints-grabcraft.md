# Blueprints (Grabcraft)

Committed plans under `data/ops/plans/<plan_id>-plan.json` are the **single source of truth** for what should exist inside a blueprint footprint. Region placemark signs bind with `plan=<plan_id>`. Bots verify against the world; the steward mutates the plan (JSON edit or `mc blueprint adopt`) when in-world changes should become design.

See also: [designated-regions.md](./designated-regions.md) (Phase 2c guided construct/repair), [handler-contract ADR blueprint verify](../../reference/bot/handler-contract-adr.md#blueprint-verify-envelope), skill [`skills/minecraft-blueprints.md`](../../../skills/minecraft-blueprints.md).

## Plan file shape

Each plan includes `plan_id`, `footprint` (`mode: tight|metadata`, `local` axis ranges), `anchor.coords`, `cells[]` with `{ local: [x,y,z], block }`, and optional `history[]`. **`cells_index` is never stored on disk** — loaders build it in memory.

**Footprint rule:** inside `footprint.local`, any coordinate not present in `cells[]` is expected **air**. Outside the footprint, verify is silent (staging chests, crafting tables, etc.).

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

## Construct and repair

`mc construct` and blueprint-aware `mc repair` depend on designated-regions **Phase 2c** (guided edit, worksite grants). Current builds use `mc blueprint layer`, existing `mc fill` / `mc wall` / `mc place`, and phase-scoped `mc blueprint verify`. Stubs return `NOT_IMPLEMENTED` until Phase 2c lands.

**May 2026:** Both verbs appear in the generated cheatsheet (`building` category) but had **zero** 7-day fleet calls — agents are not routed to them yet. When 2c ships, teach via genesis mason cards and re-run `scripts/mc-call-survey.py`; consider grouping placement + construct under a `mc build` help namespace ([`observation-verb-grammar.md`](../mc/observation-verb-grammar.md) simplification list).

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

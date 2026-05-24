# Blueprints

## GrabCraft downloader

Script: [`grabcraft_downloader.py`](./grabcraft_downloader.py) (run from repo root or pass the full path).

Steward-facing **build plan** (substitutions + simplify + kanban-oriented JSON):

[`scripts/blueprint-plan.py`](../../scripts/blueprint-plan.py) — wraps the downloader; see skill [`skills/minecraft-steward-blueprint-plan.md`](../../skills/minecraft-steward-blueprint-plan.md).

A Python CLI tool that downloads Minecraft blueprints from [grabcraft.com](https://www.grabcraft.com) and converts them into a clean, automation-ready JSON format.

### Usage

```bash
# Pretty-printed JSON (default)
python docs/features/grabcraft_downloader.py <url> [output.json]

# Compact single-line JSON
python docs/features/grabcraft_downloader.py --compact <url> output.json

# Examples
python docs/features/grabcraft_downloader.py "https://www.grabcraft.com/minecraft/dystopian-village-hut-3/other-193" hut.json
python docs/features/grabcraft_downloader.py --compact "https://www.grabcraft.com/minecraft/age-of-empires-castle/medieval-castles" castle.json
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
    {"name": "Stone", "count": 40},
    ...
  ],
  "layers": [
    {
      "level": 1,
      "blocks": [
        {"x": 1, "y": 1, "z": 2, "name": "Cobblestone", "mat_id": "18", "hex": "#595959", "rgb": [89,89,89], "texture": "4_0.png", "transparent": false},
        ...
      ]
    }
  ],
  "blocks_3d": {
    "1,1,2": {"x": 1, "y": 1, "z": 2, "name": "Cobblestone", ...},
    ...
  },
  "layer_image_map": {
    "1": [{"x": 5, "y": 291, "s": 21, "h": "Cobblestone", "y1": 185, "x2": 91}, ...]
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

## Future command: `mc construct` (design sketch)

`mc construct` can reuse most of the future `mc repair` pipeline, but the
target state comes from a blueprint JSON instead of a region snapshot.

Proposed execution shape:

1. **Plan**: pick anchor/orientation, transform blueprint local coords to world coords,
   diff expected blocks vs observed blocks.
2. **Gather**: compute missing materials from diff and fetch/craft as needed.
3. **Place**: place only missing/incorrect blocks, in a stable order
   (support/foundation first, then walls/roof/details).
4. **Verify**: re-scan planned cells and emit unresolved mismatches.

### Shared contract with `mc repair`

Both commands should use the same action envelope and telemetry fields:

- `plan_summary`: total cells, already-correct cells, cells to place/replace
- `materials_needed` and `materials_missing`
- `blocked_cells` (unreachable/occupied by protected blocks/entities)
- `verify_summary` with a short mismatch sample

This keeps agent reasoning consistent: only the **source of truth** differs.

### Inputs needed for v1

- `--blueprint <path-or-id>`
- `--anchor x,y,z` **or** `--site :region:/<name>` (resolves a
  named site declared on a placemark sign; see
  [`designated-regions.md`](./designated-regions.md))
- `--rotation 0|90|180|270` (optional)
- `--mirror x|z|none` (optional, can be deferred)
- `--dry-run` (plan + materials + diff only — same as
  `mc check construct …`)

### Region interaction (important)

`mc construct` should be treated as a **guided edit** action:

- regions may deny ad-hoc `mc place` but still allow `mc construct`
- protected areas can permit construction only at known sites
  (example: `tower`, `mine_entrance`)
- refusal should return an explicit policy reason, not generic placement failure

This keeps designated-region safety strict while still enabling intentional builds.

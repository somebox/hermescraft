# proc_biome_scan (P1.5)

Offline biome disc histogram for mapcatalog Pass 1 (`mapcatalog/pass1.py`).

## Build

```bash
git clone --depth 1 https://github.com/Cubitect/cubiomes.git cubiomes
make -C tools/cubiome_scan
```

Produces `tools/cubiome_scan/proc_biome_scan`.

## Usage

```bash
./proc_biome_scan --seed 424242 --center 0,0 --radius 64 --step 16 --mc MC_1_21
```

JSON stdout: `cells[]` with `{x, z, y, biome}` (biome at 3D column using cubiomes
`mapApproxHeight` + `getBiomeAt`), plus `cell_count`.

## Calibration

```bash
python -m mapcatalog calibrate -s server.local.yaml
```

Reads `calibration/seeds.yaml`. Loosen/tighten anchors after cross-checking a live
server (`try --pass1-only` vs Pass 2 heightmap biomes).

## Notes

- Vendored `cubiomes/` is not committed; clone locally before building.
- `MC_1_21` in server config must match Paper worldgen; adjust if cubiomes
  `MC_1_21_WD` drifts from your server patch.

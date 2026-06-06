# Cubiomes vs Paper (1.21.4) — version skew

Status: **operational note** (2026-06). Relates to [procedural-map-catalog.md](procedural-map-catalog.md) Pass 1 / `verify_live`.

---

## What we run

| Layer | Version / enum | Role |
|-------|----------------|------|
| **Paper** (proc-lab) | `minecraft_version: "1.21.4"` in `server.local.yaml` | Ground truth for Pass 2 heightmap, flat patch, `execute if biome` |
| **cubiomes** (vendored) | `cubiomes.mc_enum` e.g. `MC_1_21` | Offline Pass 1 biome histogram |
| **proc_biome_scan** | `--mc MC_1_21` → `setupGenerator(..., MC_1_21, 0)` | Disc cells via `mapApproxHeight` + `getBiomeAt` |

Upstream [Cubitect/cubiomes](https://github.com/Cubitect/cubiomes) (2026-06 master):

```text
MC_1_21_1, MC_1_21_3, MC_1_21_WD
MC_1_21 = MC_1_21_WD   // alias — not “Java 1.21.0” literally
MC_NEWEST = MC_1_21
```

There is **no `MC_1_21_4`** symbol. Paper **1.21.4** is not a 1:1 cubiomes target; closest knobs are `MC_1_21_3`, `MC_1_21_1`, or `MC_1_21` / `MC_1_21_WD`.

---

## Observed failure mode (seed 800)

Bench report (2026-06-01):

- **cubiomes** (arena center `[0,0]`, radius 48, step 16): **29/29 `plains`** for `MC_1_21`, `MC_1_21_1`, `MC_1_21_3`, and `MC_1_21_WD` — enums agree with each other.
- **Paper 1.21.4**: `locate biome minecraft:plains` from origin reports nearest plains **~340 blocks away**; spawn placement still lands at a standable column `(30, 93, 0)` and agent tests pass.
- **`verify_live`** (sparse live `if biome` at **surface Y** in the arena disc): correctly rejects “cubiomes said ≥55% plains” when live fraction is below the gate.

So this is **not** fixed by `--enum-sweep` alone on seed 800: all shipped enums predict plains at the sampled disc.

`locate biome` and Pass 2 **`execute if biome`** at surface block Y are different probes; trust **`verify_live` / Pass 2** for acceptance, not locate output alone.

---

## Mitigations (pick by job)

| Goal | Approach |
|------|----------|
| **Smoke refresh / find** | Smoke yaml has **no biome gates**; Pass 2 does not duplicate Pass 1 biome checks (see `evaluate_gates`). |
| **Biome-heavy topics** (mining.plains_iron, …) | Keep server `verify_live: true`; treat cubiomes as a **cheap prefilter** only. |
| **Known-good seeds** (800, 2024, 271828) | `TRY_SEED=…` / `agent-test-from-map.py --try-seed` until catalog pools fill. |
| **Long-term** | Rebuild `proc_biome_scan` after cubiomes releases generator parity for your Paper patch; add calibration rows that compare **live** sparse fraction vs cubiomes per seed. |

---

## Commands to reproduce offline

```bash
# Enum comparison (offline)
python -m mapcatalog calibrate --enum-sweep -s server.local.yaml

# Single seed histogram
./tools/cubiome_scan/proc_biome_scan --seed 800 --center 0,0 --radius 48 --step 16 --mc MC_1_21

# Cubiomes-only (no materialize)
python -m mapcatalog try -r requirements/scenario_homestead_smoke.yaml -s server.local.yaml --seed 800 --pass1-only

# Full live path (includes verify_live unless job overrides)
python -m mapcatalog try -r requirements/scenario_homestead_smoke.yaml -s server.local.yaml --seed 800 --json-full
```

After changing `cubiomes.mc_enum`, rebuild: `make -C tools/cubiome_scan` (clone [cubiomes](https://github.com/Cubitect/cubiomes) into `tools/cubiome_scan/cubiomes` first).

---

## Related cards / follow-ups

- Revisit **verify_live sample region** (arena center vs resolved `spawn` anchor) if false rejects persist for visually good seeds.
- Add calibration anchors for seeds **800**, **2024**, **271828** with **live** fraction recorded from a one-off bench run (not cubiomes-only).

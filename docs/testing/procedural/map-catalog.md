# Procedural Map Catalog

Status: **P3 in repo** (2026-06-01) — `find` loop + `lint_actual`; default **`pass1.verify_live`** when cubiomes is configured; calibrate `--enum-sweep`. **Scenario apply/prep/teardown:** planned — see [scenario-runs.md](scenario-runs.md).

A **standalone seed finder**: you describe terrain requirements in YAML; it returns **world seeds and in-world placements** (where to spawn and operate) that satisfy those requirements. It can also save accepted results as a **catalog** for reuse.

Hermescraft integration: [testing-model.md](testing-model.md) (topics + maps); [scenario-runs.md](scenario-runs.md) (teardown / CLI roadmap).

---

## Black box

```text
  requirements.yaml          server.local.yaml (rcon + world slot)
         │                            │
         └──────────┬─────────────────┘
                    ▼
            ┌───────────────┐
            │  mapcatalog   │  Pass 1: cubiomes (offline)
            │  (CLI/lib)    │  Pass 2: materialize + live probes (rcon)
            └───────┬───────┘
                    ▼
              Result(s)
         seed + spawn + arena + metrics
                    │
                    ▼ optional
              catalog/*.json (persisted Results)
```

**Input:** one **requirements** job file + **server** connection config.

**Output:** one or more **Results** — at minimum:

| Field | Meaning |
|-------|---------|
| `seed` | Java world seed (string, decimal) |
| `spawn` | Block coords `[x, y, z]` — safe standing position (feet) |
| `muster` | Block coords `[x, y, z]` — return / checkpoint (near spawn, not identical) |
| `arena` | `{center: [x, z], radius}` — where requirements were evaluated |

Optional: `prep_commands` (rcon lines expanded from harness `prep:` lines), `metrics` (what was measured), `score` (rank among accepts).

**Non-goals:** custom worldgen datapacks, agent models, kanban, or modifying the main Hermescraft repo as part of the core loop.

---

## Glossary

| Term | What it is | Analogy |
|------|------------|---------|
| **Requirements** | A YAML job file listing hard gates: biomes, flatness, ores, water, etc. | Job spec / filter |
| **Result** | One accepted answer: seed + spawn + arena + metrics. The CLI's output. | Query result row |
| **Catalog** | Directory of saved Results (with audit fields) for one requirements id. | Result set you can sample later |
| **Arena** | Disc around `center` with `radius`; all grids sample inside this disc. | Evaluation region |
| **Site** | One arena + placements on a seed; multiple sites can share one seed at different centers (see [scenario runs](scenario-runs.md)). | Bookmark region on a world |
| **Pass 1** | Offline cubiomes: biome histogram, reject bad seeds cheaply. | Cheap filter |
| **Pass 2** | Create world on server, probe real blocks, apply gates, pick spawn. | Expensive truth |
| **Realism requirements** | No terrain-altering prep; seed must pass alone. | Pure vanilla |
| **Harness requirements** | Same gates + optional `prep` block (items, ore patch, entities). | Vanilla + guaranteed affordances |
| **Placement** | A named in-world `[x, y, z]` that the result exposes (spawn, muster, ore_view, …). Each one is computed after Pass 2 probe by an explicit method (random_safe, offset_from, near, …). | Bookmark inside the seed |

**Requirements vs result:** requirements describe the question ("find plains-heavy seeds with iron nearby"); a result is one answer for a specific seed. Many results share one requirements id.

`--json` emits a **summary result** by default (seed, spawn, muster, arena, score, metrics_summary). `--json full` adds audit fields (`pass1`, `pass2`, `fingerprint`, `probed_at`) — what's persisted in the catalog. There is one schema, not two.

---

## Configuration

One **job file** describes what to find. A small **server pointer** describes how to reach Minecraft. Both are YAML.

### Job file

File name = id, e.g. `requirements/mine_plains_iron.yaml`. Gates are one-line strings; the lint parses them at load.

```yaml
# requirements/mine_plains_iron.yaml
id: mine_plains_iron
extends: profiles/plains_mining       # optional

arena: { center: [0, 0], radius: 64 }

gates:
  - biome in [plains, forest] >= 75%
  - biomes distinct <= 2
  - flat patch >= 16 cells
  - neighbor height delta <= 2 blocks
  - surface water <= 5%
  - surface grass >= 25%
  - block iron_ore hits >= 3 in y -32..48 step 8
  - block cave_air hits 20..400 in y -32..48 step 8

placements:
  spawn:     random_safe radius 1 attempts 32
  muster:    offset_from spawn [6, 0, 0]
  iron_view: random_safe near block iron_ore within 8 blocks attempts 32

find: 5 solutions max 200 seeds

server: ./server.local.yaml           # optional pointer

# Harness-only block (omit for realism):
# prep:
#   - give stone_pickaxe at muster
#   - scatter iron_ore 8 if iron_ore hits < 3 y 32..48
```

**Realism vs harness** = two ids: `mine_plains_iron` (no `prep:`) and `mine_plains_iron_harness` (same gates + a `prep:` block). Catalog results never mix the two.

### Gate grammar (v1)

Every gate is one line. Reading order is human (`subject` + `predicate` + `unit`); the parser maps each form to one internal metric.

| Form | Subject | Predicate | Pass |
|------|---------|-----------|------|
| `biome in [<ids>] >= N%` | biome fraction inside `allow` set (at **heightmap** Y per cell) | `>=` | 1 |
| `biomes distinct <= N` | unique biome count | `<=` | 1 |
| `flat patch >= N cells` | largest connected flat-component | `>=` | 2 |
| `neighbor height delta <= N blocks` | mean surface ΔY between neighbours | `<=` | 2 |
| `surface <block> <= N%` / `>= N%` | surface block histogram (`water`, `grass`, `stone`, …) | `<=` / `>=` | 2 |
| `block <id> hits >= N in y A..B step S` | ore/sample hits in Y band | `>=` | 2 |
| `block <id> hits A..B in y A..B step S` | hit-count range | `range` | 2 |

Units are **suffix-only**: `%`, `cells`, `blocks`, `biomes`, `hits`. JSON fractions are 0–1; YAML uses `%` (parser converts `75%` → `0.75`).

Authors may also write the structured form `{ gate: biome_fraction, allow: [...], min: "75%" }` if a one-liner gets unwieldy; both forms normalize to the same internal struct at load time.

### Placements (where the bot lands and works)

A `placements:` block names one or more in-world `[x, y, z]` points the result will expose. Every placement runs **after Pass 2 probe** so it can read real heightmap, biomes, and block samples. The keys `spawn` and `muster` are special-cased (always emitted at the top level of the result for consumers that only need an entry point); arbitrary additional names are passed through.

```yaml
placements:
  spawn:     random_safe radius 1 attempts 32
  muster:    offset_from spawn [6, 0, 0]
  iron_view: random_safe near block iron_ore within 8 blocks
  wood_lot:  random_safe in_biome forest near gate flat_patch within 6 cells
```

Backward-compatible shortcut: top-level `spawn:` / `muster:` lines lift into `placements.spawn` / `placements.muster` if no `placements:` block is present.

**Placement methods** (parsed at lint time, executed in Pass 2):

| Method | Behaviour |
|--------|-----------|
| `random_safe radius R attempts N` | Sample N random cells inside the arena disc. For each candidate, get surface Y from the heightmap; require foot Y solid-standable (not water/lava/leaf/fence), head Y+1 air, head+1 air. With `radius R`, all 4 cardinal neighbours at the same Y must also be standable. First hit wins. |
| `flat_patch_center` | Centroid (block coords) of the largest connected flat-patch found by the `flat patch` gate. Falls back to `random_safe` if no flat-patch gate is declared. |
| `offset_from <name> [dx, dy, dz]` | Resolved after `<name>` resolves; copies coords + offset. Result is verified `random_safe`-style unless the placement adds `safe: false`. |
| `near <gate-name> within N (cells\|blocks)` | Modifier — applied to `random_safe`. Filters candidates to those within distance N of any cell satisfying the named gate (e.g. `iron_ore`, `flat_patch`). If exhausted, the seed is rejected with `reasons: ["placement <name> unreachable"]`. |
| `in_biome <biome>` | Modifier — restricts candidates to cells whose biome cell tag matches. |
| `los_to <name>` (P5) | Modifier — verify clear line-of-sight to another placement; deferred until raycasting lands. |

**Resolution order:**

1. Topological sort: placements that reference others via `offset_from` / `near <name>` resolve after their parent.
2. Each placement runs its method; modifiers chain (`random_safe` + `near` + `in_biome` apply as a filter on the sample set).
3. If any required placement fails after `attempts`, the seed is rejected (the seed does **not** silently succeed with missing placements).

**Determinism:** placements are seeded by `hash(seed + "placement:" + name)` so two `try --seed N` runs on the same seed produce identical placements.

### Server pointer (`server.local.yaml`)

Kept out of the job file so secrets and host-specific knobs don't get committed. Default lookup: `./server.local.yaml`; override with `--server path`.

```yaml
# server.local.yaml
minecraft_version: "1.21.4"

rcon:
  transport: ssh_docker        # ssh_docker | local_docker | tcp (future)
  ssh_host: ubuntu-host
  container: minecraft

world:
  name: proc-lab               # must match proc-* safety rule
  generator: NORMAL
  evac:
    hub_world: landfolk-test
    hub_xyz: [0, 65, 0]
    use_unsafe_mvtp: true

cubiomes:
  binary: tools/cubiome_scan/proc_biome_scan
  mc_enum: MC_1_21             # set by calibration from minecraft_version
```

A job file may omit `minecraft_version` — it inherits from the server. Set it on the job only to override (e.g. probing an older pack).

---

## Presets

Ship 3–5 reusable profiles under `profiles/`, data-only:

| Profile | What it locks in | Typical use |
|---------|------------------|-------------|
| `profiles/plains_mining.yaml` | plains/forest biome envelope + iron gate | mine smoke tests |
| `profiles/flat_farm.yaml` | flat patch + grass + low water, permissive biome | farming arenas |
| `profiles/forest_wood.yaml` | forest biome + log surface proxy | wood-supply tests |
| `profiles/scout_diverse.yaml` | 3+ biomes, no flatness gate | scouting / nav stress |
| `profiles/cave_mining.yaml` | cave_air band + ore (slow; cubiomes can't prefilter) | mining-discipline tests |

User file becomes the diff:

```yaml
id: my_smoke
extends: profiles/plains_mining
arena: { radius: 64 }
find: 3 solutions
```

`extends` deep-merges; later keys win. Lint runs on the resolved file. Harness preset = same id + `_harness` (with a `prep:` block).

---

## Public CLI

Three verbs cover the MVP. Shared flags: `-r <requirements>`, `-s <server>` (defaults to `./server.local.yaml`), `--json [summary|full]`. Exit 0 on success.

```bash
# Explain gates and estimate cost (no server, no rcon)
mapcatalog lint -r requirements/mine_plains_iron.yaml

# One seed end-to-end → result or reject reasons
mapcatalog try  -r ... [-s server.local.yaml] [--seed 424242] [--pass1-only] --json

# Loop until target solutions → write catalog
mapcatalog find -r ... -s ... -o catalog/mine_plains_iron/ \
  [--solutions 5] [--max-seeds 200] [--json-lines] [--json]
```

Notes:

- **`find.solutions`** (or `--solutions`) is how many **accepts** to collect; **`find.max_seeds`** / **`--max-seeds`** caps **how many seeds to try**. The loop stops when either limit is hit. Smoke: `--solutions 1 --max-seeds 20`.
- **Progress:** one line per seed on **stderr** (`try N/M`, accepts, stage, timings). Rolling **`catalog/<id>/.find_state.json`** updates after each seed (for handover / tail while a long run is in flight).
- **`--json-lines`:** stdout gets one JSON object per seed, then a final `type: summary` line; stderr still has progress unless `--quiet`.
- `try --pass1-only` replaces the prior `filter-seed` command (cubiomes only, no rcon).
- `try --seed N` reproduces a specific seed; without `--seed`, it draws one from the requirements' random source.
- Picking a saved result from a catalog is a stdlib operation: `mapcatalog find -o <dir> --pick random` reads from disk without rebuilding (or a 3-line wrapper script if `find` feels overloaded).
- All commands accept `--json full` to emit audit fields (`pass1`, `pass2`, `fingerprint`, `probed_at`).

### Result JSON

One schema, two detail levels. **Summary** (default `--json`):

```json
{
  "ok": true,
  "requirements_id": "mine_plains_iron",
  "seed": "424242",
  "minecraft_version": "1.21.4",
  "arena": { "center": [0, 0], "radius": 64 },
  "spawn": [12, 66, -8],
  "muster": [18, 66, -8],
  "placements": {
    "spawn":     [12, 66, -8],
    "muster":    [18, 66, -8],
    "iron_view": [14, 65, -10]
  },
  "score": 0.82,
  "metrics_summary": {
    "biomes": { "plains": 0.68 },
    "iron_ore_hits": 4,
    "flat_patch_cells": 16
  }
}
```

Top-level `spawn` and `muster` are convenience copies of `placements.spawn` / `placements.muster` for callers that only need an entry point; extra placements (`iron_view`, `wood_lot`, …) are read from the `placements` map.

**Full** (`--json full`, also the on-disk catalog form) adds:

```json
{
  "id": "mine_plains_iron__424242",
  "world_name": "proc-lab",
  "metrics": { /* every per-metric value the probe captured */ },
  "prep_commands": [ "execute in proc-lab run setblock 18 66 -8 minecraft:chest{...}" ],
  "cleanup_commands": [ "execute in proc-lab run fill -32 40 -32 32 80 32 minecraft:air" ],
  "audit": {
    "pass1": { "rejected": false, "cubiomes_version": "..." },
    "pass2": { "materialized_world": "proc-lab", "probe_duration_s": 6.4 },
    "fingerprint": { "sha256": "..." },
    "probed_at": "2026-05-31T00:00:00Z"
  }
}
```

Consumers needing only **seed + spawn** read the top-level coords. `muster` defaults to `spawn` offset by `[6, 0, 0]` unless the job file sets `muster: <expr>` (e.g. `muster: auto offset [0,0,8]`).

Rejected seeds emit `{"ok": false, "seed": "...", "stage": "pass1|pass2", "reasons": [...]}` instead.

---

## Pipeline (internal)

Cost is dominated by **Pass 2 materialize** (~tens of seconds per seed at small arena). Pass 1 cubiomes is sub-millisecond per seed.

```text
Pass 1 (cubiomes)     → reject | continue
Pass 2 materialize    → MV create + load probe chunks only
Pass 2 probe          → scoreboard rcon (no chat/say parsing)
Pass 2 gate           → hard fail | accept + score
Pass 2 placements     → resolve spawn, muster, and named extras (random_safe / near / offset_from)
                        reject seed if any required placement is unreachable
Pass 2 prep           → harness requirements only
→ Result (+ optional catalog entry on disk)
```

| Gate family / step | Pass 1 | Pass 2 |
|--------------------|--------|--------|
| `biome …`, `biomes distinct …` | cubiomes histogram (+ optional `verify_live` after materialize) | **not re-evaluated** (Pass 2 runs `pass_num==2` gates only) |
| `flat patch …`, `neighbor height delta …`, `surface <block> …` | — | height grid + block histogram |
| `block <id> hits …` | — | underground sample grid |
| `placements:` (spawn, muster, extras) | — | resolve after gates pass; reject on any unreachable required placement |
| `prep:` lines | — | inject after accept |

**Partial probe failure** → reject seed; do not gate on incomplete metrics.

### World lifecycle (Pass 2)

Each `try` / `find` candidate runs the same scratch-world cycle on `world.name` (must be `proc-*`):

1. **Evac** — `execute in <scratch> as @a run mvtp @s <hub> <x> <y> <z>` so no player blocks delete/create.
2. **Recreate** — `mv unload` → `mv delete` → parse `mv confirm <OTP>` from stdout → `mv confirm <OTP>` → `mv create <name> <generator> -s <seed>` → **`mv load <name>`** (MV on Paper 1.21 does not auto-load).
3. **Preflight** — one `execute in <scratch> if block …` probe; reject loudly on `Unknown dimension` or empty stdout (unloaded worlds otherwise produce fake flat metrics).
4. **Preload** — `forceload` chunks covering the arena disc; touch columns so underground/surface generate.
5. **Probe** — batched `execute if block` / `if biome` at each column's **surface block Y** (not a fixed Y=64; cave biomes wrap underground on 1.21+).
6. **Leave** — scratch world remains loaded with the last candidate until the next evac; hub is not modified.

`server.local.yaml` `evac.hub_world` / `hub_xyz` must match a safe Multiverse destination (e.g. `landfolk-test`).

**Structures** (villages, strongholds): P5 extension on Pass 1 only; not in MVP requirements schema.

---

## Core rules

1. **Hard gates** → accept or reject. **Score** sorts accepted results only; it never overrides a hard fail.
2. **Vanilla terrain is selected.** Harness `prep` adds items/ores/entities; it does not replace gates unless a `prep` line says `if <gate> < <threshold>` (e.g. `scatter iron_ore 8 if iron_ore hits < 3`).
3. Sample only **cells inside the arena disc**. `lint` prints `sampled_cell_count` per metric so thresholds are interpreted against the actual denominator.
4. **`seed`** is always a **string** (decimal Java long; avoids JSON float loss).
5. **Units** are suffix-only in YAML: `%`, `cells`, `blocks`, `biomes`, `hits`. JSON normalizes fractions to 0–1.
6. **Placements** are deterministic for a given `(seed, requirements_id, placement_name)` — same seed reproduces the same coords. A seed that passes all gates but has any **required** placement unreachable is rejected (not silently shipped with missing fields).
7. Fingerprints use **canonical JSON** of `{ requirements_id, seed, minecraft_version, arena, placements, prep_commands }` then SHA-256. Fields like `metrics`, `audit`, and `cubiomes.version` are deliberately excluded so re-probes produce identical fingerprints. The full `placements` map (not just spawn/muster) is included so re-resolving a seed against a placement-shape change yields a different fingerprint.

---

## Pass 1: cubiomes

Thin CLI `proc_biome_scan` + Python wrapper. `biome in [...]` and `biomes distinct` gates run here first.

Calibration file (committed): `calibration/seeds.yaml` — ~20 seeds, expected histograms, tolerance ±1 grid cell. Results' `audit.pass1.cubiomes_version` records which calibration ran.

If cubiomes is missing, Pass 1 is skipped (lint warns). `try --pass1-only` requires the binary.

**Biome sampling:** cubiomes uses `mapApproxHeight` + `getBiomeAt` at that Y (3D column). Pass 2 uses live heightmap + `execute if biome` at surface block Y — expect drift; tune `mc_enum` (`calibrate --enum-sweep`) and/or **`pass1.verify_live`**. Deep dive: [cubiomes-paper-skew.md](../../specs/world/cubiomes-paper-skew.md).

### Pass 1 verify-live (default when cubiomes is configured)

After cubiomes accept and **materialize**, sample N disc cells with the same live biome logic as Pass 2 (heightmap Y + `if biome`). Rejects cubiomes false-positives before the full probe grid (~54s saved). Costs ~35s materialize + sparse rcon per candidate.

**Default:** if `server.local.yaml` has a working `cubiomes.binary`, `verify_live` is **on** unless the job or server sets `pass1.verify_live: false` or `verify_live_when: off`. Per-job override (e.g. smoke flat-only) is preferred over turning verify off globally.

Job or `server.local.yaml`:

```yaml
pass1:
  verify_live: true
  verify_live_samples: 10
  verify_live_when: always    # always | borderline (near-threshold only)
  verify_live_margin: 0.15
```

`borderline` runs verify only when cubiomes fraction ∈ `[min, min + margin]`. When cubiomes **systematically** over-reports biomes vs Paper 1.21.4, enum sweep may not help; use job-level `verify_live: false` for flat-only smoke or keep `TRY_SEED` for agent loops — see [cubiomes-paper-skew.md](../../specs/world/cubiomes-paper-skew.md).

---

## Pass 2: live probes

Library `probe.py`: batched scoreboard checks, `MAX_CMDS_PER_BATCH` (~100, tuned per server).

Surface heightmap scans use `y_hi=319` (1.21+ max block Y). Rcon lines containing `out of this world` are treated as **keep scanning**, not solid ground — avoids pinning every column to `y+1` when a probe starts one block too high.

Optional **refine_on_hit** (P2.1): coarse ore grid → dense 32×32 neighborhood when any hit.

Future: `cave_reachable_from_surface` for cave-specific requirements (not MVP).

---

## Storage

```text
requirements/*.yaml                # human-edited job files
profiles/*.yaml                    # shipped presets (extend from these)
data/scenarios/registry.yaml       # scenario variant → requirements → catalog dir
server.local.yaml.example          # committed template
server.local.yaml                  # local rcon/host (gitignored)
catalog/<variant_id>/*.json        # local seed pools from find (gitignored)
catalog/rejects/<id>/*.json        # failed candidates (gitignored)
calibration/seeds.yaml             # cubiomes-vs-server check list
mapcatalog/                        # Python package
tools/cubiome_scan/                # C binary + Makefile
```

**Bboxes on results** (optional fields, for downstream test harnesses):

- `work_bbox` — expected agent edit region around spawn/muster.
- `cleanup_bbox` — superset to reset between runs.

Derived automatically from `arena` + `spawn` unless the job file overrides them. Bboxes are only emitted in `--json full`; summary results omit them.

---

## Phasing

| Phase | Deliverable | Proves |
|-------|-------------|--------|
| P0 | This doc | Shared vocabulary |
| P1 | `probe.py` + fake rcon tests + `lint` (gate + placement parsers, topological-order check, cell-count sanity) | **Done** — `mapcatalog/` package |
| P1.5 | cubiomes CLI + calibration | **Done** — `proc_biome_scan`, `pass1`, `mapcatalog calibrate` |
| P2 | `try` end-to-end (cubiomes + rcon + placement resolution: `random_safe`, `offset_from`, `near`, `in_biome`) | **Done** — needs live smoke on ubuntu-host |
| P2.1 | `refine_on_hit` | Ore gates without global fine grid |
| P3 | `find` + catalog + fingerprint golden test | **Done** — `find` writes catalog + `lint_actual`; operability flags (`--solutions`, progress, `.find_state.json`) |
| P3.5 | [Scenario CLI](scenario-runs.md) (`pick`, `apply`, `prep`, `cleanup`, `reset`) | Fast test loops from catalog cards without re-`find` |
| P4 | harness `prep` mini-DSL expansion | Guaranteed tools/ore patch; feeds **`scenario prep`** |
| P5 | structure gates + biome heatmap PNG | Richer requirements |
| P6 | datapacks | Only if select+prep insufficient |

Success (black box):

1. `mapcatalog find` yields ≥5 distinct seeds for `mine_plains_iron` on one server config.
2. `try --seed N` on a pinned seed reproduces metrics within documented tolerance.
3. `lint` prints estimated materializations and gate-by-gate selectivity before a long `find`.

Success (Hermescraft scenarios — [scenario-runs.md](scenario-runs.md)):

4. **`scenario apply`** from a catalog card materializes **`proc-run-*`** in ~1 min without re-search.
5. Soft **`scenario cleanup`** between attempts; hard reset restores same seed terrain.
6. Agent-test **`procedural_env`** resolves a random card and tp/prep bots (S4).

Open items: [scenario runs § Open work](scenario-runs.md#open-work).

---

## POC lessons (implementation only)

- Rcon: scoreboard batches, not `say` / chat parse.
- Player counts: entity `Dimension` NBT, not `execute in world as @a`.
- Cross-world move: Multiverse `mvtp`, not `execute in hub run tp`.
- One scratch world; delete + create per candidate seed.

---

## Appendix A — Hermescraft integration

Full workflow (world naming, reset tiers, arena sizing, CLI plan): **[scenario-runs.md](scenario-runs.md)**.

Summary:

- **Catalog pool offline; pick + apply per run** — do not run `find` inside each agent test.
- **Worlds:** genesis **`world`** and hub **`landfolk-test`** unchanged; procedural work only on **`proc-*`** ([naming table](scenario-runs.md#world-namespaces)).
- **Agent tests:** `procedural_env` block resolves a Result → sets `world`, merges `prep_commands` into `spec.prep`, tp bot to `spawn` / expect `muster`. Extra placements via `from_card.placements.<name>`. **Not implemented** in runner yet — see [MC-T9](scenario-runs.md#open-work).
- **Config:** `server.local.yaml`; may copy values from `config/hermescraft.yaml` by hand.

Do not use mapcatalog lifecycle on non-`proc-*` worlds ([`lifecycle.py`](../../mapcatalog/lifecycle.py)).

---

## Appendix B — Implementation types (sketch)

```python
@dataclass
class Result:
    requirements_id: str
    seed: str
    minecraft_version: str
    arena: Arena
    placements: dict[str, Vec3]   # spawn + muster + named extras
    spawn: Vec3                   # alias of placements["spawn"]
    muster: Vec3                  # alias of placements["muster"]
    world_name: str
    score: float
    metrics: dict
    metrics_summary: dict   # subset emitted by --json summary
    prep_commands: list[str]
    cleanup_commands: list[str]
    audit: dict             # pass1, pass2, fingerprint, probed_at

def try_seed(req: Requirements, srv: ServerConfig, seed: str) -> Result | Reject: ...
def find_results(req: Requirements, srv: ServerConfig, out_dir: Path) -> FindReport: ...
```

Internally `Requirements.gates` is a list of parsed `Gate` records (one per YAML line) and `Requirements.placements` is an ordered list of `Placement` records (parser maintains the topological order so `offset_from` / `near <name>` references resolve correctly). The gate-grammar parser normalizes string and structured authoring forms to the same record shape. See § Gate grammar (v1) and § Placements for the form tables.

## Appendix C — Gate grammar reference (v1)

Strings and structured forms are interchangeable. The lint normalizes both to canonical internal records.

| String form | Structured form | Pass |
|-------------|-----------------|------|
| `biome in [plains, forest] >= 75%` | `{gate: biome_fraction, allow: [plains, forest], min: "75%"}` | 1 |
| `biomes distinct <= 2` | `{gate: biome_count, max: 2}` | 1 |
| `flat patch >= 16 cells` | `{gate: flat_patch, min: "16 cells"}` | 2 |
| `neighbor height delta <= 2 blocks` | `{gate: height_jitter, max: "2 blocks"}` | 2 |
| `surface water <= 5%` | `{gate: surface_block, block: water, max: "5%"}` | 2 |
| `block iron_ore hits >= 3 in y -32..48 step 8` | `{gate: ore_hits, block: iron_ore, min: 3, y_range: [-32, 48], step: 8}` | 2 |
| `block cave_air hits 20..400 in y -32..48 step 8` | `{gate: ore_hits, block: cave_air, range: [20, 400], y_range: [-32, 48], step: 8}` | 2 |

Placement, spawn-shortcut, and find lines also accept either form:

```yaml
# Placements block (canonical)
placements:
  spawn:     random_safe radius 1 attempts 32
  muster:    offset_from spawn [6, 0, 0]
  iron_view: random_safe near block iron_ore within 8 blocks

# equivalent structured:
placements:
  spawn:     { method: random_safe, radius: 1, attempts: 32 }
  muster:    { method: offset_from, from: spawn, offset: [6, 0, 0] }
  iron_view: { method: random_safe, near: { gate: ore_hits, block: iron_ore }, within: "8 blocks" }

# Spawn-only shortcut (lifts to placements.spawn):
spawn: random_safe radius 1 attempts 32

find: 5 solutions max 200 seeds
# equivalent:
find: { solutions: 5, max_seeds: 200 }
```

**Placement methods + modifiers:**

| String form | Resolves to |
|-------------|-------------|
| `random_safe radius R attempts N` | sample inside arena, safe-cell check, R-neighbour radius |
| `offset_from <name> [dx, dy, dz]` | derived from another placement after it resolves |
| `flat_patch_center` | centroid of the largest connected flat-patch (requires a `flat patch` gate) |
| `random_safe near gate <gate-name> within N (cells\|blocks)` | filter random_safe candidates by proximity to a named gate's hits |
| `random_safe near block <id> within N blocks` | Modifier — filter candidates by proximity to **sampled** `<id>` cells from Pass 2 ore/block hits. If the block was not probed (no gate) or zero hits in the arena, the placement is **unreachable** (not advisory). |
| `random_safe in_biome <biome>` | filter random_safe candidates by biome-cell tag |

Modifiers chain (`random_safe near … in_biome …`). Resolution order is topological over `offset_from` / `near <name>` references; cycles fail at lint.

Prep lines (harness only) are always string form in v1:

```yaml
prep:
  - give stone_pickaxe at muster
  - summon cow x3 in work_bbox
  - scatter iron_ore 8 if iron_ore hits < 3 y 32..48
```

---

## Related (context only)

- [`scenario-runs.md`](scenario-runs.md) — scenario prep, teardown, **`mapcatalog scenario`** CLI plan, open todos
- [`improvement-pass-closure.md`](../playbooks/improvement-pass-closure.md) — why realistic terrain matters for Hermescraft experiments
- [`test-agent-llm-runbook.md`](../../guides/test-agent-llm-runbook.md) — optional consumer of saved Results
- [`genesis-boot-cards.md`](../../specs/kanban/genesis-boot-cards.md) — campaign boot; not used for per-scenario map randomization

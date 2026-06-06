# Procedural testing — convergence model

Status: **target architecture** (2026-06). Replaces the “3 settings × 10 variants” sprawl with a small **topic** list, several **terrain profiles** per topic, and many **maps** (seed files) per profile. Implementation: [`data/scenarios/registry.yaml`](../../data/scenarios/registry.yaml) v2.

Related: [map-catalog.md](map-catalog.md) (seed finder), [scenario-runs.md](scenario-runs.md) (apply/prep roadmap), [test-agent-llm-runbook.md](../../guides/test-agent-llm-runbook.md), [genesis-boot-cards.md](../../specs/kanban/genesis-boot-cards.md).

---

## Vocabulary (use consistently)

| Term | Meaning | Not |
|------|---------|-----|
| **Topic** | What the agent test is *about*: mining, fishing, building, defense, farming, … | A biome or a seed |
| **Terrain profile** | Mapcatalog **requirements** recipe (gates + named **anchors**). Several profiles per topic = different world constraints, same test shape. | Custom worldgen / datapacks |
| **Anchor** | Named placement in requirements (`spawn`, `muster`, `iron_view`, `build_pad`, …). Agent tests tp and predicate relative to anchors. | — |
| **Map** | One **accepted** JSON from `find`: `{ seed, placements, arena, metrics… }`. Pool lives under `catalog/topics/<topic>/<terrain>/`. | **Kanban card** |
| **Kanban card** | Hermes `landfolk-ops` work item | Catalog JSON |

**Rule:** In docs and CLI help, say **map** or **seed map**; reserve **card** for kanban.

---

## Three layers of “world testing”

```text
  Genesis                    Procedural topics              Legacy fixtures
  (campaign boot)            (mapcatalog + agent-tests)     (landfolk-test slabs)
  ─────────────────          ───────────────────────        ────────────────────
  scripts/genesis.sh         topic + terrain + map          data/agent-tests/F*, G*
  wipes main `world`         MV `proc-*` + seed from map    fixed rcon setblocks
  kanban P1/P2 epics         random map per run (goal)      playbook W6 matrices (closed)
  long-lived fleet           short scenario runs            regression only
```

| Layer | When to use |
|-------|-------------|
| **Genesis** | Fresh fleet campaign, base build epics, steward kanban integration |
| **Procedural topic** | New agent/playbook work on **varied real terrain** (mining, farm, build, defense, fish) |
| **Legacy `landfolk-test`** | Bot L0–L6 fixtures, old F/G tests, closed playbook arms — migrate off over time |

Do **not** mix genesis world wipe with procedural `proc-*` loops.

---

## Topic catalog (v1 — converge here)

Five topics cover planned playbooks/skills. Each topic shares **anchor names** so one agent-test YAML can run on any **map** whose profile defines those anchors.

| Topic | Agent focus | Typical anchors | Terrain profiles (examples) | Playbook / skill |
|-------|-------------|-----------------|-----------------------------|------------------|
| **mining** | Ore, caves, chop, scout | `spawn`, `muster`, `iron_view` | `plains_iron`, `forest_edge`, `cave_heavy` | `wood.chop_tall_tree`, mining skill; future `mine.underground_target` |
| **farming** | Crops, pens, breed | `spawn`, `muster`, `farm_patch`, `pen_corner` | `open`, `forest_clearing` | `farm.passive_mob_chicken`, farming skill |
| **fishing** | Shore, rod, water | `spawn`, `muster`, `shore_cast` | `river_shore` | survival skill; future `chore.fish_quota` |
| **building** | Platform, tower, scaffold | `spawn`, `muster`, `build_pad`, `watch_post` | `flat_pad`, `gentle_hill` | `build.tower_vertical`, building skill |
| **defense** | Threat, wall, kite | `spawn`, `muster`, `build_pad`, `breach_point` | `flat_ring` | combat skill; harness mobs until entity gates |
| **establishment** | Explore disc, Steward picks base, cobble pad | `spawn`, `muster`, `starter_chest` | `explore` | `minecraft-scouting-site`; multi-bot kanban — [establish-operator-runbook.md](../../guides/establish-operator-runbook.md) |
| **scouting** | Perception / overlook drills | `spawn`, `muster`, `overlook`, `return_post` | `overlook` | navigation + mining skills; PR-1 scene bench |

**Smoke (engine check):** not a topic — one profile `map_engine_smoke` (thin gates, fast `find`) proves registry → refresh → **map** → `proc-lab` without testing a playbook.

---

## How a run works (today)

1. **Refresh pool** (after requirements change):  
   `scripts/scenario-pools.sh refresh --only mining.plains_iron -s server.local.yaml`
2. **Pick a map:**  
   `scripts/scenario-pools.sh map mining.plains_iron` (alias: legacy variant ids still work)
3. **Materialize:**  
   `mapcatalog try -r <requirements> --seed <from map>` → `proc-lab`
4. **Agent test:** playbook YAML uses anchors from map (manual substitution until `procedural_env` — MC-T9)

No custom terrain generation. Variation = **which map** (seed) + **which terrain profile** (gates), not new generators.

---

## Agent-test alignment

| Status | Location | Action |
|--------|----------|--------|
| **Target** | `data/agent-tests/topics/<topic>/` | New specs: `world: proc-lab`, `procedural_map: { topic, terrain, pick: random }` (field inert until MC-T9) |
| **Migrate** | `data/agent-tests/playbooks/tower-platform-3x3.yaml` | `building` topic, anchors from `build_pad`; drop fixed `(96..104)` coords |
| **Regression** | `data/agent-tests/F*.yaml`, `G*.yaml`, … | Keep on `landfolk-test` until replaced topic-by-topic |
| **Closed** | Wave 6 playbook matrices on slabs | Do not extend; see [improvement-pass-closure.md](../playbooks/improvement-pass-closure.md) |

| **Smallest loop (tester path):** `./scripts/scenario-smoke-agent.sh` — see [procedural-smoke-runbook.md](../../guides/procedural-smoke-runbook.md). Closure checklist: [smoke-closure.md](smoke-closure.md).

---

## Configuration vs generated (git)

| In git | Local / gitignored |
|--------|---------------------|
| `requirements/`, `profiles/` | `catalog/**/*.json` |
| `data/scenarios/registry.yaml` | `catalog/rejects/` |
| `calibration/seeds.yaml` | `server.local.yaml` |
| `server.local.yaml.example` | MV world data (`bench/world/`, …) |

Pin known seeds in **calibration** or **tests/fixtures**, not full catalog dumps.

---

## Complexity we are removing

| Was | Becomes |
|-----|---------|
| “Setting” vs “variant” vs “scenario_id” | **Topic** + **terrain profile** id `topic.terrain` |
| 10 parallel registry names | 5 topics + 1 smoke; ~2–3 terrains each |
| Catalog “card” | **Map** |
| Duplicate docs (settings sketch + 10 variants) | This file + slim [scenario-runs.md](scenario-runs.md) |
| `mine_plains_iron` vs `scenario_resource_*` | One terrain: `mining.plains_iron` (legacy yaml paths unchanged) |

---

## Open wiring (unchanged priority)

| ID | Item |
|----|------|
| MC-T6 | `scenario apply` / prep / cleanup |
| MC-T9 | `procedural_env` in `agent-test.py` (topic + terrain + pick map → inject anchors) |
| MC-T1 | Prove `mining.plains_iron` pool on live server |
| — | Smoke closure done — see [smoke-closure.md](smoke-closure.md) |

---

## Commands (v2 ids)

```bash
scripts/scenario-pools.sh list          # topics + terrains
scripts/scenario-pools.sh lint
scripts/scenario-pools.sh refresh --only smoke
scripts/scenario-pools.sh refresh --only mining
scripts/scenario-pools.sh map mining.plains_iron
# legacy id still works:
scripts/scenario-pools.sh map scenario_homestead_smoke
```

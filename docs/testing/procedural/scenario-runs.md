# Procedural scenario runs

Status: **operational** — pools via `scenario-pools.sh`; `apply` / `procedural_env` still open.

**Start here:** [testing-model.md](testing-model.md) — topics, **maps** (not kanban cards), genesis vs legacy vs procedural.

Successor to fixed-scenario agent tests and genesis-only boot: **randomized terrain** from a **map pool**, repeatable **setup/teardown** on Multiverse **`proc-*`** worlds, without wiping the main genesis `world`.

**Related:** [genesis-boot-cards.md](../../specs/kanban/genesis-boot-cards.md), [test-agent-llm-runbook.md](../../guides/test-agent-llm-runbook.md), [improvement-pass-closure.md](../playbooks/improvement-pass-closure.md), [map-catalog.md](map-catalog.md).

---

## Goals

| Goal | Approach |
|------|----------|
| Randomized maps per test family (mining, build, combat) | Requirements YAML + **offline `find`** → **map pool**; each run **picks a map** |
| Repeatable conditions | Known **seed + placements** on card; **soft** or **hard** reset (below) |
| Fast iteration | **No `find` per run**; **apply card** (~1 min materialize) + seconds-level soft reset |
| Safe ops | Mapcatalog lifecycle only on **`proc-*`**; hub evac to **`landfolk-test`** (or configured hub) |
| Genesis stays separate | Do **not** call `genesis.sh reset_world` for scenario loops |

---

## World namespaces

Three layers — do not conflate them.

| Namespace | Examples | Lifecycle |
|-----------|----------|-----------|
| **Campaign** | `world` | [Genesis](../../guides/genesis-prep-runbook.md) docker bind-mount reset |
| **Hub / legacy tests** | `landfolk-test` | Stable MV world; setblock prep; agent-tests default today |
| **Procedural scratch** | `proc-*` | MV delete → confirm OTP → create `-s` → load; mapcatalog guard |

### Recommended `proc-*` names

| Name | Role |
|------|------|
| `proc-lab` | Serial slot for **`mapcatalog try` / `find`** (catalog building) |
| `proc-run-<run_id>` | One active scenario instance (e.g. `proc-run-g2026-06-01-a3f2`) |
| `proc-preview` | Optional human inspection while bots use `proc-run-*` |

Rules:

- Only names matching **`proc-*`** may use mapcatalog **delete/create** ([`lifecycle.py`](../../mapcatalog/lifecycle.py)).
- Prefer **one loaded proc world per seed** with **multiple sites** (different arena centers) over duplicating MV worlds with the same seed.
- Delete or unload **`proc-run-*`** after tests to limit chunk memory.

Server pointer: [`server.local.yaml.example`](../../server.local.yaml.example) (`world.name`, `world.evac`).

---

## Same seed, multiple locations

A Java **seed is one infinite world**. “Location” = **arena center** + **placements** inside that disc.

| Pattern | Use |
|---------|-----|
| One **Result** (catalog JSON) | One `arena`, many named placements (`spawn`, `muster`, `iron_view`, …) |
| Same seed, **different cards** | Different `arena.center` (e.g. mining at `(0,0)`, build at `(512,512)`) — same MV world, tp between sites; keep **`work_bbox`** disjoint |
| Multiple **`proc-*` names, same seed** | Usually wasteful; use for **parallel isolation** only |

Current mapcatalog job model: **one arena per requirements file**. Multi-site on one seed is supported by **multiple requirements** (or future multi-arena job shape — see [Open work](#open-work)).

---

## Arena size and performance

Cost scales with **`arena.radius`** and gate **grid steps**, not “world size.”

| Radius | Typical use | Notes |
|--------|-------------|--------|
| **32** | Smoke, tight combat/build pads | Fast probes; biome % gates noisier |
| **64** | Default profiles (`mine_plains_iron`, etc.) | Sweet spot for plains / iron / cave sampling |
| **96–128** | Large arenas only when gates require it | More rcon batches + forceload ~ `(2⌈r/16⌉+1)²` chunks |

Guidance:

- Tune **arena**, not infinite map size — preload and tests touch the disc only ([`preload_arena_chunks`](../../mapcatalog/lifecycle.py)).
- Derive **`work_bbox` / `cleanup_bbox`** from arena + spawn (planned auto on full JSON; see [map-catalog.md § Storage](map-catalog.md#storage)).
- Maintain a **catalog pool** of many seeds at **r=64** rather than one seed at huge radius.

---

## Reset and teardown tiers

When **seed + card** are known:

| Tier | Command (planned) | Time | Effect |
|------|-------------------|------|--------|
| **Soft** | `scenario cleanup` | Seconds | Kill mobs, run **`cleanup_commands`** / fill **`cleanup_bbox`**, re-run harness **`prep`**, tp to **`spawn`**. Terrain edits **outside** cleanup may remain. |
| **Medium** | evac + `mv unload` | Seconds | Players to hub; world persisted on disk; **blocks unchanged**. |
| **Hard** | `scenario apply --reset hard` | ~60–90s | MV delete/create/**same seed** + preload — **pristine generated terrain**; re-run **prep**. Same **placements** if same card + requirements version. |

**Repeatability:** Hard reset restores **vanilla generation**; soft reset preserves holes/builds unless cleanup covers them. For agent loops inside one scenario, default to **soft** between attempts; **hard** between unrelated test cases.

**Do not** use `mv unload/load` alone expecting a terrain reset.

---

## End-to-end workflow

```text
  OFFLINE (occasional)
  requirements/scenario_*.yaml  ──►  mapcatalog find  ──►  catalog/<id>/*.json

  PER TEST RUN (fast)
  pick card  ──►  scenario apply  ──►  scenario prep  ──►  agent-test / kanban
                      │                      │
                      └──── scenario cleanup ◄┘ (soft, each attempt)
                      └──── scenario apply --reset hard (optional, between cases)
```

### Scenario registry (planned)

Manifest under `data/scenarios/` (not created yet):

```yaml
# data/scenarios/mining.yaml (sketch)
id: scenario_mining
requirements: requirements/mine_plains_iron.yaml
catalog: catalog/mine_plains_iron
agent_test: data/agent-tests/scenarios/mining.yaml   # future
prep_profile: harness/mining_prep.yaml               # future P4
```

Wrapper script (planned): `scripts/scenario-run.sh --scenario mining --pick random -- agent-test …`

---

## CLI — scenario prep and builds

New **`mapcatalog scenario`** command group ( **planned**; today use manual `try` + rcon — see [Manual interim](#manual-interim) ).

Shared flags: `-s server.local.yaml`, `--json`, `--world <proc-name>` (default from server config or `proc-run-<shortid>`).

| Subcommand | Purpose |
|------------|---------|
| **`scenario pick`** | `-o catalog/<id>/` or `-c path/to/card.json` — choose random or `--seed`; print path or card JSON |
| **`scenario apply`** | Materialize **card seed** into **`--world`**; preload arena; optional **`--markers`** (glowstone at placements); **`--no-probe`** skip gate re-run (trust catalog fingerprint) |
| **`scenario prep`** | Expand job **`prep:`** + card **`prep_commands`** → rcon batch (tools, summons, difficulty); tp `@a` or named bot to **`placements.spawn`** |
| **`scenario cleanup`** | Run **`cleanup_commands`** + kill entities in **`cleanup_bbox`**; idempotent |
| **`scenario reset`** | **`--soft`** → cleanup + prep; **`--hard`** → apply path (delete/create same seed) + prep |
| **`scenario inspect`** | Human checklist: seed, placements, **`metrics_summary`**, gate labels from requirements id |

Example target UX:

```bash
# Build pool (offline)
python -m mapcatalog find -r requirements/mine_plains_iron.yaml -s server.local.yaml \
  -o catalog/mine_plains_iron/ --solutions 5 --max-seeds 120

# One scenario run
CARD=$(python -m mapcatalog scenario pick -o catalog/mine_plains_iron/ --print-path)
python -m mapcatalog scenario apply -c "$CARD" -s server.local.yaml --world proc-run-test1 --no-probe
python -m mapcatalog scenario prep -c "$CARD" -s server.local.yaml --world proc-run-test1 --tp @a
# … run agent test …
python -m mapcatalog scenario cleanup -c "$CARD" -s server.local.yaml --world proc-run-test1
```

**`find`** remains catalog maintenance only — never inside a tight test loop.

Existing commands unchanged: [`mapcatalog` README](../../../mapcatalog/README.md).

### Manual interim

Until `scenario` exists:

1. `mapcatalog find -o … --pick random` or read a catalog JSON file.
2. `mapcatalog try -r … --seed <from card> --json-full` (materializes **`proc-lab`**, re-probes — slower than planned **`apply --no-probe`**).
3. rcon: tp, prep lines by hand; [`map-catalog.md` § Public CLI](map-catalog.md#public-cli) human inspection notes.

---

## Agent-test integration

Sketch from [Appendix A — Hermescraft integration](map-catalog.md#appendix-a--hermescraft-integration-optional):

```yaml
# data/agent-tests/scenarios/mining.yaml (future)
procedural_env:
  catalog_dir: catalog/mine_plains_iron
  pick: random
  world: proc-run-mining
  apply: { no_probe: true, markers: false }
spec:
  prep:
    - from_card: prep_commands
    - "execute in {world} run tp Flint {placements.spawn}"
```

Runner responsibilities ( **open** — see [test-agent-llm-runbook.md](../../guides/test-agent-llm-runbook.md)):

- Resolve card → substitute **`{world}`**, **`{placements.*}`**, **`{seed}`**.
- Call scenario CLI or embed **`mapcatalog.scenario`** library API.
- Soft cleanup between subtests; hard reset on scenario boundary.

---

## Phasing (scenario layer)

| Phase | Deliverable | Depends on | Status |
|-------|-------------|------------|--------|
| **S0** | This doc + mapcatalog cross-links | P2/P3 smoke | **Done** (spec) |
| **S1** | `scenario pick` + `scenario apply` (+ `--no-probe`) | Accepted catalog cards | **Todo** |
| **S2** | `scenario prep` / `cleanup` / `reset` | [P4 prep DSL](map-catalog.md#phasing) | **Todo** |
| **S3** | `data/scenarios/` manifest + `scripts/scenario-run.sh` | S1–S2 | **Todo** |
| **S4** | `procedural_env` in agent-test runner | [test-agent-llm-runbook.md](../../guides/test-agent-llm-runbook.md) | **Todo** |
| **S5** | Multi-site same seed (optional multi-arena job) | S1 | **Backlog** |

Mapcatalog core phases (P1–P3): [map-catalog.md § Phasing](map-catalog.md#phasing).

---

## Open work

| ID | Item | Owner / link |
|----|------|----------------|
| **MC-T1** | Live **`mine_plains_iron` find** (≥1 accept) + **`lint_actual`** | [Success criteria](map-catalog.md#phasing); Test #2 |
| **MC-T2** | **`find_smoke.yaml`** (accept without strict `iron_view`) | Operability + first catalog accept |
| **MC-T3** | Rejects path docs vs **`catalog/rejects/<id>/`** | [find_run.py](../../mapcatalog/find_run.py) |
| **MC-T4** | Ore sampling for **`near block`** placements without ore gate | Speed (#2 tester finding) |
| **MC-T5** | Auto **`work_bbox` / `cleanup_bbox`** on full result JSON | [Storage §](map-catalog.md#storage) |
| **MC-T6** | **`mapcatalog scenario`** subcommands (this doc) | S1–S2 |
| **MC-T7** | Harness **`prep:`** parser + **`scenario prep`** | [P4](map-catalog.md#phasing) |
| **MC-T8** | Entity/mob gates or prep-only mobs for combat scenarios | P4 / backlog |
| **MC-T9** | **`procedural_env`** in agent-test runner | S4, [test-agent-llm-runbook.md](../../guides/test-agent-llm-runbook.md) |
| **MC-T10** | **`scripts/scenario-run.sh`** wrapper | S3, analogous to [genesis.sh](../../scripts/genesis.sh) |
| **MC-T11** | Golden fingerprint test in CI | P3 note in mapcatalog phasing |
| **MC-T13** | **`profiles/homestead.yaml`** + scenario variants (Setting 2) | Homestead v1 |
| **MC-T14** | **`profiles/worksite.yaml`** + W6-T3-on-proc agent-test | Worksite v1 |
| **MC-T15** | Playbook docs: `mine.underground_target`, `farm.passive_mob_chicken`, `build.repair_site`, `scout.resource` | [design-composable-playbooks.md](../playbooks/design-composable-playbooks.md) Stage 3 |
| **MC-T16** | **`chore.fish_quota`** playbook + registry entry | Fishing variant on homestead |

---

## Three scenario settings (v1 focus)

Successor testing ([improvement-pass-closure.md](../playbooks/improvement-pass-closure.md)) targets **procedural worlds** for **farming, mining, scouting, and field prep** — not more fixed-slab geometry (Wave 6 towers on `landfolk-test`). Narrow v1 to **three settings**; each gets **one requirements id**, a **catalog pool**, and **2–4 terrain profiles** (YAML `extends` + gate/placement tweaks), not three separate playbooks per biome.

### What the docs already planned

| Source | Planned work / tests |
|--------|----------------------|
| [design-composable-playbooks.md](../playbooks/design-composable-playbooks.md) registry (design) | **`mine.underground_target`**, **`wood.chop_tall_tree`** (shipped doc), **`scout.resource`**, **`farm.passive_mob_chicken`**, **`build.repair_site`**, **`build.tower_vertical`** (shipped doc), **`craft.from_inputs`**, **`supply.from_chest`**; perception examples for **`chore.fish_quota`** (fish — **not in registry yet**) |
| [data/playbooks/registry.yaml](../../../data/playbooks/registry.yaml) | **Shipped ids:** `wood.chop_tall_tree`, `scout.resource`, `pillar_up_safe`, `craft.from_inputs`, `recover.stuck`, `build.tower_vertical` — **docs on disk:** wood, tower, pillar only |
| [improvement-pass-followup.md](../playbooks/improvement-pass-followup.md) Stage 3 | Library expansion list matches mining / repair / chicken / tower |
| [goal-profiles.md](../../archive/design-misc/goal-profiles.md) | Role metrics: **miner**, **builder** (`base_integrity`, repair), **defender** (`defend_base`) — presets not shipped |
| Agent-test history ([phase-2 sprints](../../archive/phase-2-design/sprints.md)) | **G10** wheat farm; **G11–G16** animals; **G1** stone pickaxe / mining chain; [water-navigation-arena-tests.md](../../archive/features/water-navigation-arena-tests.md) **W0** boat/fish |
| Skills (load via `skill_view`) | **`minecraft-mining`**, **`minecraft-farming`**, **`minecraft-survival`** (fishing depth), **`minecraft-building`**, **`minecraft-combat`**, **`minecraft-chores`** |

**Deferred / lower priority for v1 maps:** full **`build.repair_site`** (needs blueprint Phase 2c — [blueprints.md](../../specs/world/blueprints-grabcraft.md)); **`chore.fish_quota`** playbook doc; Wave 6 **single-column** tower as primary map scenario (prose wins — use procedural **flat pad** instead).

---

### Setting 1 — **Resource field** (mining + surface prep)

**Exercises:** underground iron, cave air, branch mining, **`wood.chop_tall_tree`**, **`scout.resource`**, mining skill / future **`mine.underground_target`**.

| | |
|--|--|
| **Requirements base** | `extends: profiles/plains_mining` → `requirements/scenario_resource.yaml` |
| **Placements** | `spawn`, `muster`, `iron_view`, optional `tree_patch` (forest edge) |
| **Arena** | **r=64** default; variants may use **r=48** for faster probes |

**Terrain variations (same setting, different catalogs or gate thresholds):**

| Variant id | Gate / profile tweak | Stress |
|------------|----------------------|--------|
| `resource_plains_iron` | Current `mine_plains_iron` profile | Shallow iron + caves on open plains |
| `resource_forest_edge` | Biome allow adds birch; `biomes distinct <= 3` | Chop + scout on mixed edge |
| `resource_cave_heavy` | Raise `cave_air` min band; iron gate unchanged | Descend / chamber feel |

**Mapcatalog:** already closest to implemented (`requirements/mine_plains_iron.yaml`). **Open:** [MC-T1](map-catalog.md#phasing) live accepts; [MC-T4](#open-work) ore sampling for `near block` placements.

---

### Setting 2 — **Homestead** (crops + passive mobs + optional fish)

**Exercises:** till/plant/harvest (**G10**), **`farm.passive_mob_chicken`**, breeding/lure (`minecraft-farming`), optional **`mc fish`** / boat near water ([survival skill](../../../skills/minecraft-survival.md)).

| | |
|--|--|
| **Requirements base** | New profile `profiles/homestead.yaml`: flat patch, grass, surface water **band** (min/max %), low height jitter |
| **Placements** | `spawn`, `muster`, `farm_patch` (`flat_patch_center`), `pen_corner`, optional `shore_cast` (`near` water — gate TBD) |
| **Arena** | **r=32–48** (smaller — flat farm patch is local) |

**Terrain variations:**

| Variant id | Gates | Stress |
|------------|-------|--------|
| `homestead_open_plains` | water ≤ 5%, flat patch ≥ 12 cells | 3×3 crop + pen prep |
| `homestead_river_edge` | surface water 5–25% | Fishing / bucket_fill without full W0 arena |
| `homestead_forest_clearing` | biome forest/plains mix; grass ≥ 20% | Trees nearby, open floor for pen |

**Harness (P4):** seed pen fence, spawn 2 chickens, give hoe/seeds/wheat; fish variant gives rod + boat. **No mob entity gates yet** — [MC-T8](#open-work).

---

### Setting 3 — **Worksite** (build + repair + defense)

**Exercises:** **`build.tower_vertical`** on natural flat pad (not slab at `(82,65,58)`), future **`build.repair_site`**, combat skill + **`defend_base`** goals ([goal-profiles](../../archive/design-misc/goal-profiles.md)); Wave 6 **platform/scaffold** patterns on **real terrain**.

| | |
|--|--|
| **Requirements base** | Profile `profiles/worksite.yaml`: flat patch ≥ N, neighbor height delta ≤ 2, water ≤ 10% |
| **Placements** | `spawn`, `muster`, `build_pad` (`flat_patch_center`), `watch_post` (offset), optional `breach_point` |
| **Arena** | **r=48–64** |

**Terrain variations:**

| Variant id | Gates / prep | Stress |
|------------|--------------|--------|
| `worksite_flat_pad` | Largest flat component ≥ 16 cells | Tower / platform playbook on dirt/grass |
| `worksite_gentle_hill` | Allow slightly higher height jitter (≤ 3) | Approach + scaffold on slope |
| `worksite_defense_ring` | Same flat gates + harness: partial wall damage + night spawn | **`minecraft-combat`**, flee/kite (controlled summons) |

**Note:** Repair against blueprint is **harness-only** until Phase 2c; defense uses **prep summons**, not procedural mob gates.

---

### Mapping settings → iteration stack

```text
  Setting          Playbook / skill (primary)        Agent-test pattern
  ─────────────────────────────────────────────────────────────────────
  Resource field   wood.chop_tall_tree, mining,     G1-like + chop stress
                   scout.resource (registry)
  Homestead        farm.passive_mob_chicken (doc     G10, G11–G16
                   TBD), minecraft-farming
  Worksite         build.tower_vertical, building,   W6-T3 platform on
                   combat (defense variant)          proc flat_pad
```

**Catalog strategy:** one **`find` pool per variant id** (or one requirements file with commented presets). Steward cards reference **`procedural_env.catalog_dir`** + scenario id; workers still use **prose-skilled or playbook** per [closure authoring policy](../playbooks/improvement-pass-closure.md).

### v1 deliverables (narrow scope)

1. **Resource:** finish `mine_plains_iron` catalog + 1–2 YAML variants.
2. **Homestead:** add `profiles/homestead.yaml` + `find_smoke`-style accept path, then chicken/crop harness.
3. **Worksite:** `worksite_flat_pad` requirements + agent-test port of **tower-platform-3x3** predicates onto **`build_pad`** from card.

**Implemented (repo):** profiles + `requirements/scenario_*.yaml`, [`data/scenarios/registry.yaml`](../../../data/scenarios/registry.yaml), [`scripts/scenario-pools.sh`](../../../scripts/scenario-pools.sh), `python -m mapcatalog scenario {list,lint,refresh,card}`. See [`data/scenarios/README.md`](../../../data/scenarios/README.md).

Track playbook doc gaps in [design-composable-playbooks.md](../playbooks/design-composable-playbooks.md); procedural work does not block on full Stage 3 catalog.

---

## Scenario families (legacy sketch)

Superseded for planning by [Three scenario settings](#three-scenario-settings-v1-focus) above. Quick reference:

| Family | Maps to setting |
|--------|-----------------|
| Mining | **Resource field** |
| Construction / combat | **Worksite** |
| (Farm / fish) | **Homestead** |

Author under `requirements/scenario_<setting>_<variant>.yaml`; commit **catalog** JSON when stable; gitignore **`rejects/`** and ephemeral **`proc-run-*`** state.

---

## Related

- [map-catalog.md](map-catalog.md) — gates, placements, find/try/lint
- [genesis-boot-cards.md](../../specs/kanban/genesis-boot-cards.md) — when to use genesis instead
- [playbook-pass-test-procedure.md](../playbooks/test-procedure.md) — regression; new work uses procedural worlds
- [learnings.md](../../reference/fleet-notes.md) — successor bench direction

# landfolk — repeatable fresh-world genesis with phased base bootstrap

## Context

The Minecraft server's overworld is full of holes, half-built scaffolds, stranded pillars, and stale anchors from weeks of testing. Every Steward session starts inheriting that damage, which biases what the bots try to do (cleanup-heavy load, rescue churn, mark drift). We want to reset to a fresh world on demand, give Steward a starter set of cards that describe phased base-bootstrap missions, and let the fleet build up from zero — testing the orchestration plumbing (gate-check, shared marks, base-inventory) against a controlled benchmark.

Each genesis run is self-contained and produces a comparable benchmark snapshot, so daily runs can be diffed against each other.

**Locked decisions** (from user clarification):

- **World reset**: full wipe of the overworld, fresh random seed each run. `landfolk-test`/`testflat`/nether/end stay untouched.
- **State wipe**: kanban DB and all `data/locations-*.json` (private + shared) archived per-run. Genesis chooses a **non-water** base location after world generation, seeds the base + system-chest + starter cards, then hands off to Steward.
- **Difficulty ramps with phases** (not a single per-run value):
  - **Phases 1 & 2: peaceful** — no mob spawns. Bots focus on building, scouting, and resource bootstrap without combat noise.
  - **Phase 3: peaceful** — complete defensive baseline (shelter hardening + tower) before hostile pressure starts.
  - **Phase 4: easy** — first hostile-pressure expedition phase used to validate long-range scouting and recovery.
  - **Phase 5+ (open loop): normal** — full survival. Stuck-bot rescue churn under hostile pressure is a deliberate test surface.
  - Genesis applies the initial level via rcon `/difficulty peaceful` after spawn. Automatic transitions: when `[GENESIS:P3]` completes, switch to `/difficulty easy`; when `[GENESIS:P4]` completes, switch to `/difficulty normal`. Operator override: `genesis.sh new-run --difficulty <level>` pins the level for the whole run (skip ramp, useful for isolating one challenge surface).
- **System-chest doctrine**: the system_chest exists and is stocked from the first second of every run, but acts as an **operator-controlled relief valve, not an auto-supply**. Phase 1 workers are forbidden from withdrawing from it; Steward may direct a worker to it only on explicit operator instruction (or as an escape hatch for a stuck phase). This lets us measure how well the fleet bootstraps unaided, while keeping a guaranteed unblock path.
- **Run-scoped analysis storage**: every per-run directory captures not just the snapshot JSONs but also operator notes, rescue artifacts, world-specific observations, and a digest of Steward's session findings. Runtime rescue litter that currently lands at the repo root (`RESCUE_*.md`, `rescue-*.txt`) is moved into the active run dir by convention first, then by automation as soon as an auto-watcher lands (tracked in this plan).
- **Independence from plugin rollout work**: genesis is an ongoing live-testing capability for repeatable resets and seed experiments. It should remain usable regardless of unrelated plugin development milestones; plugin hooks are optional acceleration paths, not rollout gates.

## High-level architecture

```text
┌────────────────────────────────────────────────────────────────┐
│ Operator: scripts/genesis.sh new-run [--seed <int>]            │
│   (negative: --seed=-8675309)  [--anchor X,Y,Z] optional       │
└───────────────────────┬────────────────────────────────────────┘
                        │
        ┌───────────────▼────────────────┐
        │ 1. landfolk stop (bots+daemons)│
        │ 2. Archive world + kanban + marks → data/genesis-runs/<id>/archived/
        │ 3. Fresh MC world (new seed)   │
        │ 4. Probe + pick base (non-water, ≥8×8 land, y≥63)
        │ 5. Copy genesis templates → data/ (goals, regions, plan anchor, chest coords)
        │ 6. Seed system_chest at run anchor (scripts/system-chest.mjs place && fill)
        │ 7. File [GENESIS:P1..P4] epics + Phase-1 cards (from templates)
        │ 8. Capture snapshot-start.json baseline
        │ 9. landfolk start                                       │
        └───────────────┬─────────────────┘
                        │
        ┌───────────────▼─────────────────┐
        │ Steward observes board.         │
        │ Sees [GENESIS:P1] ready.        │
        │ Decomposes per genesis doctrine.│
        │ Workers execute. Phase done_when fires → P2 unblocks. │
        │ Phase boundaries snapshot automatically.                │
        └───────────────┬─────────────────┘
                        │
        ┌───────────────▼─────────────────┐
        │ genesis-snapshot.py captures    │
        │ at phase epic done (poller) +   │
        │ manual tick-NNN labels          │
        │ → data/genesis-runs/<id>/       │
        │ snapshot-phaseN.json            │
        └─────────────────────────────────┘
```

## Genesis phases (the missions Steward will execute)

Each phase is a `[GENESIS:Pn]` root epic pre-filed by `genesis.sh`. **Only the epic chain is parent-linked:** P2←P1, P3←P2, P4←P3 (`hermes kanban create ... --parent <prior-epic-id>`). Landfolk `promote_next_for` will not promote a `todo` until all `task_links` parents are `done`/`archived` — so Phase 1 **worker** cards must **not** use `--parent` pointing at `[GENESIS:P1]` while P1 is still open, or Flint/Mason tasks would stay blocked. P1 children are filed as independent `ready`/`todo` cards from `phase1-cards.yaml`; epic progression gates P2+ only.

### Phase 1 — Establish base (root: `[GENESIS:P1]`)

Pre-decomposed children filed by `genesis.sh`:

1. `[SCOUT]` flint — Confirm the chosen anchor at (X, 65, Z) is non-water, flat (≤2 block delta within 5m), and within view of the system_chest. Pin a `base_anchor` mark.
2. `[CONSTRUCT]` flint — Place 4 chests: `chest_food`, `chest_wood`, `chest_stone`, `chest_misc` adjacent to anchor at relative coords (+1, 0), (+1, +1), (-1, 0), (-1, +1). Mark each (private write) — reconciler promotes to shared at phase end.
3. `[CONSTRUCT]` mason — Build a 5×5 cobble shelter around anchor (walls + roof + door) using world-gathered resources.
4. `[RECONCILE]` steward (continuous) — Run `scripts/reconcile-marks.py --auto` to promote the 4 worker chest marks into `data/locations-base.json`.
5. `[SITE]` steward — Create shelter region once footprint is known: `mc region_create :shelter: base --r <N> --y <min>..<max> --intent marker` (marker or resource intent → `allow_ad_hoc_place: true`; plain `protect` base profile does not). Then `mc regions_reload` if the file was edited offline.

Phase done_when: anchor mark present, 4 chest marks in `locations-base.json`, shelter region with `allow_ad_hoc_place: true` exists, all 4 chests have snapshots (`mc list_container` / goals chest snapshots refreshed).

### Phase 2 — Sustainable resources (root: `[GENESIS:P2]`, parent=P1)

Steward decomposes after P1 closes. Driven by **genesis** `data/base-goals.yaml` copied from `data/genesis/templates/base-goals.template.yaml` (benchmark thresholds — not production `target_min` 512 for wood/stone): food=64, wood=128, stone=128, coal=64:

- `[SCOUT]` flint — Find nearest tree cluster (mark `lt_wood_<dir>`), cobble/stone surface deposit (mark `lt_stone_<dir>`), and surface water source for farming (mark `lt_water_<dir>`).
- `[SUPPLY]` flint — Chop ≥128 wood, deposit to `chest_wood`.
- `[SUPPLY]` mason — Mine ≥128 cobblestone, deposit to `chest_stone`.
- `[SITE]` flint — Establish a wheat plot near water; designate as `farm_wheat_<dir>` region with intent=resource.
- `[SUPPLY]` flint — Harvest enough wheat to bake 64 bread, deposit to `chest_food`.

Phase done_when: base-inventory.py reports food/wood/stone all ≥ `target_min`, and 3 `lt_*` resource marks plus 1 farm region exist in `locations-base.json` + `regions-world.json`.

### Phase 3 — Defenses + watch tower (root: `[GENESIS:P3]`, parent=P2)

Steward decomposes after P2 closes. P3 is still peaceful and is treated as the final fortification pass before hostile pressure begins.

- `[CONSTRUCT]` mason — Upgrade shelter walls (5×5 → 7×7, raise to 3 blocks, add door + roof access).
- `[SITE]` mason — Designate `tower_anchor` placemark adjacent to base, in `regions-world.json` with `allow_ad_hoc_place: true`.
- `[CONSTRUCT]` mason — Build watch tower from `data/ops/plans/hut1-guard-tower-plan.json` (per-run copy with anchor rewritten from template). **In-world:** `mc task_context set hut1` (or worksite region id), layer-wise `mc blueprint verify hut1-guard-tower --level N`, then **manual `mc place`** — `mc construct` is not implemented yet. **Offline audit:** `scripts/blueprint-tool.py verify hut1-guard-tower-plan.json`. Steward may use `scripts/blueprint-plan.py` for layer cards.

Phase done_when: `:hut1:` (or tower) region active in `regions-world.json`, `mc blueprint verify` passes for all plan layers, defensive readiness noted on cards (weapons + fallback posture).

### Phase 4 — Long-range expeditions (root: `[GENESIS:P4]`, parent=P3)

Once P3 closes, **difficulty switches to `easy`**. P4 is the first hostile-pressure scouting phase and is explicitly gated.

Steward decomposes P4 into `[EXPEDITION]` cards focused on finding and confirming long-range points of interest. Acceptable target classes include resource-rich areas, villages, temples, monuments, and similar high-value sites.

Phase done_when:
- at least 3 unique POI marks in shared marks (use fleet prefix `lt_`, e.g. `lt_village_ne`, `lt_temple_sw` — reconciler promotes `lt_*`)
- each POI ≥ 1000 blocks from `base_anchor` (Steward verifies; `genesis-snapshot.py` / `genesis.sh check-phases` compute distance from template checklist)
- each mark has a short strategic-value note (kanban comment or mark note)

When P4 closes, **difficulty switches to `normal`**.

### Phase 5+ — Continuous operations (Steward continuous, no gating epic)

Once P4 closes, the genesis script's root cards are exhausted and Steward returns to her standard continuous loop with the shared-marks doctrine: emit `[EXPEDITION]` cards every few cycles for distant scouting, drop `lt_*` marks at promising mining/food spots, and use the `mark-drift.py` detector (designed but not built yet — see `docs/features/landfolk-plugin.md`) to surface stale marks for review. This phase tests durable-marker stability and rescue resilience across hours of operation under full hostile pressure.

## Genesis templates (`data/genesis/templates/`)

Version-controlled templates make each run repeatable: same card titles, same `done_when` checklists, same resource thresholds, and the same phase gates. Substitution uses **flat scalar placeholders only** (composite `{anchor}` / `{system_chest_at}` are not used): `{seed}`, `{run_id}`, `{anchor_x|y|z}`, `{system_chest_x|y|z}`, `{tower_x|y|z}`, `{started_at}`.

| Template | Purpose |
|---|---|
| `phase-epics.yaml` | Four `[GENESIS:Pn]` epic titles, bodies, assignee `steward` (lowercase), `done_when` bullets, `difficulty_on_done` (P3→easy, P4→normal). Seeded via `hermes kanban create` with epic→epic `--parent` only. |
| `phase1-cards.yaml` | Five Phase-1 cards; **no** `--parent` on `[GENESIS:P1]`. Bodies use `{anchor_x|y|z}` and `{system_chest_x|y|z}`. |
| `phase-checklists.yaml` | Machine rules for `check_phases` and snapshot `phase_checks`. |
| `base-goals.template.yaml` | Benchmark thresholds (food/wood/stone/coal 64/128/128/64) → `data/base-goals.yaml`. |
| `regions-world.template.json` | `base`, `shelter` (marker), `hut1` with substituted anchor/tower coords. |
| `hut1-guard-tower-plan.template.json` | Patches `data/ops/plans/hut1-guard-tower-plan.json` from source plan + `{tower_x|y|z}` / marker at anchor. |
| `system-chest-offsets.json` | Integer `dx/dy/dz` for primary, other, sign, and `tower_pad` from anchor (reference data, no placeholders). |

**Deferred (v1.1):** `system-chest.starter-manifest.json`, `p4-targets.example.yaml`, `scripts/genesis_targets.py` (Paper/Cubiomes).

**Operator commands** (`scripts/genesis.sh` — see [genesis-runbook.md](../guides/genesis-runbook.md)):

| Command | Notes |
|---|---|
| `new-run --seed <int>` | Required seed; negative: `--seed=-8675309`. Optional `--anchor X,Y,Z`, `--difficulty`, `--no-confirm`. |
| `seed-cards` | Re-file epics/P1 from templates (active run config). |
| `check-phases [--json]` | Live evaluation vs `phase-checklists.yaml`. |
| `render-templates --seed <int> --anchor X,Y,Z` | Non-destructive render + `config.json` (dry-run: `GENESIS_DRY_RUN=1`). |
| `snapshot [--label <name>]` | Label regex `[a-zA-Z0-9_-]+`; ticks `tick-001` (zero-padded). |
| `list` / `current` | Run registry; `.active` pointer. |
| `diff <run_a> <run_b>` | Wraps `genesis-diff.py`. |
| `note <text>` | Appends `notes.md` on active run. |
| `archive-rescue <path>` | Copies rescue artifact into `rescues/`. |

**Not in Core v1:** `watch-rescues` (use `archive-rescue` manually).

## Implementation (Core v1 — shipped)

Operator guide: [docs/guides/genesis-runbook.md](../guides/genesis-runbook.md).

### Build A — Genesis script (`scripts/genesis.sh` + Python helpers)

- `scripts/genesis.sh` — `new-run`, `seed-cards`, `check-phases`, `render-templates`, `snapshot`, `list`, `current`, `diff`, `note`, `archive-rescue`. Flags: `--seed` (use `--seed=-N` for negative seeds), `--anchor X,Y,Z` (replaces earlier `--base` naming in drafts), `--difficulty {peaceful|easy|normal|hard}`, `--no-confirm`.
- `scripts/genesis_lib.py` — lock (`.lock`), active run (`.active`), JSON-lines `run.log`, archive, `reset_world` (world name guard), `probe_base_anchor`, `validate_templates`, `render_templates`, `seed_system_chest`, `seed_starter_cards`, `apply_difficulty`, `check_phases`, `start_phase_poller`.
- `scripts/genesis-phase-poller.py` — background poll; on `[GENESIS:Pn]` epic `done` → `apply_difficulty` + `snapshot-phaseN.json`.
- `scripts/genesis-snapshot.py`, `scripts/genesis-diff.py`.
- `data/genesis/templates/` — seven files listed above; `data/genesis-runs/` gitignored (see `.gitkeep`).

**Environment:** `MC_HOST_SSH`, `MC_DOCKER_NAME`, `GENESIS_COMPOSE_FILE`, `GENESIS_WORLD_DATA`, `GENESIS_DRY_RUN`, `GENESIS_RUNS_ROOT` (optional override), `HERMES_KANBAN_BOARD` (default `landfolk-ops`).

**Run id:** `g-YYYY-MM-DD-N` (daily counter, not zero-padded). **`config.json`** per run: `run_id`, `seed`, `world`, `difficulty` (null = ramp enabled), `base_anchor`, `system_chest_at` (+ other/sign in lib), `started_at` (ISO-8601 UTC `Z`), `genesis_version` (git short sha).

Subcommand contracts:

| Command | What it does | Reversible? |
|---|---|---|
| `genesis.sh new-run` | Full destructive reset → render templates → seed cards → start bots. Confirms first. | No (archived, not deleted) |
| `genesis.sh seed-cards` | Render templates + file epics/P1 cards only (debug) | Yes if no wipe |
| `genesis.sh check-phases` | Evaluate `phase-checklists.yaml` vs live marks/regions/inventory/kanban | Yes |
| `genesis.sh render-templates` | Preview substituted templates for an anchor/seed | Yes |
| `genesis.sh snapshot` | Read-only state capture into the active run dir | Yes |
| `genesis.sh diff` | Read-only compare of two runs | Yes |
| `genesis.sh list` | List runs with start time, phase reached, end time | Yes |
| `genesis.sh current` | Print active run id + seed/anchor from `config.json` | Yes |
| `genesis.sh note` | Append operator text to `notes.md` on active run | Yes |
| `genesis.sh archive-rescue` | Copy rescue artifact into active run `rescues/` | Yes |

### Build B — Base-location probe (non-water requirement)

Inside `genesis_lib.py`:
1. After the fresh world spawns, use rcon `/locate biome minecraft:plains` (fallback `forest`, `savanna`) to find a candidate centroid.
2. Spiral-sample 5×5 blocks at y=63..65 around centroid via `/execute if block <pos> minecraft:water run say HIT` parsed from server log.
3. Pick first 8×8 area where all blocks at chosen y are solid (not water/lava/air-with-water-below).
4. Set worldspawn there (`/setworldspawn`), force-load the chunk (`/forceload add`), and place a marker sign at the anchor.

Falls back to manual operator coords if probe times out: `genesis.sh new-run --seed=<int> --anchor 100,65,-200`.

### Build C — Starter-card seeder

`genesis_lib.py:seed_starter_cards(run_id, anchor)`:

1. Renders `phase-epics.yaml` → four `hermes kanban create` calls with `--parent` only on P2←P1, P3←P2, P4←P3 (assignee steward).
2. Renders `phase1-cards.yaml` → five creates **without** epic parent links (assignees flint/mason/steward per template).
3. Writes rendered bodies to `data/genesis-runs/<run-id>/rendered/` for audit/diff across runs.

Fresh kanban DB → small task IDs. `[GENESIS:P1]` starts `ready`; P2–P4 start `todo` until parent epic `done`. Assignee on epics should be steward so gate-check can promote the next epic when the prior closes.

### Build D — Steward SOUL: "genesis epic doctrine"

Add a small section to `prompts/landfolk/steward.md` (≤40 lines):

- When a `[GENESIS:Pn]` epic is `running` on the board, that's the active phase.
- Do NOT trigger supply-driven card creation from base-goals.yaml before P1 is done (no chests yet → no snapshots → false zeros).
- Phase children are decomposed by Steward only after the prior phase's root moves to `done` (`task_links` parent enforces this).
- The `[GENESIS:Pn]` cards have explicit `done_when` checklists; Steward verifies each before marking the epic done.
- **System-chest is off-limits during Phase 1.** It exists at `system_chest` mark and is fully stocked, but Phase 1 workers must NOT withdraw from it — they bootstrap from world resources (the point of the benchmark). Steward may issue a `[CHAT_REQUEST]` to direct a worker to it only when (a) explicitly instructed by re44, or (b) a phase has been stuck > 30 minutes with no progress and Steward has filed a `[BUG]` card explaining the failure. The system-chest is a relief valve, not a supply line.
- **Difficulty transitions are phase-close driven.** On `[GENESIS:P3]` `done` → `/difficulty easy`; on `[GENESIS:P4]` `done` → `/difficulty normal` (unless operator pinned `--difficulty`).
- **P4 expedition bar is explicit.** Steward closes `[GENESIS:P4]` only after 3+ unique POIs are marked at distance ≥1000 blocks from base with short value notes.
- During the run, Steward writes brief observations (1-2 lines per cycle worth keeping) to `data/genesis-runs/<run-id>/observations/steward-cycle-<n>.md` via terminal write. Captures: terrain surprises, mob encounters, repeated failure modes. These feed the per-run findings digest.
- Once `[GENESIS:P4]` is done, Steward returns to her standard 5-phase ritual; the observations file rolls over to `expeditions/`.

### Build E — Benchmark snapshot tool (`scripts/genesis-snapshot.py`)

Writes `data/genesis-runs/<run-id>/snapshot-<label>.json` capturing:

```yaml
ts: ISO
run_id: g-2026-05-27-1
elapsed_min: 47
seed: 8675309
difficulty: peaceful|easy|normal
base_anchor: {x, y, z}
system_chest_at: {x, y, z}
phase: current   # P1 / P2 / P3 / P4 / post-P4
phase_completion:
  P1: {filed, done_at, duration_min, blocks_logged, blocks_resolved}
  P2: {...}
  P3: {...}
  P4: {...}
resources:        # from scripts/base-inventory.py --json
  food: {current: N, target_min: 64, target_ok: 128}
  wood: ...
marks:
  shared_count: N
  private_total: N
  by_prefix: {chest_: N, base_: N, lt_: N, mine_: N}
  stale_flagged: N
kanban_events:
  created: N, completed: N, blocked: N, archived: N, reassigned: N
block_reasons:    # aggregate from scripts/lib/kanban_block_reason.py + board-recent blocked events
  region_blocked: N
  prerequisite_missing: N
  stuck_pocket_no_escape: N
  decision_needed: N
  other: N              # free-text blocks not matching known prefixes
phase_checks:      # from phase-checklists.yaml via genesis.sh check-phases
  P1: {pass: bool, failures: [...]}
  ...
rescues:           # count of items in run-dir's rescues/ folder
  total: N
  by_bot: {flint: N, mason: N}
findings:
  steward_cycles: N
poi_distance_min:  # optional: min distance among lt_* POIs marked this run
system_chest_usage:  # v2: manual/comment audit until withdraw telemetry exists
  relief_events: N
```

Triggers:
- Automatic at run start (`snapshot-start.json`)
- On `[GENESIS:Pn]` epic → `done`: `apply_difficulty` (P3→easy, P4→normal unless pinned) + `snapshot-phaseN.json` via `genesis-phase-poller.py` (plugin hook optional v1.1)
- Manual periodic: `genesis.sh snapshot --label tick-NNN` (zero-padded; automated 30m cron deferred v1.1)
- Manual: `genesis.sh snapshot --label <name>`
- End of run on next `new-run` (`snapshot-end.json`)

### Build F — Per-run archive layout + `genesis-diff.py`

```text
data/genesis-runs/
  g-2026-05-27-1/
    config.json               # pinned schema (see Build A)
    run.log                   # JSON-lines per new-run step
    poller.pid / poller.log   # phase boundary automation
    rendered/                 # substituted epic/P1 bodies for audit
    snapshot-start.json
    snapshot-phase1.json
    snapshot-phase2.json
    snapshot-phase3.json
    snapshot-phase4.json
    snapshot-end.json
    archived/                 # state captured at run start (from the PREVIOUS run)
      kanban.db
      locations-base.json
      locations-flint.json
      locations-mason.json
      ...
    observations/             # Steward writes per-cycle observations here
      steward-cycle-01.md
      steward-cycle-02.md
      ...
    rescues/                  # rescue artifacts created during this run
      rescue-flint-1746.txt   # routed in from repo root via scripts/genesis.sh archive-rescue
      ...
    findings/                 # world-specific discoveries
      mob-spawning-notes.md
      terrain-surprises.md
      ...
    notes.md                  # operator free-form notes (appended via `genesis.sh note`)
    digest.md                 # end-of-run roll-up (auto-generated when next run starts)
  g-2026-05-28-1/
    ...
```

The `digest.md` rolls up everything when a run closes: phase durations, resource yields, mark stability stats, top 3 block reasons, count of rescues, link to interesting observation files. It's the "what did we learn this run" artifact you skim before kicking off the next one.

`scripts/genesis-diff.py run-a run-b` prints a markdown table comparing phase durations, resource yields, mark counts, block reason histograms, rescue counts, and links the two `digest.md` files.

`scripts/genesis.sh archive-rescue <path>` copies a stray `RESCUE_*.md` / `rescue-*.txt` into the active run's `rescues/` dir. Auto-watcher `watch-rescues` is deferred to v1.1.

## Reusable existing pieces

| Reuse from | For |
|---|---|
| `scripts/system-chest.mjs place && fill` | Step 6; coords from `SYSTEM_CHEST_{PRIMARY,OTHER,SIGN}_{X,Y,Z}` env (fallback: legacy hardcoded base) |
| `scripts/run-fixture.sh` rcon pattern (ssh→docker→rcon-cli) | Probe, difficulty, worldspawn (production `world`, not `landfolk-test` only) |
| `data/test-fixtures/` YAML format | Inspiration for template layout; genesis does not reuse test-world prep for prod wipe |
| `scripts/reconcile-marks.py --auto` | Phase 1 RECONCILE card |
| `scripts/base-inventory.py --json` | P2 done_when + snapshots (reads genesis `base-goals.yaml`) |
| `scripts/board-recent.py --since --json` | Kanban event deltas for snapshot |
| `scripts/lib/kanban_block_reason.py` | Block reason histogram (known prefixes only) |
| `mc region_create` / `mc regions_reload` | Shelter, farm, hut1 regions |
| `mc blueprint verify` | P3 layer acceptance (`mc construct` N/I — manual place) |
| `scripts/blueprint-tool.py` + hut1 plan JSON | Offline verify; per-run plan from template |
| `plugins/landfolk/.../hooks.py` | Optional snapshot-on-complete fast path |
| `prompts/landfolk/steward.md` | Build D genesis doctrine |
| Paper `/locate` via rcon | **Default** P4/base probe (Track B); Cubiomes optional (Track A) |

## Critical files

| Topic | File | Status |
|---|---|---|
| Operator entry point | `scripts/genesis.sh` | Core v1 |
| Genesis Python lib | `scripts/genesis_lib.py` | Core v1 |
| Phase poller | `scripts/genesis-phase-poller.py` | Core v1 |
| Templates | `data/genesis/templates/` (7 files) | Core v1 |
| Snapshot / diff | `scripts/genesis-snapshot.py`, `scripts/genesis-diff.py` | Core v1 |
| Steward SOUL | `prompts/landfolk/steward.md` (genesis epic doctrine) | Core v1 |
| Acceptance tests | `scripts/tests/test_genesis_*.py`, `test_templates.py` | Core v1 |
| Phase-done hook | `plugins/landfolk/.../hooks.py` | v1.1 optional |
| Target discovery | `scripts/genesis_targets.py` | v1.1 (Build G) |
| Plugin doc | `docs/features/landfolk-plugin.md` (Backlog section) | Add `genesis-snapshot` hook trigger to existing detectors list |
| Per-run dir | `data/genesis-runs/<run-id>/` (new, gitignored) | All runs |
| MC compose | `docker/minecraft/docker-compose.yml` on homelab repo | Reference only — world dir + server.properties seed setting |
| Existing reset reference | `scripts/relax-paper-movement.sh` | Pattern for SSH→docker rcon ops |

## Verification

**Smoke test 1: full `new-run` end-to-end**
1. `scripts/genesis.sh new-run --seed 12345` — operator confirms destructive op.
2. Tail `/tmp/hermescraft/landfolk-control.log` for world archive + restart sequence.
3. Probe finds a non-water plains within ~30s; logs base anchor.
4. `data/genesis-runs/g-<ts>-1/snapshot-start.json` exists with all-zeros card counts and the new seed/anchor.
5. `hermes kanban --board landfolk-ops list` shows 4 epics (P2–P4 `todo`, linked P2←P1 etc.) + 5 Phase-1 cards **without** parent link to P1 epic; P1 epic `ready`.
6. `scripts/genesis.sh check-phases` reports P1 not passed until criteria met; bots connect; Steward decomposes P2+ after P1 epic `done`.

**Smoke test 2: phase boundary snapshot**
1. After Phase 1 completes (manually drive workers or wait), `genesis-phase-poller.py` (or manual `genesis.sh snapshot --label phase1`) writes `snapshot-phase1.json` when `[GENESIS:P1]` epic is `done`.
2. `data/genesis-runs/g-<ts>-1/snapshot-phase1.json` exists with `elapsed_min`, `phase_completion.P1.done_at`, mark counts ≥ 5 (4 chests + 1 anchor), and resources still mostly zero (Phase 2 hasn't run).
3. P2 epic becomes eligible (`todo` with P1 `done`); steward assignee + gate-check promotes P2 to `ready` when steward has no other active epic work.

**Smoke test 3: repeatability + diff**
1. Run a 2nd genesis the next day.
2. `scripts/genesis-diff.py g-2026-05-27-1 g-2026-05-28-1` prints comparison.
3. Phase 1 durations should be in the same ballpark (±50%); resource yields by Phase 2 end comparable. Block-reason histograms surface any new failure modes.

**Probe-fail fallback**
1. `scripts/genesis.sh new-run --seed=99999 --anchor 0,64,0` skips the probe and forces the supplied anchor. Useful if locate-biome times out or for deterministic repro of a specific seed.

## Build G — Expedition target-source investigation (Cubiomes vs Paper locate)

Goal: make P4 targeting repeatable and measurable across seeds.

**Default path (Track B — Paper locate):** use rcon `/locate structure` / `/locate biome` (same transport as `run-fixture.sh`) during or after `new-run`; write candidates into `p4-targets.example.yaml` rendered output for Steward. No new binary deps; fits live testing.

**Optional (Track A — Cubiomes):** offline seed-aware candidates for villages/structures before bots travel; compare reproducibility vs Paper on fixed seeds.

`scripts/genesis_targets.py` should implement Paper first, Cubiomes behind a flag.

Decision criteria:
- reproducibility across runs of same seed
- speed (time-to-first 3 viable POIs)
- operational complexity / maintenance burden
- compatibility with "live testing" constraints (minimal special infra)

Deliverable:
- short `docs/features/genesis-targeting.md` note with chosen default and fallback path.

## Resolved decisions

- ✅ **Phase 3 blueprint**: reuse `data/ops/plans/hut1-guard-tower-plan.json` (proven). A larger / more elaborate tower is a later post-P3 mission.
- ✅ **landfolk-test world**: stays untouched. Already automated for testing; genesis only touches the default `world` overworld.
- ✅ **System-chest enforcement**: doctrine-only (Steward SOUL + worker SOUL). No `pre_tool_call` sentinel hook.
- ✅ **Difficulty ramp**: peaceful for P1–P3; switch to easy after P3 `done`; switch to normal after P4 `done`. Operator can override with `--difficulty <level>` to pin one value.
- ✅ **MC server restart authority**: genesis.sh `ssh ubuntu-host "sudo docker compose -f /opt/stacks/minecraft/docker-compose.yml restart"` is in-scope. The script handles full destructive ops including container restart. (Operator confirms via interactive prompt before each `new-run`; `--no-confirm` skips for scripting.)
- ✅ **Run-id format**: `g-YYYY-MM-DD-N` — human-readable, sorts chronologically, includes today's nth run for quick disambiguation (`g-2026-05-27-1`, `g-2026-05-27-2`, …).

## Reference seeds + anchors

For A/B comparisons across runs (e.g. before/after a nav-stack change), pin
the anchor explicitly so the post-reset biome probe doesn't reroll the
spawn and pollute the comparison.

| Purpose | Seed | Anchor | Notes |
|---|---|---|---|
| Nav-stack A/B benchmark | `-3899835130120818196` | `-456, 74, 596` | Stable starting point used from `g-2026-05-29-8` onward. Surface biome at y=74 with mining context within ~30 blocks. Used for `--skip-base` mining-first iteration loops while validating the route-precompute nav refactor (see `docs/features/route-precompute-context.md`). |
| Above-ground dungeon | `6833329508037519212` | — | (anchor TBD on probe) |
| Generally good flat build | `-1312751495452676979` | — | |
| Nice all-around map | `2701938` | — | |

Launch example (clean A/B run):

```
scripts/genesis.sh new-run \
  --seed=-3899835130120818196 --anchor -456,74,596 \
  --skip-base --no-confirm
```

## Notes

- This plan **does not depend on** stale `chest_food` / `base_chest` conflicts — reset per run clears them.
- Genesis is independent of plugin rollout; difficulty + snapshots must work via `genesis_lib` rcon/poller alone.
- Steward SOUL edit (Build D) is additive; reverts cleanly.
- `data/genesis-runs/<run-id>/` gitignored by default; `git add -f` interesting snapshot JSONs for posterity.
- Regenerate or extend `docs/mc-cheatsheet.md` if operators need `blueprint` / `region_create` in the cheatsheet (registry already has them).

## Validated against repo (Core v1 ship)

Implemented: genesis CLI/lib/snapshot/diff/poller, seven templates, Steward genesis doctrine, runbook, unit tests under `scripts/tests/`. Still accurate from prior review: kanban parent gating, `mc construct` N/I, `mark-drift.py` N/I, P3 blueprint verify best-effort in `check_phases` (full layer verify remains Steward/`mc blueprint verify`). v1.1 backlog: `watch-rescues`, `genesis_targets.py`, plugin snapshot hook, worker SOUL one-liner, README genesis section.

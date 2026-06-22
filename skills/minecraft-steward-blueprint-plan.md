# minecraft-steward-blueprint-plan

Plan structures from GrabCraft URLs for **steward** on `landfolk-ops` (orchestrator only — workers build).

## Genesis-v2 colony override

If this skill is loaded by `colony-planner` on board `genesis-v2`:

- Use `colony-*` assignees (not `flint`/`mason`).
- Use `scripts/kanban board` and `scripts/kanban card <id>` for orient/read.
- Keep worker cards literal and lease-aware (`mc bot checkout ...` first, `mc bot release` last).
- Do not reference legacy `scripts/board*` helpers in planner runs.

## Trigger: a card with a grabcraft URL lands on your queue

The auto-decomposer is configured to **defer** any card containing a
`grabcraft.com` (or schematic) URL straight to you with `fanout=false` —
it knows it can't decompose a 3D voxel blueprint into useful child cards
without the actual block data. So when you see such a card:

1. **STOP** — do not start a `[SCOUT]` / `[CONSTRUCT]` fanout from the
   LLM-decomposer pattern. The previous chain (`Scout → Mine → Build path
   → Construct schematic`) was vague-by-design because the auto-
   decomposer was guessing. You have the right tool — use it.
2. **Run `scripts/blueprint-plan.py`** (the proper decomposer; wraps
   `scripts/grabcraft_downloader.py` with material substitutions).
3. **Read the plan JSON** to extract: total block count, materials list
   with counts, layer-by-layer cells.
4. **Decompose into discrete, concrete cards** (see "Kanban workflow"
   below). Each child card body includes the resolved anchor, the
   specific block list / fill range for that layer, and the deposit
   chest coords.

## Script

From repo root:

```bash
python3 scripts/blueprint-plan.py "<grabcraft_url>" \
  --out data/ops/plans/<plan_id>-plan.json \
  --plan-id <plan_id> \
  --anchor 359,65,-571 --site :wheat1:/center
```

Raw download only (no plan):

```bash
python3 scripts/grabcraft_downloader.py "<url>" blueprint.json
```

## Defaults

- **`--substitute`** (on): swaps hard-to-source blocks for base-friendly ids (e.g. clay→dirt, stone_bricks→cobblestone, extra wood→oak_planks). Use `--no-substitute` for faithful materials.
- **`--simplify`** (on): drops decorative cells (carpets, flower pots, etc.). Use `--no-simplify` to keep them.

Output JSON includes `materials_planned`, `phases` (by blueprint Y layer), and `cells` (local x,y,z + block id). See `docs/specs/world/blueprints-grabcraft.md`.

## Kanban workflow

1. Read triage `[EPIC]` or `[CONSTRUCT]` card with a GrabCraft URL in the body.
2. **Resolve the anchor FIRST** — either pick coords from existing marks/regions, or `kanban_create` a `[SCOUT]` child and wait for its result. The anchor must be *concrete numbers* (or a known `:region:/site` ref that resolves to numbers) before any downstream cards exist.
3. Run `blueprint-plan.py --plan-id <slug> --out data/ops/plans/<slug>-plan.json --anchor X,Y,Z --site :id:/anchor` once you have the resolved anchor. Commit under `data/ops/plans/` (not `/tmp`).
4. Decompose into worker cards:
   - `[SUPPLY]` / gather materials from `materials_planned`
   - `[REGION]` create + sites for the build pad; add `plan=<plan_id>` on the placemark sign when anchored
   - `[CONSTRUCT]` worker card with the resolved anchor written **into the card body** (see template below — do NOT just reference the scout card)
5. **Per-bot mutex:** promote at most one `[CONSTRUCT]` layer card per worker to `ready`/`running`; park extra layers with `queue-mutex:` blocks. Re-check with `scripts/kanban board` / `scripts/kanban card` before re-triaging blueprint epics.
6. Do **not** mine or place yourself — assign to the appropriate worker profile (`colony-builder` / `colony-gatherer` / etc. in genesis-v2).

## Required handoff pattern: anchor lives IN the child body

**Bug to avoid (Mason's open-ocean trip, 2026-05-24):** if a `[CONSTRUCT]` card body says *"anchor coordinates are available in scout task t_xxx comment"*, the worker won't go fetch them — workers read their OWN card body, not sibling-card comments. They'll either guess from local context or build at the plan's local origin (0,0,0 → wherever they spawned). Result: bot builds in the wrong place, often the open ocean.

**Rule:** every child card the steward creates must include the resolved anchor as concrete coords inside its body YAML. Reference the source scout card for traceability (`source_scout: t_xxx`) but materialize the coords. If the scout hasn't produced an anchor yet, don't create the construct cards yet — link them via `--parent` so the dispatcher waits.

## Card body templates

### `[CONSTRUCT]` card body — anchor + worksite materialized

```yaml
kind: construct
blueprint_url: https://www.grabcraft.com/minecraft/...
worksite: hut3                         # bare region id — worker runs
                                       # `mc task_context set hut3` so the
                                       # bot grants ad-hoc dig/place inside
                                       # :hut3: while this card runs.
                                       # Region intent stays `protect` on disk.
anchor:
  coords: [370, 65, -608]              # REQUIRED — concrete numbers
  site: :hut3:/anchor                  # optional, redundant ref for the worker
  source_scout: t_73af3076             # traceability only — not used at runtime
plan_id: dystopian-hut-3
plan_file: data/ops/plans/dystopian-hut-3-plan.json   # redundant path; prefer plan_id
phase:
  level: 5                              # worker runs verify with --level 5 after layer
supplies_chest:
  coords: [376, 66, -589]              # where SUPPLY cards deposited materials
  mark: farm_supply_chest
plan_options:
  substitute_easy_materials: true
  simplify_decorative: true
```

### `[SUPPLY]` card body — deposit chest materialized

```yaml
kind: supply
item: cobblestone
count: 79
deposit_chest:
  coords: [376, 66, -589]              # REQUIRED — concrete numbers
  mark: farm_supply_chest
  near_anchor: [370, 65, -608]         # context for the worker
# worksite: hut3                       # add if the deposit chest is INSIDE
                                       # a protect region the worker needs
                                       # to enter to deposit
parent_blueprint: t_xxx                # epic for traceability
```

### `[REGION]` card body — region params materialized

```yaml
kind: region
action: create
region_id: ":hut3:"
anchor: [370, 65, -608]
shape:
  kind: column
  radius: 5
  y_min: 64
  y_max: 72
intent: protect                        # default for build sites — protect
                                       # the finished structure. Workers
                                       # building INSIDE this region use
                                       # `worksite: hut3` + `mc task_context`
                                       # to dig/place during construction
                                       # WITHOUT changing intent.
profile: base
sites:
  anchor: [370, 65, -608]              # plus other named sites if known
# Placemark sign line: plan=dystopian-hut-3  (binds mc blueprint verify :hut3:)
```

## Verify-before-narrate and plan drift

Before marking a construct card `blocked` on missing materials, confirm in-world: `mc blueprint verify :region:` (or phase `--level N`). Narrate mismatches (`missing` / `wrong` / `extra`), not guesses from the EPIC comment.

When the player changes the build intentionally, update the committed plan (`blueprint-tool.py adopt-cell` or `mc blueprint adopt` with `HERMES_BLUEPRINT_MUTATORS`) — there is no separate amendments file. Re-verify after adopt.

After running the script, paste `materials_planned` totals and `stats.cells_count` into the EPIC card via `kanban_comment` for human visibility — but the OPERATIONAL data (anchor, chests, region id, worksite, **plan_id**) MUST be inside child bodies, not just in the EPIC's comments.

### How `worksite:` works at runtime

When a construct card has `worksite: hut3` in its body:

1. The worker reads the card on startup and runs `mc task_context set hut3` (uses `HERMES_KANBAN_TASK` for the card_id automatically, default 30-min expiry).
2. The bot's policy guard sees the active worksite and grants `allow_ad_hoc_dig: true, allow_ad_hoc_place: true` inside `:hut3:` for this worker only, on this card only.
3. Other workers, other cards, other regions: still bound by the underlying `protect` intent.
4. Worker runs `mc task_context clear` on `kanban_complete` or `kanban_block` so the grant doesn't leak to the next card.

This is strictly better than the legacy "flip intent to marker then back to protect" pattern: intent stays consistent on disk, grants are per-worker-per-card-time-bounded, no risk of forgetting to relock.

## Anti-patterns

- "Anchor coordinates are available in scout task t_xxx comment" → workers don't navigate sibling comments. **WRONG.**
- "Use mark `:hut3:/anchor`" without also providing the concrete coords → if the mark isn't on this bot yet, worker can't resolve it. **WRONG.**
- Creating `[CONSTRUCT]` cards before the scout has resolved an anchor → workers might be dispatched with a placeholder. **WRONG** — link via `--parent` and let the dispatcher gate it.
- Pasting the plan JSON's full `cells` array into the body → bodies should be small. Reference the plan file path; workers read it from disk.

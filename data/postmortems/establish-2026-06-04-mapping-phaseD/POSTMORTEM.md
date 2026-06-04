# Phase D mapping mission validation — postmortem

**Date:** 2026-06-04
**Mission:** `establishment.mapping` (Phase A/B/C deliverables)
**Seed:** `-32456789431833` (4 distinct biomes: snowy_taiga, snowy_beach, taiga, frozen_river)
**Outcome:** infra **green**; agent commit-behavior **red**
**Personal POIs placed:** 0
**Signs placed:** 0
**Torches placed:** 0
**Duration:** ~7 min of worker time across 2 bootstraps

## TL;DR

The Phase A/B/C plumbing all worked correctly under live conditions — bots
loaded the mapping skill, withdrew bulk signs/torches from the chest, dispatched
1 card per worker, ranged into their quadrants. But across all 3 active workers
(Gatherer, Flint, Mason) running the `deepseek/deepseek-v4-flash:exacto` model,
**zero** `mc place_named_sign` / `mc place_torch` / `mc poi_add` calls were
issued in the entire run. Workers explored, scanned (Mason called `nearby_signs`
once), described terrain in their reasoning, but never committed to *naming*
anything.

This is a model-judgment / prompt-strength failure, not a code or infra failure.

## What worked (validation green)

- ✅ Scenario YAML lints + materializes (seed `-32456789431833`, 4 biomes)
- ✅ `establish-rcon-prep.py --mission mapping` sets the chest correctly:
  - 1 iron_pickaxe, 1 iron_axe, 1 iron_shovel
  - 16 bread, 16 oak_sign, **64 torch**, **32 coal**
  (after the `count:N` NBT fix below)
- ✅ Dusk lighting applied (`time set 13000`, `gamerule doDaylightCycle true`)
- ✅ Starter kit for workers includes 4 oak_sign + 16 torch
- ✅ Catalog JSON for the seed picked up by `scripts/scenario-pools.sh map`
- ✅ `AUTO_REUSE=1` path correctly skips mapcatalog try (avoids known hang)
- ✅ Dashboard auto-start works; `/api/personal-pois` route returns empty array
- ✅ `[MAP:ARENA]` epic seeded with 4 `[MAP] <quadrant>` cards
- ✅ Steward detects the `[MAP:ARENA]` tag and runs the continuous-dispatch loop
- ✅ Worker kanban-worker SKILL includes the [MAP] cards section (after fix)
- ✅ `minecraft-mapping` skill loaded by workers (`--skills minecraft-mapping`)
- ✅ Per-bot personal POI store wiped at bootstrap (no leakage from prior runs)
- ✅ Personal POI HTTP endpoint live on every bot (`GET /personal-pois`)
- ✅ Workers called `mc nearby_signs 32` (Phase A5 verb works end-to-end)
- ✅ Workers withdrew supplies from chest (Mason: 16 signs + 32 torches)
- ✅ Workers reached their quadrants (Mason at (42,65,35) SE; Flint at NE; Gatherer corrected to NW)

## What didn't (validation red)

### Primary issue: workers don't commit to placements

**Pattern across all 3 workers:**
- Calls `mc scene` / `mc look` / `mc nearby_signs` to scan
- Describes terrain in reasoning: "sandy beach with sandstone transition",
  "ledge to south", "spruce forest"
- Says in reasoning: "Let me explore more and find landmarks"
- Calls `mc goto` to a new position
- Loops back to scan

**Never calls** `mc place_named_sign`, `mc place_torch`, or `mc poi_add`.

This pattern is the model treating the landmark selection as a search problem
("find the *right* landmark") instead of a commit-action problem ("name what
you see and move on"). The current skill says:

> "Use creative free-form names ('spider hill', 'balders ruins'). No mandatory
> prefixes. Descriptiveness > formality."

That's permissive but not directive. The model reads it as "find something
worth naming" and never finds the *worth* threshold.

### Secondary: round timeouts truncate exploration

All 3 workers hit `exit_code=142` (round wall-clock timeout) at ~4 min into
their first round. With a 600s default `ORCHESTRATOR_ROUND_TIMEOUT_S`, that's
suspicious — they ran ~240s, not 600s. Worth checking whether deepseek's
context window fills during the long scan loops and the process exits via
a different path that LOG-formats as `exit=142`.

### Tertiary: navigation hazards on snowy seeds

Flint got stuck on the frozen river ice at ~(50, 63, -20). Pathfinder treats
ice as standable but won't path across it. She iterated trying alternative
routes. By the time she would have placed anything she had timed out.

### Tertiary: Gatherer used fleet-mark vocabulary

Gatherer ran `mc mark lt_wood_se` at (22, 67, 3) — that's the **fleet-mark**
prefix convention (`lt_*` = "lookout / point-of-interest" from explore mission),
which `minecraft-mapping.md` explicitly says is reserved:

> "Personal POI vs fleet mark — different stores. ... Do not put mapping POIs
> in mc mark — the prefix convention is reserved."

Skill text was in her catalog but she defaulted to the legacy verb under load.

## Mid-run fixes shipped (4 plumbing bugs caught during this run)

### Bug 1: `skills/MANIFEST` missing `minecraft-mapping`

`landfolk deploy` syncs gaming/ skills by reading `skills/MANIFEST`. The new
Phase C1 skill was authored but not added to the manifest, so it wasn't
synced to any agent_home. **Fix:** added `minecraft-mapping` line to manifest.

### Bug 2: stale `kanban-worker` SKILL in agent_homes

The user-dir + per-profile copies of `kanban-worker/SKILL.md` were current (752
lines). But `~/.hermes-landfolk-<bot>/skills/devops/kanban-worker/SKILL.md` was
**184 lines** — the pre-Phase-C3 version without the `[MAP]` cards protocol
section. `install_kanban_worker_skill` in `setup-landfolk-profiles.sh` doesn't
touch `~/.hermes-landfolk-<bot>/` paths. **Fix:** synced all 7 agent_homes
manually. **Follow-up:** add agent_home sync to `install_kanban_worker_skill`.

### Bug 3: chest NBT used pre-1.20.5 `Count:Nb` syntax

`establish-rcon-prep.py` filled the mapping chest with NBT like
`{Slot:5b,id:"minecraft:torch",Count:64b}`. Under MC 1.20.5+ the field is
`count:N` (lowercase int, no `b` byte suffix). The parser silently dropped
`Count` and defaulted to 1, so the chest held 1 sign + 1 torch + 1 coal.
**Fix:** rewrote NBT to `count:N` lowercase; updated B5 unit tests; verified
in-world (4 of 16 signs and 16 of 64 torches consumed by workers; chest
counts now reflect real withdrawals).

### Bug 4: test contamination at (0, 100, 0)

While debugging the NBT format, I ran `setblock 0 100 0 minecraft:chest replace`
on the live world. That block survived the next `reset-proc-lab.py` cycle and
the surface probe latched onto it at Y=101, then the neighborhood scan
correctly refused to /fill at a (presumed) cliff. **Fix:** cleared the block
before bootstrap.  **Process lesson:** don't `setblock` on the operational
world for debugging — use a throwaway like `testflat`.

## Notable behavioral observations

### Steward's `[MAP:ARENA]` rubric is working

The Phase C2 rubric is in `prompts/landfolk/steward.md`. She:
- Detected `[MAP:ARENA]` in the open epic
- Ran the continuous-dispatch loop
- Tried to assign 1 card per worker (mistakenly assigned 2 to two workers,
  then archived 2; this is a Steward-judgment issue, not a rubric bug)
- Course-corrected Gatherer via kanban comment when she ranged the wrong way
- Avoided assigning anything to herself
- Did not invent phantom worker names (Phase 17 rule held)

### Two-claim race

After Steward assigned 2 cards each to Flint and Gatherer, the dispatcher
spawned 2 hermes processes per worker (one per claim). The two processes
fought over the bot's pathfinder. This is a real dispatcher bug worth tracking
separately — the dispatcher should refuse a second claim against an already-
running worker.

### `exit_code=142` cluster

3/3 workers exited round=1 with code 142 at ~4 min. The lifecycle then held
round=2/3 with `kanban_held: skipped (active kanban task — sleeping 60s)`.
But the kanban-task hermes processes were *still alive* — they kept iterating
exploration. So the agent-loop log entries are misleading; the workers' real
state is on the kanban-task processes, not the agent-loop ones.

## Recommended next steps before Phase D rerun

In priority order:

### (1) Tune `minecraft-mapping.md` for commit-now bias — **DONE post-run (2026-06-04)**

Reframed the skill from "place markers" to "**map the world with light** — a
shared, visible deliverable". Operator-supplied framing folded in:

- **Torches = a promise of safety.** When a worker places a torch, they're
  claiming the path leading to it is cleared (`mc dig` lips) and smoothed
  (`mc build_stairs` over jumps). The next worker can trust a torch trail
  to be walkable.
- **Torches are the human player's progress view.** Under dusk lighting,
  a string of torches along a ridge is how re44 sees what the fleet's
  doing — the only at-a-glance visibility into the run.
- **Signs are chapter headings.** Evocative names, not generic ("balders
  ruin" not "stone formation 1").
- **First-action checklist** added: status → nearby_signs → place_named_sign
  within 90 seconds. "If you've scanned twice and still feel you haven't
  found a landmark, commit on the second scan."
- **The torch trail = a tested route.** Don't torch a path you couldn't
  backtrack on; smooth bumps with `mc build_stairs <block> <dir> 4`.

Steward's `[MAP:ARENA]` rubric in `prompts/landfolk/steward.md` got a
matching reframe — "Workers are storytellers", "You are the editor",
plus dispatch hints that mention torch-as-tested-route ("Light a path the
next worker can walk back on").

Skills + prompt synced to all 4 active agent_homes.

### (2) Manifest deploy ergonomics

`landfolk deploy` should re-read the MANIFEST and refresh all agent_homes
(not just `~/.hermes/skills/`). Add a step to `install_kanban_worker_skill`
that mirrors to `~/.hermes-landfolk-<bot>/skills/devops/kanban-worker/SKILL.md`.

### (3) Investigate the `exit_code=142` truncation

If workers reliably exit ~4 min in regardless of `ORCHESTRATOR_ROUND_TIMEOUT_S`,
we may be hitting a different cap (deepseek context window? hermes round token
budget?). Trace the actual exit signal vs `142` reporting.

### (4) Steward rubric clarification: 1-card-per-worker

Add to the `[MAP:ARENA]` section of `prompts/landfolk/steward.md`:

> "Assign exactly **one** [MAP] card per assignable worker per cycle. If you
> have 3 workers and 4 cards, leave one in READY for the next cycle. Never
> assign 2 cards to the same worker — the dispatcher will spawn 2 hermes
> processes against the same bot and they will fight over the pathfinder."

### (5) Fleet-mark vs personal-POI separation reminder

In the [MAP] card body (template), prepend a one-line reminder:

> "**Reminder:** use `mc poi_add` not `mc mark`. Fleet marks (`lt_*`,
> `chest_*`, `base_*`) are reserved for the establish mission."

### (6) Don't promote a snowy seed without ice-aware navigation

Seed `-32456789431833` has frozen rivers right next to spawn (~50 blocks E).
The pathfinder treats ice as standable but can't path across it. Either:
- Pick a non-snowy seed for the first successful Phase D run
- Or improve `mc move`'s ice-handling (existing follow-up)

## Files captured in this postmortem

- `agent-{flint,gatherer,mason,steward}.log` — reasoning logs
- `mc-{flint,gatherer,mason,steward}.log` — CLI call audit
- `hermes-{flint,gatherer,mason,steward}.log` — round / plan summaries
- `nav-{Flint,Gatherer,Mason,Steward}.jsonl` — structured nav errors
- `bot-{flint,gatherer,mason,steward}.log` — Mineflayer connection/chat
- `progress-{flint,gatherer,mason,steward}.log` — watchdog JSONL
- `watchdog-{flint,gatherer,mason,steward}.log` — watchdog lifecycle
- `dispatcher.log`, `gateway.log` — kanban dispatch
- `final-board.txt` — kanban state at fleet-stop

## Status of the Phase A/B/C deliverables after this run

Treat as **green for shipping**, **yellow for usefulness**:
- Phase A (bot verbs + POI persistence): all surfaces work end-to-end in production
- Phase B (scenario YAML + bootstrap + grader): full pipeline executes
  cleanly after the count:N NBT fix
- Phase C (prompts + skills + runbook): Steward rubric proves out; worker
  protocol section deploys correctly after the MANIFEST + agent_home sync
  fixes; **but** the prompt text isn't strong enough to drive commitment
- Phase A4.1 (dashboard): live at <http://127.0.0.1:3000>; `/api/personal-pois`
  returns the (empty) POI list

The next Phase D attempt should fix items (1) and (2) above, then re-run.

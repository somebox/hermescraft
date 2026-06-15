# genesis-v2 devlog

Running record of what we learned driving the genesis-v2 colony integration test
(procworld stack, specialist agents + body pool). Newest entries on top.

Related: [target architecture](../architecture/target.md),
[designated regions spec](../specs/world/designated-regions.md),
[genesis runbook (legacy core v1)](../guides/genesis-runbook.md).

---

## 2026-06-15 — agent feedback round (synthesis)

Asked each agent (bot-less `[FEEDBACK]` card) to review its genesis-v2 cards and
report WORKS / NEEDS-IMPROVEMENT / IDEAS. Returns from all six roles (scout,
gatherer, builder, farmer, miner, planner). Independently corroborates the diagnoses
above and adds concrete execution-layer bugs.

### Confirmed by multiple agents
- **Region-protected shelter traps bots** — gatherer ("single biggest failure",
  ~40 min wasted), builder, miner. Plus: **`mc escape` is broken**
  (`pos.floored is not a function`) and **`mc pillar_up` returns POLICY_DENY**
  inside the protect region — so the in-region self-rescue path doesn't exist. Top
  priority; validates the door-blueprint + region-lifecycle + worksite fixes.
- **Body contention (`no_free_body`) is the #1 throughput bottleneck** — scout:
  **15 of ~20 sessions blocked**; 3 bodies shared across all roles starves every
  queue, and each block **wastes a full agent spawn** (skill load + kanban + memory
  read) for zero world output. → dispatch should gate on body availability
  (don't spawn a worker that will immediately block), and/or grow the pool / batch
  cards. Ties to the dispatcher concern in the operational-layer research.
- **Card coords not standable** — scout: cards gave spawn/site coords inside
  structures or on unstandable terrain (e.g. 0,65,0; 64,83,-96). Coords in card
  bodies must be validated standable (matches the spawn-probe findings).
- **Navigation unreliable** — scout (`mc goto` NAV_FAILED/timeout), miner
  (pathfinder failures), builder (door placement timeout). Recurring execution-layer
  reliability gap.
- **Duplicate + oversized cards** — farmer: two identical farm cards dispatched
  minutes apart (planner should dedup in-flight cards); a **9×9 (81-block) farm at a
  waterless base** with no `till_area` in the spec — oversized + mis-sited. Matches
  the "start small" sizing + farm-needs-water points.

### Planner (orchestrator) adds
- **One admin issue blocked 3 cards across 2 phases** — the region-trap at
  base_anchor stalled roof-patch + mine-supply + water-supply. Single point of failure.
- **No fast-path for admin-only blockers** — SUPERVISE is the wrong tool when the
  answer is "operator must edit region protection"; the planner kept re-investigating
  (**10 supervise cycles on one card**). Confirms the escalation cap (now 3) and argues
  for a distinct **needs-operator** terminal state that pings the human, not churn.
- **Prerequisite chains not enforced** — the water-supply card was spawned before its
  inputs could exist (water bucket ← 3 iron ← a mine, none present). The planner must
  not emit a card whose inputs can't exist yet; sequence water *after* iron/mine.
- **Checkout coords vs. actual base** — cards used the seed spawn (258,79,-53) but the
  base settled at (223,80,-15); workers reconciled mid-run. Bind cards to the
  `base_anchor` mark, not the spawn coord.
- **Validated**: the decomposition model (epic → 2-4 specialist cards), `after:`
  sibling chains (no deadlock), and the **retry pattern** (block stale card → new card
  same spec) — that's how BUILD recovered.
- Self-reported counts: **160 cards / 55 done / 9 blocked**; top blockers =
  region protection, no iron for water bucket, bot trapped in shelter. (160 cards is
  itself a churn signal — supervise + retries + dupes across the run series.)

### Validated — what WORKS (don't regress)
- **Literal `mc` verb lines in cards** — farmer: "the single best thing in the card
  design… no ambiguity, no improvisation." Echoed by gatherer.
- **Lease checkout/release + `--cap` filter** — clean when a body is free.
- **Structured handoff metadata in `kanban_complete`** (scout, farmer) — downstream
  verify without re-reading.
- **Batch verbs** (`mc collect N`, `till_area`); **scout handoff template** +
  **WATER_DROUGHT flag**; **chat narration**; **crafting wooden-vs-stone diagnostic**.

### New concrete bugs to fix (agent-sourced)
1. **`mc escape` — `pos.floored is not a function`** — Report not reproduced on the
   current escape handler (`bot/lib/actions/queries/escape/`); `mc dig` already uses
   `Vec3` for `blockAt`. Same symptom was fixed elsewhere (sail_to, v22). Residual
   risk: `escape/strategies.js` still calls `b.blockAt({x,y,z})` with plain objects
   — align with `Vec3` and capture a live stack if the TypeError recurs.
2. **`mc mark --at`** — No CLI/parser regression found (`parseMarkFlags` + tests in
   `mark-at.test.js` / `mark-soft-warn.test.js`). Run-time failure mode is usually
   **omitting `--at`** (mark saves at bot feet → `MARK_NO_AT_COORD_IN_NOTE`) or HTTP
   bodies with flat `x/y/z` instead of nested `at: {x,y,z}` (`locations.resolvePlace`).
   Fix path: planner/card templates always emit `--at` on remote coords; optional
   hard-fail in `mc mark` when note contains a coord triple and `--at` is missing.
3. **Body-pool contention** — **Verified:** workers block with `no_free_body`; poller
   only **requeues** deferred cards via `_free_body_count()` (`genesis2_lib.requeue_deferred`).
   Hermes dispatcher still spawns agents with no pool check → wasted turns. Fix path:
   gate dispatch on `mc bot status --pool` (free ≥ 1) or poller `blocked` on ready
   lease cards while `free == 0`; grow pool / batch cards as ops mitigation.
4. **Card coords standable** — **Verified gap:** `scripts/lib/card_body_linter.py`
   requires `mc` verb lines but does **not** call `mc reachable` / standability.
   Spawn probe checks biome/flatness/wet feet, not card target cells. Fix path: at
   card emit (planner or `kanban add` lint), reject or rewrite coords where
   `target_standable` is false; use `best_stand` in the card body.
5. **Door placement timeout; nav flakiness** — Door flake **confirmed** for N/S closed
   doors (`tests/functional/test_door_pathfind.py`, xfail). E/W shelter rule in devlog
   is the right mitigation. `mc goto` timeouts are a broad pathfinder/reliability class
   (preflight + `closest_standable` hints exist); track per-postmortem, not one quick fix.

### Verification notes (code review 2026-06-15)

**Shelter trap + in-region self-rescue (confirmed in code, not just agent narrative).**
- `genesis-v2.sh` calls `wipe_marks()` only — **`data/regions-world.json` is not reset**
  on new-run (contrast `scripts/genesis_lib.py` template render). Stale protect regions
  can accumulate.
- **`mc escape` / `mc pillar_up` inside a protect region:** `enclosure_inside` auto-dig
  uses `mc dig --force`, but `dig.js` **still returns `REGION_PROTECTED`** (no
  `forceEscape` bypass on region deny). Trapped branch calls `pillar_step` without
  `--force`; headroom dig uses `shouldSkipDigAt` → **`POLICY_DENY`** unless
  `force && isGenuinelyStuck()`. **`shouldSkipPlaceAt` has no escape bypass** (place
  path is separate). Net: policy blocks self-rescue inside protect even when the trap
  is the colony's own sealed shelter.
- **Fix path (ordered):** (1) door-bearing blueprint + correct region geometry (primary);
  (2) reset/template `regions-world.json` per run; (3) wire `mc task_context set` /
  `worksite:` on BUILD cards (today only illustrated for mine in `phase-epics.yaml`);
  (4) optional belt: extend `forceEscape` to `enclosure_inside` + genuinely-stuck
  `pillar_up` when `WORKSITE_GRANT` is active — do not rely on this instead of doors.

**Duplicate / oversized farm cards** — Not enforced in genesis templates or poller;
  dedup and farm sizing remain **planner / overseer** responsibilities (devlog sizing
  rules are correct; no code gate yet).

**What still WORKS** — Agent praise for literal `mc` lines, lease defer/requeue pattern,
  and handoff metadata matches existing templates and `genesis2_lib` behavior.

---

## 2026-06-15 — operational layer & phase sizing (research)

> target.md defines the **roles** (planner / dispatcher / execution / overseer) and
> the **card-flow**, but is thin on the **operational dynamics** — *when/how often*
> each agent engages, *what board signals* trigger which agent, and how readiness is
> guaranteed across the lease pool. That operational layer is the next research area.

### Phase sizing — start small, wall later
- The base starts **small**: a shelter building + chests nearby, ~**10×10** footprint.
- **Walls come later and sit farther out** (a defensible perimeter ring), which feeds
  back into:
  - **base location** — pick a site with room to expand the wall ring, and
  - **leveling** — clear/level the *larger* wall footprint, not just the building pad.
- **First farm: near water AND close to base — but the base need not be next to
  water.** Water is a *farm* constraint, not a *base* constraint. The planner should
  read this straight from the requirements (don't force the base onto the shoreline).

### Tool/material readiness across lease handoffs (operational requirement)
The lease pool **decouples expertise (agent) from inventory (body)**. A body that
just finished one task may be poorly equipped for the next mission a *different*
agent leases onto it — tools don't follow the worker, they sit in whatever body had
them. Consequences for card breakdown:
- **Tools live in shared base chests**, never assumed in a body's inventory.
- **Every card's first step is a precondition check** — "withdraw/equip the needed
  tool from a chest, or craft it" — not "assume I have a pickaxe."
- The **crafter agent maintains a standing tool stock** in chests (spare
  pickaxes/axes/shovels) + material buffers, so any leased body can equip before its
  mission. (This is why the roadmap's standing goals include a *spare tool stock*.)

### Multi-agent board scanning (not just the planner)
Generalize the supervisor we built (poller → planner on stalls) into a **periodic,
multi-agent operational layer** — each agent scans the board for *its* concern:
- **crafter** — scans cards + chest inventories for material/tool gaps; pre-stocks
  tools/materials so downstream cards aren't blocked on a missing pickaxe.
- **builder** — reviews cards that need better build planning (vague "build shelter"
  → a sized, E/W-door, blueprint-backed card).
- **overseer / verifier** — verifies completion + catches structural defects (door
  faces E/W? farm hydrated? chests accessible?).
- **planner** — decomposition + roadmap ordering.

So the board is a shared substrate that several specialist agents *read and improve*,
not a pipeline only the planner touches. Each wakes on a relevant board signal or a
cadence, contributes its expertise, and exits — same fresh-scope discipline as
execution cards.

### Open research questions (the operational gap)
1. **Triggers & cadence** — what board signal wakes which agent (event vs. periodic
   sweep), and how often, without burning tokens.
2. **Concern → agent mapping** — crafter/builder/overseer scan filters; what each is
   allowed to change on a card it didn't create.
3. **Readiness guarantee** — where the "ensure tools/materials before a mission"
   check lives (card-template precondition vs. crafter pre-stock vs. dispatcher).
4. **Anti-thrash** — coordination so multiple scanners don't fight (escalation caps,
   ownership of a card, idempotent edits). We already hit runaway churn once.
5. **Where this lands in target.md** — promote the operational layer from implicit to
   a documented section (role table is static; operations are dynamic).

---

## 2026-06-15 — base & shelter spec + planner roadmap (operator requirements)

### Door facing — bot traversal limitation (MUST be in the shelter spec)
mineflayer-pathfinder's "open the door and walk through" is **reliable for
EAST/WEST-facing doors but FLAKY for NORTH/SOUTH-facing closed doors** — a
documented framework limitation (`test-door-pathfind.py`, the 4 N/S closed cases
are `KNOWN_FRAMEWORK_LIMITATIONS`/xfail). On a N/S door the bot opens it
(`door_now=open`) but then stalls ~5-6 s without committing to the path through the
open cell; the pathfinder timeout fires and it ends touching the wall's outer face.
Suspected race between the door-open action and pathfinder's path re-evaluation.

**Shelter spec rule:** shelter/base **doors MUST face east or west.** Place the
doorway so the door's `facing` resolves to E/W; never rely on a N/S-facing door for
routine traversal. (Revisit if the upstream pathfinder race is fixed.) This pairs
with the door-bearing blueprint requirement — the blueprint must orient its door E/W.

### Base site
- A **leveled, cleared** footprint (flat ground, obstructions removed) so it can
  later be **walled** to control mob approach — a defensible, gated perimeter.
- Shelter from a **deterministic, door-bearing blueprint** (E/W door), not LLM
  free-build (see the trap diagnosis above).
- **Supplies/chests easily accessible** — near the entry/work area, organized per
  resource (wood / stone / food / tools), not buried inside a sealed room.

### Base-location selection (what scouting is for)
Choosing the base site is a real optimization, informed by scouting:
- **Water access** for farming (surface water / pond within ~N blocks), and/or
- **Route access** (good corridors to resource clusters + room to expand).

P1 scouting gathers candidate pads + resource/water marks to make this call.
**Scouting does not stop after P1** — it continues throughout the run to find new
resource areas, water, and expansion sites as the colony grows.

### Planner roadmap
The planner should work from a **roadmap** — an ordered, goal-driven guide rather
than rigid one-shot phases (ties into the gating section below):
- **Essentials first:** base (leveled + walled-capable) → tools → food → storage.
- **Then expansion:** mine, roads, more farm/storage, perimeter walls, new sites.
- **Standing goals kept topped up continuously** (not once):
  - **food** stock,
  - **building materials** (wood, cobblestone) stock,
  - **tools** — maintain a healthy *spare* stock (pickaxes/axes/shovels), not a
    single set; tools wear out and workers need replacements on hand,
  - chests organized + accessible per resource.

The roadmap orders *intent*; the planner emits parallel work as prerequisites allow
(see gating). "Phases" are roadmap milestones for reporting, not execution walls.

---

## 2026-06-14/15 — first sustained run series (runs gv2-...-8 → -13)

### What got validated (keep)
- **P1 completes end-to-end** (scout → base-select → gather → build → 2 chests).
- **Poller-authoritative phase advance + anti-cascade**: epics P2..P5 seeded
  `blocked` (parked); the poller completes a phase's epic and unblocks the next
  ONLY when the real world-gate passes. A planner/worker finishing its turn early
  can no longer cascade phases. Proven by `scripts/test-phase-transitions.py`
  (no-agent transition test).
- **Crafting window-race retry**: `b.craft` silently no-ops ~1-in-5 for table
  recipes (no PaperMCP fallback on these bodies); in-process retry fixed it.
- **Supervisor (planner re-engagement)**: the poller detects stuck workers
  (running too long OR blocked for a substantive reason) and files a
  `[SUPERVISE]` card so the planner intervenes; escalations capped per worker.
- **Spawn quality gates**: reject water/frozen/desert/mountain spawns
  (`execute if biome` + flatness sampling); `--spawn X,Y,Z` operator override.
- **Marks → shared reconcile** in the poller loop; deferred-worker requeue.

### Why the proven base-protection + shelter didn't land here
Legacy genesis (core v1) was **deterministic + templated**; genesis-v2 swapped
that for LLM free-building and dropped the supporting machinery. The protect
*mechanism* worked (it denied digging, as designed) — but its companions did not,
so the shelter became a worker trap.

1. **Shelter: deterministic blueprint → LLM free-build.**
   Legacy renders `data/ops/plans/hut1-guard-tower-plan.json` — a 238 KB blueprint
   with **34 `oak_door` blocks** + 618 air cells, placed identically every run
   (`plan_id`, footprint, materials). Real doors = guaranteed egress.
   genesis-v2's BUILD is an LLM agent free-building from prose ("5×5 walls + roof,
   leave a 1-block doorway"); it produced a **sealed, doorless box**. No blueprint,
   no `mc construct`/`mc blueprint`.
2. **Protect region: templated geometry → ad-hoc + never reset.**
   Legacy renders `regions-world.template.json` at boot. genesis-v2 has no regions
   template; `genesis2_lib` only **reads** `regions-world.json` and `wipe_marks`
   never clears it → regions are created ad-hoc at runtime AND accumulate across
   runs (stale `hut1`/`shelter`). The protect region wound up enclosing
   `base_anchor` (the universal nav target) with no usable egress.
3. **No worker-egress escape hatch.** designated-regions §1.8 (`worksite:` +
   `mc task_context set` → `WORKSITE_GRANT`) is never wired in genesis-v2 cards, so
   a worker sealed inside a protect region can't dig out either. Legacy got away
   without it because the doors gave physical egress.

**Net:** a protect region is safe around a structure-with-doors and a trap around
an LLM-sealed box. genesis-v2 kept the lock and removed the door.

**Fix direction**
- Build the shelter from a **deterministic door-bearing blueprint** via
  `mc construct`/`mc blueprint` + `plan_id` (port hut1 or a small plan), not LLM
  free-build.
- **Template + reset** the protect region per run (correct geometry, positioned so
  base_anchor work happens *through* a door, not sealed inside); clear
  `regions-world.json` on `new-run` (**verified:** `genesis-v2.sh` only wipes marks;
  port `genesis_lib` template render or delete+seed on `new-run`).
- Wire `worksite:`/`task_context` on cards that legitimately edit inside a protect
  region (belt-and-suspenders egress per the spec). **Verified gap:** BUILD/shelter
  cards do not set task context; escape/pillar/dig stay region-blocked without it.
- **Self-rescue policy:** `mc dig --force` does not bypass region protect
  (`dig.js` `runPreDigGuards`); treat operator `/tp` or worksite grant as the hatch
  until blueprint+door fixes remove the trap class.

### Other environment findings
- **Dry spawn**: flat+temperate isn't enough; plains can lack surface water within
  48 blocks, and a bucket needs iron (P3). P2 farming then can't complete. Add a
  **water-proximity** criterion to spawn selection, OR let the planner source
  water (dig-to-water / relocate farm), OR relax the P2 farm gate.
- **Supervisor runaway churn**: a structurally-stuck worker (admin-needed) drove
  31 supervise cards before the cap was added. Lesson: any escalation loop needs a
  budget/cooldown + an explicit "parked for operator" terminal state.
- **Live mid-run relocation only half-works**: moving bodies doesn't move the work
  — seeded cards bake in the spawn coords. Re-anchoring needs a board re-seed (or
  the `--spawn` override at boot).

---

## Open design issue: phase gating over-serializes the fleet

**Symptom.** The 5-phase chain (P1→P5), plus the planner's intra-phase dependency
chains, leave bots idle. Example: in P1 one scout explores while two bots sit
idle — they *could* be gathering wood/stone for the shelter, which doesn't depend
on the scout result at all.

**Root.** The gate conflates two different things:
- *"Phase complete"* — a real milestone (base exists, mine open), worth gating on.
- *"Permission to do any later work"* — which the current design also gates on, and
  shouldn't. Much "later" work has no real dependency on the current phase finishing.

So we serialize on **phase boundaries** when we should serialize only on **data
dependencies** (does this card's input — a mark, a material, a site — exist yet?).
A protect/gate that blocks *nonsense ordering* (mining with no pickaxe) is good; one
that blocks *independent parallel work* (gather wood while scouting) wastes the fleet.

**How to relax it (incremental → target):**
1. **Parallelize within a phase (cheap, now).** The planner should emit a parallel
   DAG, not a serial chain. P1: `scout`, `gather_wood`, `gather_stone` all dispatch
   immediately; only `base_select` waits on scouts, and `build` waits on
   (base_select AND materials). Today's decomposition chains everything → idle bots.
   This is a planner-instruction + dependency-wiring change, not a gate removal.
2. **Let phases overlap where safe (medium).** Replace the hard "P(n+1) blocked
   until P(n) gate" with **card-level readiness**: a card is ready when *its own*
   prerequisites exist, regardless of phase. P2 water-scouting can begin during P1.
   Keep the world-gate only as the *phase-complete signal* (for reporting / the
   overseer), not as a wall on starting prerequisite-met work.
3. **Goal-driven planning (target).** Per [target.md](../architecture/target.md):
   the **planner** plans continuously against colony goals + world state and emits
   intents; the **dispatcher** binds them to free bots; the **overseer/verifier**
   judges goal satisfaction. "Phases" become reporting groupings, not execution
   gates. The fleet is filled by available work, not drained by sequential walls.

**Keep the anti-cascade win.** Whatever replaces hard gates must preserve the
property the poller-authoritative design gave us: *a phase/goal is only declared
done when the real world-state confirms it* — narration/turn-completion must never
advance the colony.

---

## Architecture alignment: drop "Steward"; it's not an agent

[target.md](../architecture/target.md): **there is no Steward orchestrator.** The
concerns split into distinct profiles:

| Concern | Target agent | genesis-v2 today |
|---|---|---|
| Planning (goals → intents/cards) | `@planner` | folded into `colony-steward` |
| Allocation (bind work to free bodies) | `@dispatcher` | the bot-lease pool (close, but implicit) |
| Execution | `@navigator`/`@miner`/`@builder`/… | `colony-scout`/`gatherer`/`builder`/… ✓ |
| Review / verify | `@overseer` (+ verify) | **missing** |

Changes for future runs:
- **Rename `colony-steward` → `colony-planner`** (it does planning/decomposition).
  "Steward" is neither an agent role in the target nor a character. (In progress.)
- **Make dispatch explicit.** The bot-lease pool already does dispatcher-style
  binding (nearest/free body); name it and treat it as the `@dispatcher` concern
  rather than burying it in worker SOULs.
- **Add an overseer/verifier concern.** Today the *poller* is the only verifier
  (world-gate checks). A `@overseer` agent should judge phase/goal completion and
  do per-card verify (e.g. "did BUILD actually leave a door?", "is the farm
  hydrated?") — catching exactly the shelter-trap / dry-farm classes before they
  stall the colony. The poller stays the deterministic gate; the overseer adds
  judgment the gate can't encode.

---

## Prioritized improvements for the next run

1. **Door-bearing shelter blueprint** (kills the trap class). Deterministic
   `mc construct`/blueprint with a door, not LLM free-build.
2. **Region lifecycle**: template + per-run reset of `regions-world.json`; wire
   `worksite`/`task_context` on BUILD cards (not only mine examples in templates).
3. **Execution self-rescue vs region policy** — verified: `mc escape` auto-dig and
   `pillar_up` headroom dig hit `REGION_PROTECTED` / `POLICY_DENY` inside protect
   without worksite/`--force`+`forceEscape`; fix trap class first, then optional
   policy alignment.
4. **Dispatch body gate** before spawn (`mc bot status --pool`); complements
   `requeue_deferred`.
5. **Card coord standability** at emit (`mc reachable` / `best_stand` rewrite).
6. **Parallelize the P1 decomposition** (gather ∥ scout); gate cards on data
   dependencies, not phase walls.
7. **Spawn water-proximity** — `probe_natural_spawn` does not require nearby surface
   water today; add criterion or planner water-sourcing.
8. **Rename steward → planner**; name the dispatcher concern; add overseer/verify +
   in-flight card dedup (farmer duplicate-farm report — no code gate yet).

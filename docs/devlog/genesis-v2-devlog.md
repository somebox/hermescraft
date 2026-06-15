# genesis-v2 devlog

Running record of what we learned driving the genesis-v2 colony integration test
(procworld stack, specialist agents + body pool). Newest entries on top.

Related: [target architecture](../architecture/target.md),
[designated regions spec](../specs/world/designated-regions.md),
[genesis runbook (legacy core v1)](../guides/genesis-runbook.md).

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
  `regions-world.json` on `new-run` (currently never reset → stale accumulation).
- Wire `worksite:`/`task_context` on cards that legitimately edit inside a protect
  region (belt-and-suspenders egress per the spec).

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
   `worksite`/`task_context` for in-region edits.
3. **Parallelize the P1 decomposition** (gather ∥ scout); gate cards on data
   dependencies, not phase walls.
4. **Spawn water-proximity** criterion (or planner water-sourcing).
5. **Rename steward → planner**; name the dispatcher concern; add overseer/verify.

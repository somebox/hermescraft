# Fair-play charter — what the bot may sense and do

> Status: charter adopted 2026-06-13. Names the model already embodied in `bot/lib/runtime/fair-play.js`; constants live in `bot/lib/runtime/fair-play-constants.js` (the `FAIR_PLAY` object). This doc owns the **geometry/perception** rules. It does **not** redefine *where* enforcement happens — that is the verb layer, per [`../specs/agent/scripting-layer-dsl.md`](../specs/agent/scripting-layer-dsl.md) ("the verb layer is the enforcement boundary; code calls through handlers, never raw mineflayer beneath them").

## The principle

**Parity, not advantage. Compensation, not omniscience.**

A bot is a player with a robot's body: it cannot glance around, cannot resolve a scene at a look, and is effectively blind while executing a command. To reach rough parity with an attentive human we grant it **sensor compensations** — but only enough to close the gap, never to exceed it.

The single test for any sensor or cheat:

> *Would an attentive human player, standing exactly here, right now, plausibly have this information?*

- **Yes** → it is **compensation**. Grant it.
- **No** → it is a **superpower**. Deny it, or cap it until the answer is yes.

Parity is multi-axis: **spatial** (range / line-of-sight), **temporal** (reaction time), **informational** (contents / identity). All three are defended.

## Two regimes: sensing vs acting

The bot may **know more than it can see**, but may only **act on what a human could do from where it stands**.

- **SENSING / planning** — "where can I stand, is the corridor clear, is there a chest nearby." Privileged world reads are allowed here; this is the compensation for being summary-fed and blind-while-busy. Tag results **`seen` vs `inferred`** (per scripting-layer-dsl) so honesty is explicit.
- **ACTING / enforcement** — "open this chest, dig this block, hit this mob." Held to human-equivalent constraints: real line-of-sight, real reach, no acting through walls. This is where fair-play **restricts**.

**Boundary rule (load-bearing for navigation):** when you *plan a stance for an action*, plan it against **that action's own enforcement predicate**, not a separate planning raycast. `goto_near`'s LOS stand-pick already does this — it selects cells using the fair-play `hasLineOfSight`, the same gate the chest/dig/interact handlers enforce at act-time. A stance picked against a looser predicate would arrive and then be refused.

Corollary: `mc reachable` is **geometry-only** (can a body stand/path here) — it is **not** a harvest/container LOS oracle. Don't treat "reachable" as "interactable." See [`../specs/nav/route-precompute-context.md`](../specs/nav/route-precompute-context.md).

## The ledger (what the code actually grants)

**Disabilities** (where the bot is worse than a human): no peripheral vision; blind while moving/acting; no scene gestalt (text summaries, not a glance); no startle reflex.

**Compensations granted** (each closes one gap, with a tuned ceiling in `FAIR_PLAY`):

| Compensation | Closes | Ceiling |
|---|---|---|
| Virtual yaw-pan scan (`SCAN_YAW_PANS`) | no peripheral vision | limited block range |
| Sound events (`SOUND_*_RADIUS`) | "a human hears the zombie" | radius by activity (sneak 1 … mine 16) |
| Proximity sense (entity `< 3` always detected) | "you'd feel something right next to you" | 3 blocks |
| Privileged world reads (`terrain_top`/`scout`/`reachable`) | "a human could look and infer the cave / the path" | sensing-only |
| Foliage-transparent harvest LOS | "a human sees the log behind leaves" | foliage only |

**The superpower line (enforced ceilings):** entities LOS-gated, capped at `LOS_ENTITY_RANGE` (48); sneakers only within `SNEAK_DETECT_RANGE` (8); reaction delayed `REACTION_MIN_MS`–`REACTION_MAX_MS` (100–300ms); no opening/digging/placing/attacking through a wall; no chest contents without opening; no entity identity beyond LOS.

## One distinction that is NOT a duplication: occlusion vs solidity

Two different questions, deliberately answered differently — do not merge them:

- **LOS-occlusion** — "what blocks a *sightline to a target*?" Foliage/leaves/open doors are **passable** (you see through them). Used by interaction/harvest/entity-detection. Implemented by `occludesLOS(block, { mode })` (modes: `generic`, `harvest(targetName)`).
- **Scan-solidity** — "what is the *first real block* my eye-ray hits?" Foliage **is** a visible block (you see the leaves). Used only by scene scanning. Implemented by `raycastFirstScanSolid` (air-only passable).

Merging these would change behavior (the bot would either see through leaves it should report, or stop sightlines on leaves it should see past).

## Known asymmetries (deliberately left for Pass 2)

These are real inconsistencies the cleansing pass documented but did **not** change (changing them alters behavior):

1. **`goto_near`'s eye is a default-height literal** (`FAIRPLAY_EYE_HEIGHT_DEFAULT` = 1.377 = 1.62 × 0.85), not entity-height-aware like `eyePosition`. Diverges only for non-default entity heights.
2. **Scan-solidity ≠ LOS-occlusion** (foliage) — see above. Two predicates by design.
3. **`canDetectEntity` uses `entity.height * 0.85` without the `|| 1.62` fallback** that `eyePosition` has — a possible `NaN` for height-less entities.

## Pass 2 (not implemented)

The intent-based `approach` verb — built on mineflayer-pathfinder affordance goals (`GoalGetToBlock` / `GoalLookAtBlock` / `GoalCompositeAny`) so the bot stands *beside* a chest, not *on* it — is future work. It is the structural answer to the `view_blocked` failure bucket cited in [`../architecture/embodied-control.md`](../architecture/embodied-control.md). It builds on the seams this charter accompanies: `occludesLOS`, the named eye constants, and the extracted `pickLosStandCell`.

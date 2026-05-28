# Genesis `g-2026-05-28-5` — postmortem

**Outcome:** P1 reached 5/6 cards done + a self-inflicted FIX wedge. Run
stopped at ~17:48 elapsed before P1 EPIC closed.
**Net vs prior runs:** Demonstrably the best behavioral run so far. The
two new failure modes that prevented closure are **deeper than any
prior run's blockers** — we've climbed the stack again.

## Run summary (one paragraph)

Steward closed RECONCILE and SITE in **round 1** (first ever), workers
completed anchor + survey + shelter + chests cleanly, and Steward then
applied the "verify before trust" doctrine by running `mc is_sheltered`
herself before closing P1 EPIC. That verification reported 8 "missing
wall blocks" — but because she invoked the verb WITHOUT the `walls=`
argument, the output was actually the bot's 6-direction adjacent
neighbors (which are interior air by design for a 5x5 shelter). She
filed a [FIX] card with those 8 interior coords. Mason picked it up,
trusted the card body verbatim, placed cobblestone at all 8 positions
— sealing himself inside the shelter (the "gaps" included the door
passage). With no inventory left and no pickaxe, Mason couldn't escape
and his worker went silent (alive but no heartbeats, no chat) for 27+
minutes. Steward correctly diagnosed the trap and would have filed
[RESCUE] + completed P1 EPIC (the shelter walls were actually fine),
but consecutive round timeouts (5, 6, 7, 8 all exit=142) prevented her
from landing the close.

## The causal chain (10 steps)

```
1. Mason completed shelter, ran `mc is_sheltered walls=...`,
   got 48/48 ✓, marked card done. ✓ correct.

2. Steward in round 5 ran `mc is_sheltered` (NO walls= argument)
   from her body. ← root cause #1

3. mc is_sheltered's default-mode output reported the bot's
   6-direction adjacent cells via a `wallReport` field with
   keys named `foot_east`, `foot_west`, `foot_south`, `foot_north`,
   `head_east`, etc. ← root cause #2 (output naming)

4. For Steward standing at (258,64,63) inside the 5x5 shelter
   (interior 3x3 at x∈[257,259], z∈[62,64]), her adjacent cells
   were ALL interior:
     foot_east = (259,64,63)  ← interior
     foot_west = (257,64,63)  ← interior
     foot_south= (258,64,64)  ← interior (touches door passage)
     foot_north= (258,64,62)  ← interior
   plus 4 head-level versions. All air by design — they're the
   shelter's interior volume.

5. Steward parsed the output as "8 missing wall blocks" because
   the field names contained "_east"/"_west" etc., which read
   like wall positions. ← root cause #3 (verification doctrine
   doesn't reinforce the walls= form requirement)

6. Steward filed [FIX] t_f73a99fe with body listing all 8 cells
   as "missing wall blocks." Used `scripts/kanban create --epic
   t_<P1> --depends-on t_<P1>` (per the task_links events) —
   the depends-on flag was wrong but she self-corrected later.

7. Mason claimed FIX, withdrew 8 cobblestone, moved to shelter
   center (258,64,63), placed cobble at all 8 listed positions
   one-by-one. ← root cause #4 (worker doesn't sanity-check
   coords against shelter geometry)

8. The patches included (258,64,64) and (258,65,64) — the
   south-door passage cells. Mason sealed himself in.

9. With inventory empty (used all 8 cobble) and no pickaxe,
   Mason tried `mc escape`, `mc pillar_step --force`, `mc dig`
   (no tool), `mc interact 258 64 65` — all errored.
   Worker process kept spinning attempts silently. ← root
   cause #5 (no working trapped-in-self-built escape)

10. Mason's worker session ran another 14+ minutes with no
    heartbeat, no chat, no successful action. The kanban
    runtime extended its claim because pid_alive was true.
    Steward's rounds 5-8 verified the trap but couldn't
    finish the rescue-and-close sequence in budget.
```

## Root causes (5 distinct layers)

### Layer 1 — `mc is_sheltered` default-mode output is misleading

The `wallReport` field uses keys named `foot_east`, `head_north`, etc.
Those naming patterns are inherited from "look around the bot for
wall cells" but the actual data is **the bot's immediate adjacent
neighbors regardless of perimeter membership**. For an agent reading
the output, "foot_east=air@X,Y,Z" is indistinguishable from "there's a
missing wall block at X,Y,Z" unless they understand the verb's
two-mode behavior.

**Fix shape:** the default-mode output should NOT use names that imply
wall positions. Rename to `exposed_faces` / `open_neighbors`, or
explicitly suppress the field unless `walls=` was passed. The output
text "Walls intact" or "exposed at foot_east" should be reserved for
the walls= form.

### Layer 2 — Verification doctrine doesn't enforce the right form

Steward's SOUL says verification should use *"`mc is_sheltered walls=...`,
`mc inspect <coord>` for specific cells, `mc blueprint verify <plan>`"*.
The "walls=" parenthetical is there but easy to miss. When Steward
*independently* re-verified the shelter (per "verify before trust"
doctrine), she ran `mc is_sheltered` without the walls= bbox.

**Fix shape:** Make the doctrine explicit and structural:
- The SOUL should say "ALWAYS pass `walls=...` when verifying a
  shelter or any wall-bounded region; the default form is for
  ambient enclosure checks (`am I currently in a sheltered spot`),
  not structural verification."
- The shelter card body in `phase1-cards.yaml` already specifies
  `walls=<bbox>`. The genesis epic doctrine could surface this as
  a quoted-verification-command on every [CONSTRUCT] card.

### Layer 3 — FIX card filer doesn't geometry-check the reported cells

Steward took the `mc is_sheltered` output at face value and listed
positions that don't make geometric sense for a 5x5 shelter:
- For a 5x5 shelter centered at (258,64,63), walls are at
  x ∈ {256, 260} and z ∈ {61, 65}.
- The reported "gaps" were at x=257, x=258, x=259, z=62, z=63, z=64
  — all interior positions.

A simple sanity check (does the position lie ON the perimeter of the
shelter's bbox?) would have caught the misread before filing the FIX.

**Fix shape:** When Steward files a [FIX] card targeting specific
coords, she should compute the perimeter bbox from the parent shelter's
anchor + dimensions and verify each FIX target is on the perimeter.
Or, more simply: the FIX card body template could explicitly say
"check that each X,Y,Z is on the perimeter bbox before placing." This
shifts the sanity check to the worker.

### Layer 4 — FIX card worker doesn't sanity-check before placing

Mason placed at all 8 positions without checking. A worker patching a
shelter should know its geometry and refuse to place at non-perimeter
cells. The shelter card body already says "walls are perimeter only,
never the interior" — but the FIX card body just listed coords without
restating that rule.

**Fix shape:** The shelter card body's "Hard rule — walls are perimeter
only" should be carried into the FIX card body template, with explicit
verification: "For each {x,y,z} in the gap list, verify (x in {wall_xs}
OR z in {wall_zs}) before placing. Refuse interior cells."

### Layer 5 — Trapped-in-self-built has no working escape

Mason got sealed in with empty inventory. Available primitives:
- `mc escape` — errored
- `mc pillar_step --force` — errored
- `mc dig` — errored (no pickaxe)
- `mc interact 258 64 65` — errored
- `mc rescue_request` — not tried
- `mc through` — errored

None of these handle "I'm in a 3x3 air pocket surrounded by my own
cobble with no tools." The bot has bare-hand dig as a slow option but
that path was disabled or hit a refusal.

**Fix shape:** Either (a) `mc escape` should handle this scenario
explicitly (digging the floor down 1 cell to fall through into a
self-rescue void), or (b) the trapped-worker should file a
[RESCUE_REQUEST] card with coords and material requirements
(`needs: stone_pickaxe`) so another bot can come dig them out, or
(c) the system_chest should have a "panic withdrawal" path the
worker can invoke from inside the shelter.

## What WENT RIGHT this run (the wins)

1. **Steward closed RECONCILE + SITE in round 1** — first ever
   single-round multi-orch-close.
2. **The SITE card body fix (move-first) worked** — no anchor-position
   confusion from this run's SITE worker.
3. **Survey produced clean output** in 14 min.
4. **Shelter completed in 7 min** (vs 12-17 in prior runs).
5. **The sandbox stub on `hermes kanban create --parent` worked** —
   zero raw-flag attempts captured. Steward used `scripts/kanban`
   correctly.
6. **Steward self-corrected the --depends-on misuse** — she filed
   FIX with `--depends-on t_<P1_epic>`, recognized the wedge ~6 min
   later, ran `scripts/kanban depends-remove` herself.
7. **Steward applied "verify before trust" doctrine** — she
   re-verified the shelter rather than blindly closing P1 EPIC.
8. **Steward correctly diagnosed Mason's trap** in later rounds and
   would have filed [RESCUE] + completed P1 EPIC if not for the
   round-budget cap.

## Comparison across the experiment series

| Run | Top blocker | Cards done | Steward rounds (✓/total) |
|---|---|---:|---:|
| -10 | facade misuse (--parent) → wedge | 0 | 1/4 |
| -3  | claim verb confusion | 4/6 + hand-execute | 1/4 |
| -4  | --parent on epic, then orch budget | 4/6 + hand-execute | 5/8 |
| -5  | mc is_sheltered output framing + Mason trap | 5/6 + FIX wedge | 4/8 |

Each run reveals one layer deeper. -5's blockers are **bot-runtime and
verb-output level** — not doctrine or facade.

## Proposed fixes — by tier

### Tier 1 (high leverage, low effort — fix before next run)

1. **`mc is_sheltered` output framing** — when called without `walls=`,
   rename the `wallReport` keys from `foot_east`/`head_east`/etc to
   `neighbor_east_foot`/`neighbor_east_head`. The existing "Walls
   intact" / "exposed at X" wording from the walls= form stays.
   Files: `bot/lib/actions/queries/region.js` (handler at line 268).
   Test: existing `is_sheltered` tests likely cover the rename.

2. **SOUL: tighten verification doctrine** — add a section to
   `prompts/landfolk/steward.md` after the verification cheat sheet
   making the walls= form mandatory for shelter checks. Citing this
   run as the incident.

3. **Shelter card body: quote the exact walls= command** — change
   `phase1-cards.yaml` shelter card so Mason quotes the FULL
   `mc is_sheltered walls=...` invocation in his completion summary,
   AND so the FIX-card-creator (Steward) can copy-paste the same
   walls= bbox into her own re-verification.

### Tier 2 (medium leverage, medium effort)

4. **FIX card body template** — when Steward files a `[FIX]
   <shelter>` card, the body should include the shelter geometry's
   perimeter ranges explicitly, and instruct the worker to
   sanity-check each gap coord against those ranges.

5. **Mason silent-wedge watchdog** — add a kanban-runtime check:
   if a worker's `last_heartbeat_at` is null AND elapsed > N min,
   force-reclaim the card and respawn. Currently the runtime trusts
   `pid_alive` indefinitely.

### Tier 3 (defer)

6. **`mc escape` handles trapped-in-self-built shelter** — add a
   strategy for "empty hand, blocked exit, own placement nearby"
   that digs the floor down or files a rescue request.

7. **Dispatcher gate-check transient failures** — investigate why
   `hermes landfolk gate-check` was failing in the dispatcher
   subprocess context but succeeds standalone. Separate plumbing
   investigation.

## Recommended next session

Tier 1 only — they're all small. After applying, retry with the same
seed. Expected result:
- Steward's re-verification uses walls= form → matches Mason's original
  48/48 ✓ → no FIX card filed → P1 EPIC closes cleanly.
- Or, if she somehow still re-verifies wrong, the output won't mention
  "foot_east" wall positions → she won't file a misshapen FIX card.

If P1 closes cleanly and P2 progresses without the FIX detour, we
finally get to test the P2 facade behavior end-to-end.

# Phase D run-2 — mapping mission postmortem

**Date:** 2026-06-04 (~07:40–07:50 PDT)
**Mission:** `establishment.mapping` (after the "map the world with light" prompt reframe)
**Seed:** `-32456789431833` (same as run-1; world reused)
**Outcome:** workers DID attempt placements — 40 `place_named_sign` calls across the run; 0 succeeded because of two latent Phase-A2 bugs
**Personal POIs placed:** 0
**Signs placed:** 0 (40 attempts, all failed)
**Torches placed:** 0 (workers gave up before reaching this verb)
**Duration:** ~10 min of worker time

## Critical correction to run-1 finding

Run-1 reported "workers explore but never commit". That was **wrong**. Re-reading
the right log files (`nav-<Bot>.jsonl` instead of `mc-<bot>.log`) shows workers
were calling `mc place_named_sign` continuously throughout both runs — they were
just getting errors back so the placements never landed. The user observation
("signs were being placed 2-3x by some agents") was correct; my grep on the
wrong log file missed them.

**Lesson for me:** mapping-verb activity lives in `nav-<Profile>.jsonl`
(structured nav errors) for the in-process bg-task subsystem, NOT
`mc-<bot>.log` (which logs only the `bot/cli/index.mjs` calls). Cross-reference
both before reporting "0 calls".

## Attempt distribution

40 total `place_named_sign` attempts across 3 workers:

| Error code | Count | Root cause |
|------------|------:|------------|
| `SIGN_WAX_PROTECTED` | **16** | Phase A2 bug: 200ms readback fires before MC's tile_entity_data round-trip arrives → false-positive on every successful placement |
| `LINE_TOO_LONG` | 7 | Workers wrote names like "spider hill north ridge" (>15 chars per line) |
| `TARGET_SELF_OCCUPIED` | 4 | Workers calling place_named_sign at their own (x,y,z) |
| `INVENTORY_MISSING` | 3 | Sign withdrawn count vs inventory race |
| `TARGET_OCCUPIED` | 2 | Target cell already had a block |
| `OUT_OF_RANGE` | 2 | Target > reach distance |
| `NO_SOLID_NEIGHBOR` | 2 | No adjacent solid for sign to attach |
| `INTERRUPTED` | 2 | Concurrent action interrupted the placement |
| `NO_LINE_OF_SIGHT` | 1 | View blocked between bot and target |
| `OPERATION_TIMEOUT` | 1 | place_named_sign exceeded its own timeout |

Zero `place_torch` attempts. Zero `poi_add` attempts. Workers focused on
landmark signs first (per skill: "place your first sign within 90 seconds")
and never reached the torch/POI phase because every sign attempt failed.

## Bug 1: `SIGN_WAX_PROTECTED` false-positive (Phase A2) — FIXED

### Symptom

16 of 40 placements (40%) returned `SIGN_WAX_PROTECTED` against a fresh proc-lab
disc with zero waxed signs anywhere. The error's diagnostic message said the
write was rejected by the server.

### Root cause

`bot/lib/actions/interaction.js:613-628` did a single-shot read-back at
`env.SIGN_READBACK_MS || 200` after calling `bot.updateSign(block, text, back)`.
On the homelab Minecraft server (`192.168.1.202`), the round-trip latency for
the resulting `tile_entity_data` packet exceeds 200ms regularly — the read-back
ran *before* the server's confirmation arrived, so `block.signText` still read
the pre-update lines (typically `['', '', '', '']`). The mismatch triggered the
wax detection path → false `SIGN_WAX_PROTECTED`.

### Fix

Replaced the single-shot readback with a 50ms poll loop, max budget
`SIGN_READBACK_MS` (default raised to 1500ms = 30 polls). First match wins.
Genuinely waxed signs never match, so they still surface after the full budget.
Trade-off: in the worst case (legitimate wax), the bot waits ~1.5s instead of
0.2s before returning the failure.

```diff
- await sleep(readbackMs);
- const verifyBlock = b.blockAt(new Vec3(x, y, z));
- const observed = readSignTextLines(verifyBlock);
- if (!linesMatch(observed, lines)) { ... SIGN_WAX_PROTECTED ... }
+ const readbackMaxMs = Number(process.env.SIGN_READBACK_MS) || 1500;
+ let elapsed = 0, matched = false;
+ while (elapsed < readbackMaxMs) {
+   await sleep(50);
+   elapsed += 50;
+   verifyBlock = b.blockAt(new Vec3(x, y, z));
+   observed = readSignTextLines(verifyBlock);
+   if (linesMatch(observed, lines)) { matched = true; break; }
+ }
+ if (!matched) { ... SIGN_WAX_PROTECTED ... }
```

All 16 `place-named-sign.test.js` unit tests still pass — the polling logic is
backward-compatible with the test fixtures that stub `updateSign` synchronously.

### Impact estimate for next run

40% of attempts unblocked immediately. With workers persisting through the
LINE_TOO_LONG and TARGET_SELF_OCCUPIED filters (Steward-driven nudges or
skill-text tightening), 60–80% of attempts should land signs.

## Bug 2: Workers don't know the 15-char-per-line sign limit

7 of 40 (17.5%) attempts returned `LINE_TOO_LONG`. Workers wrote names like
`"spider hill north ridge\n"`. The MC sign limit is ~15 visible chars per
line; our verb rejects anything over.

### Fix candidate (next-run, not in this commit)

Add to `skills/minecraft-mapping.md` near the sign protocol section:

> **Sign-line limit: 15 chars per line.** "spider hill" fits; "spider hill
> north ridge" gets `LINE_TOO_LONG`. Use the lines as separators:
> ```
> mc place_named_sign X Y Z "spider hill\nnorth ridge"
> ```

## Bug 3: `TARGET_SELF_OCCUPIED` — workers naming where they stand

4 of 40 (10%) attempts had the worker call `mc place_named_sign` at their own
(x,y,z). The intent was probably "name where I'm standing" — but a sign can't
be placed on the cell occupied by the bot's feet.

### Fix candidate (next-run, not in this commit)

Skill update: "Pick a coord 1–2 blocks away from your foot position. A sign
can't be placed where you're standing. Use `mc status` to get your position,
then offset: `mc place_named_sign X+1 Y Z 'name'` (eastward), etc."

The verb itself could degrade gracefully (auto-offset to the adjacent cell)
but that risks placing in someone else's region.

## Bug 4 (non-blocking): rescue cards from `PHYSICALLY_STUCK` self-report

Steward saw two workers self-report `PHYSICALLY_STUCK` and created two
`[RESCUE]` cards for gatherer to come dig them out. The workers weren't really
stuck — they had abandoned a goto and were free to move other directions /
place a sign at their current spot. The operator manually archived both
rescue cards.

### Fix candidate (next-run, not in this commit)

Tighten `prompts/landfolk/steward.md` `[MAP:ARENA]` rubric:

> **Don't escalate `PHYSICALLY_STUCK` to `[RESCUE]` in a mapping context.**
> A worker reporting stuck during a `[MAP]` card almost always means they
> abandoned a `goto` target. Comment on the card: "@<worker>: place a sign
> at your current position and pick a different bearing. You aren't stuck;
> the goto was."

## Bug 5 (run-1 carry-over): duplicate hermes processes from prior runs

`landfolk stop` + `establish-fleet-cleanup.sh` didn't kill the hermes
kanban-task processes from the previous run. When the new run dispatched
fresh card claims, each worker ended up with 2 hermes processes
(old-task + new-task) fighting for the same bot's pathfinder. Operator
killed the orphans manually.

### Fix candidate (next-run, not in this commit)

`establish-fleet-cleanup.sh` should also `pkill -9 -f "hermes -p .* kanban task"`
to clean up the kanban-task processes that landfolk-stop misses.

## What's now staged for the next run

| Item | Status |
|------|--------|
| `SIGN_WAX_PROTECTED` polling fix | **committed + deployed** |
| `skills/minecraft-mapping.md` "map the world with light" reframe | committed in run-2 prep |
| `prompts/landfolk/steward.md` `[MAP:ARENA]` reframe | committed in run-2 prep |
| `LINE_TOO_LONG` skill clarification | not yet — recommended for next prep |
| `TARGET_SELF_OCCUPIED` skill clarification | not yet — recommended for next prep |
| `PHYSICALLY_STUCK` rescue suppression in Steward | not yet — recommended for next prep |
| `establish-fleet-cleanup.sh` orphan-kanban-task pkill | not yet — operationally fixable |

## Why we don't need an SOUL/skill override

Run-1 report wrongly suggested workers' SOUL gatherer preset was overriding the
mapping card. That suspicion was misread evidence — the wood-gathering calls in
`mc-gatherer.log` were from the **agent-loop hermes process** (which is
correctly idle when a kanban task is held — it's just doing the keep-alive
preset-load motion). The actual **kanban-task hermes process** was driving the
bot toward signs the whole time; its activity lives in `nav-<Bot>.jsonl` +
`progress-<bot>.log`.

No SOUL override needed. The kanban-worker SOUL + minecraft-mapping skill +
[MAP] card body are correctly stacking; the workers were honoring the mission.
The blocker was the verb itself silently rejecting all attempts.

## Files

- `agent-{flint,gatherer,mason,steward}.log` — reasoning logs (mixed: kanban-task + agent-loop)
- `mc-{flint,gatherer,mason,steward}.log` — `bot/cli/index.mjs` calls only (misleading for in-process verbs)
- `hermes-{flint,gatherer,mason,steward}.log` — round summaries
- `nav-{Flint,Gatherer,Mason}.jsonl` — **the authoritative source** for mapping-verb errors
- `progress-{flint,gatherer,mason}.log` — verb completion/error counters
- `dispatcher.log`, `gateway.log` — kanban dispatch
- Plus this `POSTMORTEM.md`

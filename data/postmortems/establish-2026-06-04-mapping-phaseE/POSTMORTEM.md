# Phase E mapping mission — run-1 postmortem

**Date:** 2026-06-04 (~08:28 – 09:13 PDT, ~45 min of worker time)
**Mission:** `establishment.mapping` (Phase E: path-construction + sign proposals + graph-driven dispatch)
**Seed:** `-32456789431833` (snowy_taiga / frozen_river)
**Outcome:** Phase E design **fully validated** end-to-end. Mid-run revealed and fixed 4 latent ship-bugs across Phase A2/A4/E. Worker verb-mechanics remain the limiting factor for graph growth.
**Final graph:** 7 POIs (2 named landmarks, 5 waypoints); 4 edges; longest_path 64 blocks; 3 of 4 quadrants covered.

## TL;DR

Phase E's path-construction design works exactly as proposed: workers
receive `[MAP-PATH] <start> → <target>` cards, walk a bearing torching
every ~25 blocks, propose a name at the endpoint, Steward approves, the
sign goes up, the graph grows. Steward dispatches the *next* card from
a frontier node toward unexplored terrain. The dashboard renders the
emerging map. The grader scores the graph against thresholds. **None of
the design needs revision.**

The mission did NOT clear the grader thresholds (`named_count ≥ 6`,
`longest_path_len ≥ 80`, all 4 quadrants) because we burned ~80% of
worker time debugging four latent shipping bugs:

1. `mc poi_add` CLI parser (Phase A4 ship-bug; never worked, no
   POIs registered across Phase D + the first half of Phase E)
2. `mc place_named_sign` wax-readback false-positive (Phase A2 bug;
   100% of placements returned `SIGN_WAX_PROTECTED` because Mineflayer
   doesn't update its block cache with sign text)
3. `establish-fleet-cleanup.sh` left orphan kanban-task hermes
   processes that raced the new run's hermes
4. `poi-graph.py` quadrant classifier used the POI's `x/z` (bot
   foot at registration) instead of the actual sign/torch anchor

Each was a one-commit fix. All four are committed in this branch
(`9868a1d`, `e6c8edc`, `bbf6794`, `50de1fa`). Next run starts with the
plumbing actually working.

## Final state

```
named_count       = 2          (target 6)
waypoint_count    = 5
edge_count        = 4
longest_path_len  = 64.0       (target 80)
longest_path      = [wp_e_1 → wp_e_2 → spruce-gate → wp_e_3]
quadrants_covered = NE, NW, SE (target all 4)
named_frontier    = [frozen_north, spruce-gate]
component_count   = 3
```

**Named landmarks:**
- `frozen_north` at (-1, 63, -45) — Gatherer's north endpoint (NW)
- `spruce-gate` at (56, 63, 0)   — Mason's east endpoint (SE)

**Waypoints (torch trails):**
- `wp_n_1` at (1, 63, -45)  — north of muster
- `wp_e_1` at (14, 67, -2)  — first east torch
- `wp_e_2` at (38, 65, 5)   — second east torch
- `wp_e_3` at (76, 63, 2)   — extension east of spruce-gate
- `wp_s_1` at (0, 70, 25)   — first south torch (Mason)

**Pending at fleet stop:** Mason had just posted
`SIGN_PROPOSAL: name='south ridge', coord=(0,67,46)` and was awaiting
Steward approval. One more cycle would likely have landed her sign.

## Bug 1: `mc poi_add` CLI parser never worked

### Symptom

Workers' attempts at `mc poi_add wp_e_1 --torch 14 67 -2 --kind waypoint`
all returned:

```
ERROR (cli): unhandled_custom_parse:poi_add
  Usage: mc poi_add NAME [NOTE] [--at X Y Z] [--sign X Y Z] [--torch X Y Z] [--kind KIND]
```

### Root cause

`bot/cli/registry.mjs` declared `poi_add` and `poi_update` as
`customParse: true` so they could accept three-arg flags. But the
switch in `bot/cli/dispatch.mjs::buildHttpRequest` never added cases
for them — they fell through to the default `unhandled_custom_parse`.

Phase A4 ship-bug. Every `poi_add` attempt across two Phase D runs and
the first ~40 min of Phase E run-1 failed at the CLI layer. What
looked like "workers skip the metadata step" was actually "workers
attempt the metadata step and the CLI rejects it."

### Fix (commit `9868a1d`)

Added the `case 'poi_add':` and `case 'poi_update':` branches with
proper three-arg flag handling for `--at`, `--sign`, `--torch` plus a
single-arg `--kind`. Body emitted matches what `personal-pois.js`
expects: `{name, note, kind, at:{x,y,z}, sign_at:{x,y,z}, torch_at:{x,y,z}}`.

Smoke-tested mid-run against the exact failing Mason command.

### Verification after fix

Within 10 minutes: 5 successful `poi_add` calls (Gatherer 2, Mason 2,
Flint 1). First `personal-pois-*.json` file appeared on disk. Dashboard
`/api/personal-pois` started returning a non-empty array.

## Bug 2: `place_named_sign` wax-readback false-positive

### Symptom

Every `place_named_sign` returned `SIGN_WAX_PROTECTED`. The error
detail showed `observed_lines: ['', '', '', '']` and `readback_ms:
1500` — the verb polled the full budget and saw empty text every time.

RCON `data get block <coord> front_text` showed the server stored the
text correctly. The disconnect was between the server's stored value
and Mineflayer's local block cache.

### Root cause investigation

1. Original Phase A2: single-shot readback at `SIGN_READBACK_MS=200ms`
   — fired before the `tile_entity_data` packet round-tripped on the
   homelab MC (192.168.1.202). Fixed Phase D run-2 with a 50ms poll
   loop up to 1500ms.

2. Phase E run-1: even with 1500ms of polling, `bot.blockAt(pos)` for
   the placed sign returned a Block whose `signText`, `frontText.messages`,
   `signEntity.text`, `_signEntity.text` paths all came back empty.

3. Updated `readSignTextLines` to also check
   `block.frontText.messages` and decode the JSON-component format
   (MC 1.20.5+). Still empty.

4. Conclusion: Mineflayer doesn't reliably populate any of those
   fields after `bot.updateSign` on this MC version. We can't verify
   the write client-side.

### Fix (commit `e6c8edc`)

Gate the readback verify behind `SIGN_READBACK_VERIFY=1`. Default:
trust `bot.updateSign`'s return — if no exception, the verb returns ok.
Lose automatic wax detection in exchange for unblocking 100% of valid
placements.

Verified in production: smoked a sign at Mason's position with the env
unset; the verb returned ok and the server-side `data get block`
confirmed the text was written.

### Test changes

The existing wax-detection test was renamed to opt-in
(`SIGN_READBACK_VERIFY=1`) and a new test was added for the new default
behaviour (waxed-style readback failure does NOT block placement).
17 unit tests pass.

## Bug 3: `establish-fleet-cleanup.sh` left orphan hermes processes

### Symptom

After `landfolk stop` + the `pkill landfolk:` sweep, three hermes
kanban-task processes from the previous Phase D run survived. When
Phase E bootstrap dispatched its first three `[MAP-PATH]` cards, each
worker had **2 hermes processes** — the orphan from Phase D and the
new one from Phase E. The two processes per bot raced the pathfinder.
Operator reported "I keep getting moved around" and "the goal was
changed before it could be completed".

### Fix (commit `bbf6794`)

Added `pkill -9 -f 'hermes -p .* kanban task'` to
`establish-fleet-cleanup.sh` after the existing `pkill landfolk:`.

### Verification

After the first kill: 3 hermes processes (one per worker) for the
remainder of the run. Race symptoms disappeared.

## Bug 4: quadrant classifier used POI x/z, not anchor

### Symptom

`scripts/poi-graph.py` reported the graph touched quadrants `[NE, SE]`
even though `frozen_north`'s sign was placed at (-1, -45) — clearly NW
of muster. The grader was under-counting quadrant coverage.

### Root cause

`quadrants_per_component` used `n["x"]` and `n["z"]` which is the
POI's own xyz. For waypoint POIs that's the torch coord; for landmark
POIs it's the bot's foot position at `poi_add` time. Mason's
`frozen_north` (registered as `mc poi_add frozen_north --sign -1 63 -45`)
ran at bot position (4, -43) — which classifies as NE under our
convention.

### Fix (commit `50de1fa`)

Switch to `n.anchor.x / n.anchor.z` (the in-world sign or torch
position). After fix: quadrant union grew from `[NE, SE]` to
`[NE, NW, SE]`. SW still missing because no worker reached a clearly
-x +z coord yet.

## Verified Phase E design components

### Card shape
- 1 root card seeded: `[MAP-PATH] muster → first landmark`
- Steward generates subsequent cards as `[MAP-PATH] <startName> → (X,Y,Z)`
  with start node from `named_frontier`

### Worker protocol (when it lands)
- Walk bearing toward target
- Place torch every ~25 blocks of travel via `mc place_torch`
- Register waypoint via `mc poi_add wp_<dir>_<n> --torch X Y Z --kind waypoint`
- At endpoint: `mc nearby_signs 32` → propose name via `kanban_comment`
- Wait ≤90s for Steward → `mc place_named_sign` + `mc poi_add ... --sign ... --kind landmark`
- Completion body: `mc marks` + `mc pois` + `mc nearby_signs 32` literal output

### Sign-proposal protocol (verified working)
3 proposals submitted; 3 approved; 2 placed:

```
[MAP-PATH] muster → first landmark
  flint: SIGN_PROPOSAL name='north ice crossing' (0,63,-50)
  steward: APPROVED: north-ice-cross at (0,63,-50)
  → Flint never placed (her card body said "skip poi_add — parser broken"
    which Steward kept reusing stale)

[MAP-PATH] muster E
  mason: SIGN_PROPOSAL name='spruce gate' (50,67,0)
  steward: APPROVED: spruce-gate
  → Mason placed at (56, 63, 0); registered via poi_add → graph node

[MAP-PATH] muster N → first landmark
  gatherer: SIGN_PROPOSAL name='frozen north' (-1,63,-45)
  steward: APPROVED
  → Gatherer placed; first NW landmark
```

### Steward's frontier dispatch (verified)
After Mason's spruce-gate landed, Steward generated:
`[MAP-PATH] spruce-gate → E (80,63,0)` — extending the path from a
frontier landmark, not muster. Flint extended the east trail with
`wp_e_3` at (76, 63, 2), pushing longest_path from 43.9 to 64.0.

### Graph helper (verified)
`scripts/poi-graph.py` correctly:
- Loaded `personal-pois-shared.json` after each reconcile
- Detected 4 edges across the 7 POIs (adjacency within 30 blocks)
- Identified `named_frontier = [frozen_north, spruce-gate]`
- Reported longest_path: `wp_e_1 → wp_e_2 → spruce-gate → wp_e_3`

### Dashboard (verified)
`/api/personal-pois?world=proc-lab` returned the merged POI list
throughout. Ops map showed diamond glyphs for both named landmarks
and all 5 waypoints.

## Worker behavior issues (not Phase E design failures)

### Pattern: workers take 5–10 min per card

A clean `[MAP-PATH]` card should land in 6–10 min per the skill text.
In practice cards ran 10–20 min each because workers iterate on:
- `NAV_BLOCKED` retry loops when pathfinder fails on uneven terrain
- `TARGET_SELF_OCCUPIED` when they call `place_torch` on their own cell
- `TARGET_OCCUPIED` when they don't dig the grass block first
- Wandering off-bearing (Gatherer went north instead of west;
  Mason ping-ponged trying to return to muster)

These are existing verb-mechanics problems documented in earlier
postmortems (Phase D `[RESCUE]` patterns; explore mission's
`PHYSICALLY_STUCK` self-reports). The path-construction model surfaces
them more sharply because the worker can't fall back to "explore
something else nearby" — they have a specific target coord.

### Pattern: Steward reuses stale card templates

Even after operator nudges that the `poi_add` bug was fixed, Steward
kept copying her old template with "Skip poi_add — parser broken" into
new `[MAP-PATH]` cards (visible in `t_00f0d79c` muster S and
`t_cad1cf5f` spruce-gate→E). She did eventually update the template
after a strong operator directive on the epic, but multiple stale
cards completed in the meantime.

### Pattern: agent-loop SOUL preset races between kanban tasks

`landfolk:agent-loop:<bot>` watchdog spawns a generic `hermes chat
--yolo` process when `HERMES_KANBAN_TASK` isn't set. The process has a
guard ("if a kanban claim is active, exit") but with no active card,
it runs the worker's SOUL preset (Mason = `builder`,
`perimeter_fence`; Gatherer = `gatherer`, `maintain_wood`). The SOUL
preset issues conflicting `goto` calls that race with the next
kanban-task hermes.

Two operator kills cleared the racers mid-run. Real fix is either a
mission-aware idle state or a flag that suppresses SOUL presets while
`[MAP:ARENA]` is open.

## Why this is still a successful run

Phase E proposed a structural shift from quadrant-patrol to
path-construction. The shift was right:

- The fleet produced a coherent graph the operator can read.
- Steward dispatched correctly from frontier nodes outward.
- Workers proposed names; Steward approved them; the graph grew.
- The dashboard rendered the emerging map in real time.
- The grader scored against graph metrics.

The protocol-level model is **definitively validated**. Failing the
grader's quantitative bar isn't a design failure — it's the time tax
of debugging four latent ship-bugs and the existing pattern of
worker-verb-mechanics burning 10–20 min per card.

## Recommended next steps

1. **Re-run Phase E with all four bug fixes baked in.** Without the
   `poi_add` parser bug and the wax false-positive eating placement
   attempts, workers should land 3–4 endpoint signs per 30 min instead
   of 2 per 75 min. The 80-block longest_path + 4-quadrant + 6-landmark
   targets should be reachable in ~60 min of run time.

2. **Tighten the agent-loop racer.** Either suppress SOUL presets
   fleet-wide while `[MAP:ARENA]` is open OR have the watchdog poll
   the kanban DB for a pending claim before spawning the agent-loop.

3. **Steward stale-template self-check.** Extend the `[MAP:ARENA]`
   rubric: "before creating a new `[MAP-PATH]` card, re-read the
   template body — if it mentions a bug that's been since fixed
   (via operator comments on the epic), update the body."

4. **Worker verb-mechanic skills tightening.** Already partially
   addressed in `skills/minecraft-mapping.md` Phase E rewrite. Could
   add a hard rule: "if `place_torch` returns `TARGET_SELF_OCCUPIED`
   twice, your next action is `mc move ~+2 ~ ~` before retrying" —
   make the offset mechanical, not optional.

5. **Operator-style mission tuning.** Reduce quadrant_min from 4 to 3
   for first-run validation since SW edges are hard to reach quickly
   (origin tie-break + most workers prefer +x bearings).

## Commits landed mid-run

```
50de1fa  poi-graph: quadrant classification uses anchor coord, not POI's own
e6c8edc  place_named_sign: make wax-readback verify opt-in
9868a1d  CLI: implement poi_add / poi_update custom-parse cases
bbf6794  Cleanup script: kill orphan hermes kanban-task processes
3457ba6  Phase E: path-construction mapping mission + sign proposals + graph grader
```

## Files in this postmortem

- `agent-{flint,gatherer,mason,steward}.log` — reasoning logs
- `mc-{...}.log` — `bot/cli/index.mjs` audit
- `hermes-{...}.log` — round/plan summaries
- `nav-{Flint,Gatherer,Mason}.jsonl` — structured nav errors (authoritative for verb success/failure)
- `progress-{...}.log` — watchdog JSONL
- `bot-{...}.log`, `watchdog-{...}.log`
- `dispatcher.log`, `gateway.log` — kanban dispatch
- `personal-pois-{gatherer,mason,shared}.json` — final POI state
- `last-establish-map.json` — map JSON used for bootstrap
- `final-graph.json` — `scripts/poi-graph.py --pretty` at fleet stop
- `final-board.txt` — kanban state at fleet stop
- This `POSTMORTEM.md`

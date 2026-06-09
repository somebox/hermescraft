# FEEDBACK: navigator-pip on proc-nav-1780994801

**Trial:** proc-nav-1780994801
**Role:** navigator-pip
**Card:** t_36c0e997 — [NAV] measure segment 2 (road_bound_1 → road_bound_2, Z≈12→24)
**Date:** 2026-06-09

## Problems Hit

1. **No batch verb for terrain sampling** — Measuring a 3-wide segment cross-section at
   Z=12 (start), Z=18 (mid), Z=24 (end) required 9 separate `mc terrain_top` calls
   (X=-1,0,1 × Z=12,18,24). Each call is ~2-3s network latency + parse. A batch verb
   like `mc terrain_strip --x -1,1 --z 12,24 --step 6` would collapse 9 calls into 1.

2. **`level_ground` dry-run output is verbose** — The `mc level_ground --dry-run` output
   prints a tile-by-tile report with `deck_required_n`, `reroute_required_n`, `columns[]`
   per tile, which is good for debugging but hard to scan at a glance. I had to manually
   extract: "3 tiles, all deck_required=1, passage=deck across entire segment". A
   compact summary line (e.g. `passage: deck | 3/3 tiles need deck`) would save
   extraction time.

3. **Catalog Y drift at overlook is a recurring blind spot** — This is the *third* trial
   run where the road_plan's catalog Y for overlook (Y=67) disagrees with live terrain
   (median Y=79, delta=12). Each time the navigator must manually detect, flag, and
   override. The corridor_profile .elevation_median (78) was close to live (79, diff=1)
   and correct — so the catalog Y is the stale data source, not the profile median.
   This mismatch wastes one orientation round per segment that references overlook.

4. **No `segment_status` verb exists** — The card body asked me to "report
   `segment_status`" but that verb doesn't exist in `mc`. I improvised by emitting
   structured handoff metadata through `kanban_complete`. A real `mc segment_status`
   that reads the road_plan, samples terrain, and returns a compact pass/fail/action
   summary for one segment would be the canonical tool.

5. **Memory continuity worked — but only for the profile that wrote it** — My memory
   from segment 4 (t_da1d2534) carried forward and helped me understand the road_plan
   format immediately. But the corresponding Mox-worker memory for the opposite role
   is invisible to me, so I can't see whether the downstream Mox card for segment 2
   already existed. No cross-profile memory access.

## Tooling Improvements

1. **Add `mc terrain_strip`** — Batch terrain sampling over a rectangular strip:
   `mc terrain_strip --x -1,1 --z 12,24 --step 6`. Returns a compact table with
   per-cell Y values plus computed median. Would save 7-8 `mc terrain_top` calls
   per segment measurement.

2. **Add `mc segment_status <segment_id>`** — One-shot verb that reads the road_plan
   (from $HERMESCRAFT_REPO/data/runtime/), samples terrain at the segment's bounds,
   runs level_ground dry-run, and prints a summary: target_y, passage_kind, deck_spans,
   obstacle count, anomaly flag. No need to chain terrain_top → level_ground → manual
   median manually.

3. **Emit a compact passage summary from `level_ground --dry-run`** — Add a one-line
   footer like `PASSAGE: deck | 3/3 tiles deck, 0 reroute | disposition: 10 level,
   29 fill_shallow, 0 cut, 0 fill_deep` so the agent can grep for `PASSAGE:` instead
   of parsing the full block.

## Bundle / Skill / Profile Notes

1. **`minecraft-navigation` skill was current** — The terrain_top → level_ground →
   median → anomaly workflow is well-documented. No stale content found.

2. **No stale skills noticed** — The `kanban-worker` skill (auto-loaded) had the
   relevant handoff templates and structured closeout patterns. Worked as intended.

3. **mc chat was unavailable** — The bot server wasn't running during this post-trial
   feedback session, so the card's request for `mc chat "feedback recorded: ..."` failed.
   This has been the case on every post-trial FEEDBACK card on proc-nav-lab so far.
   Consider either: (a) making mc chat optional in the card body for FEEDBACK cards,
   or (b) having the dispatcher start a short-lived bot session for FEEDBACK cards
   so the chat line actually reaches the bot's log.

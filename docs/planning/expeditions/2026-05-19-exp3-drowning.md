# exp3 (long-distance navigation QA) — drowning postmortem

**Date:** 2026-05-19
**Run:** exp3 (start epoch `1779222578` = 22:09:38 CEST)
**Outcome:** Steve drowned at (1116, 51, -143) ~28 min into the run. Lost full iron-tier loadout. Respawned at base.
**Session JSON:** `~/.hermes-landfolk-steve/sessions/session_20260519_221234_ffcd2c.json` (441 messages)

## TL;DR

Steve **drowned**, not /killed. Earlier reports of "/kill" and "fighting zombies" were wrong — both were superficial readings of incidental data (an advise digest *suggesting* /kill that Steve didn't act on; rotten_flesh from earlier combat that succeeded).

The actual death sequence:
1. Long `bg_goto` legs were succeeding (cap fix `3cfa2c1` works) — Steve crossed 500 blocks in ~3 minutes.
2. Bot's Y crept progressively downward through several legs (y=71 → y=64 → y=62) until it reached a coastline.
3. Bot walked into the ocean. Pathfinder did NOT route him into water (avoidWater=true held), but pathfinder allowed a legitimate land-step adjacent to water; then the bot slipped in from physics / partial-path execution.
4. `mc escape` couldn't recover — open ocean has no dry land within its 4-block search radius, and pillar-up failed in deep water (no headroom mechanic).
5. Bot sank progressively from y=62 → y=51 over ~90s of failed escape attempts. Drowning damage drained HP 20 → 14 → 6 → 0.

## Timeline (UTC, from session JSON + mc-advise.jsonl)

| t (UTC) | msg# | event |
|---|---|---|
| 20:09 | — | exp3 launched at base (350, 64, -595) |
| 20:23 | — | Steve at (616, 74, -459). Progress good. |
| 20:26 | — | NAV_TARGET_UNSTANDABLE near (680, 64, ?) — Y guesses inside hills |
| 20:30 | — | At (678, 70, -458). Forest. NAV failures. **maintain_wood goal (gap 127)** urgent. |
| 20:30:15 | — | advise digest: "Steve is standing next to several birch logs and needs to collect wood" — pulled by autonomous goal |
| 20:33 | #238 | `bg_goto 900 64 -400` major push east. Bot at (717, 64, -459) |
| 20:33:39 | #246 | At (1127, 64, -263). **HP 20 → 15.9**. food=13. autoEat *should* trigger (threshold 14). |
| 20:34 | #250 | Stalled at (1133, 71, -262). Pushed up to Y=71 by terrain. |
| 20:34 | #253 | `goto_near 1135 71 -259 range=1` |
| 20:35 | #255 | `bg_goto 1552 64 352` — long push resumes |
| 20:37 | #259 | **"HEALTH CRITICAL at 4.1! Emergency"** — Steve realises he's submerged. Manually `mc eat` for the first time. |
| 20:37:26 | — | advise: *"Steve is in the middle of an ocean at Y=61, submerged, with 4.1 HP after taking recent damage"* |
| 20:37:34 | — | advise: *"Recommend ... using /kill to respawn if stuck indefinitely"* ← **harmful suggestion**. Steve did not act on this. |
| 20:37 | #276 | `mc escape` → STUCK_IN_WATER (no dry land within 4 cardinals) |
| 20:37 | #278 | `mc place dirt` → NO_SOLID_NEIGHBOR (open water has no face to place against) |
| 20:38 | #280-286 | bg_goto north then west — slow swim, made some progress |
| 20:38 | #292-294 | BOT_TRAPPED at (1108, 58, -141) — Y sinking from 62 → 58 |
| 20:38 | #294 | `mc escape` → ESCAPE_PILLAR_FAILED ("pillar_step could not place any blocks. Headroom may be blocked") |
| 20:38 | #298 | `mc dig` → SUBMERGED ("bot is submerged in water. Swim to the surface ... before digging") |
| 20:38 | #300 | `bg_goto 1108 64 -140` "desperately trying to swim to surface". Y now 51, **HP 12.8** |
| 20:39 | #302 | `mc stop`. **HP 6.8**. Drowning damage. |
| 20:39 | #304 | `mc move 1112 60 -143` (try to rise). Still trapped. |
| 20:39 | #306 | `mc move 1115 62 -145`. **Died here**. Respawned at (357, 65, -594) base. |
| 20:41 | #308 | "I drowned and respawned at base! Let me check inventory" — empty |

## Root causes (ranked by severity)

### RC1 — `mc escape` cannot escape deep open ocean *(SEV: critical)*

The water-recovery branch of `mc escape` is hard-coded to scan 4 cardinals × 4 blocks for dry land. In a 50-block-wide ocean, that fails immediately. Then it tries `pillar_step`, which itself fails when underwater because the jump+place sequence needs head-clearance the bot doesn't have.

Both `mc escape` and `mc dig` block on the SAME submerged condition without a way out:
- `mc escape` says "try mc dig"
- `mc dig` says "swim to surface first"

**Result: bot has no escape primitive once in deep water.** Steve's only working option was `bg_goto` toward higher Y, which was too slow against drowning timer (~30s before drowning starts, then 2 HP/s).

**Fixes:**
- (a) **Extend escape's land-search radius dramatically** (e.g. 32 blocks) in the water branch, with raycasting/scan instead of cardinal-only.
- (b) **Add a `mc swim_up` primitive** that just spams jump in water column — the simplest mechanic for vertical recovery.
- (c) **`mc dig --force`** should work underwater; agent shouldn't have to read fine print.

### RC2 — Progressive Y-drift past the cumulative-drop cap *(SEV: high)*

`maxCumulativeDropDown=3` (commit `e55d4e7`) anchors to **current foot Y at search start**. Each new `bg_goto` re-anchors. So Steve descended over 9 blocks (y=71 → y=62) in chained pathfinds, each contributing ≤3 blocks, defeating the cap's intent.

The cap is correct *within* a search but not across consecutive searches.

**Fixes:**
- (a) **Track a "session origin Y"** that persists across pathfinds within a single agent-issued plan. Hard to define cleanly.
- (b) **`mc move` and `mc bg_goto` should refuse a target whose Y is >N below current Y** at the call site (not just inside pathfinder). That gives the brain immediate, actionable feedback instead of letting it chain its way down a slope.
- (c) **The brain should pass the same Y across long-distance legs** (e.g., always target Y=64 sea level). Prompt nudge.

### RC3 — Steve entered water via legitimate-looking land step *(SEV: high)*

`avoidWater=true` blocks pathfinder from STEPPING INTO water. But a land cell ADJACENT to deep water is fine. Physics (current, animation) can then nudge the bot into the water — the bot moves at 4.3 b/s sprinting and crossing a 1-block beach onto an ocean is one tick.

We don't have evidence of pathfinder routing through water cells in the session. Most likely Steve walked off a 1-2 block ledge into water during a partial pathfind execution.

**Fixes:**
- (a) **Refuse land steps where the cell directly below would put the bot in water if it slips.** Treat shoreline cells as "high cost" not "safe".
- (b) **Reactive layer detects "head_in_water" and forces an immediate halt + escape**, much earlier than the current "HP critical" trigger.

### RC4 — `mc-advise.jsonl` recommended `/kill` as recovery *(SEV: high)*

At 20:37:34 the perception-digest LLM literally suggested: *"Recommend first escaping water by swimming to nearest land (unknown direction) or using /kill to respawn if stuck indefinitely."*

Steve didn't follow this advice (he kept trying), but the advice itself is *destructive*. /kill loses all gear permanently — the cure is worse than the disease.

**Fix:** The advise prompt template should explicitly forbid recommending `/kill`, `respawn`, or item-loss-recovery as options. The agent should always try escape primitives first and ask re44 for help if stuck.

### RC5 — autoEat did not auto-trigger at food=13 *(SEV: medium)*

`startAt: 14` should trigger eating when food ≤14. Steve hit food=13 at #246 but didn't eat until manually invoking `mc eat` at #259, by which point HP was 4.1.

Likely cause: autoEat plugin doesn't trigger while another action is in flight (long-running `bg_goto`). Need to verify.

**Fix:** investigate; possibly hook autoEat's trigger logic to not require an idle bot.

### RC6 — `maintain_wood` autonomous goal competed with expedition *(SEV: medium)*

Advise outputs repeatedly cited `maintain_wood (gap 127)` as urgent. The expedition prompt said "ignore autonomous chores until done" but the goal-scoreboard urgency surfaced anyway through perception digests. Steve diverted into forest several times.

**Fix:** Expedition mode should suppress (or down-rank) maintain_* autonomous goals. Either:
- (a) `mc goals set_urgency maintain_wood 0` at expedition start, OR
- (b) Prompt explicitly says "ignore the maintain_wood goal scoreboard — your only job is the 5 waypoints"

## What worked

- **bg_goto cap fix (3cfa2c1)** is the right call — 500 blocks in 3 min through forest is great progress.
- **avoidWater=true** held — no evidence pathfinder routed *through* water cells.
- **Steve's reasoning was sound** — he correctly identified the problem at each step, tried the right primitives (escape, place, swim, dig), and stayed calm under pressure.
- **Death telemetry is solid** — `mc deaths` captured death position, time, inventory lost. New positions.jsonl/events.jsonl would have added per-30s state.

## Action items for next run

Prioritised by what would have prevented THIS death:

1. **[critical]** Wider escape land-search OR `mc swim_up` primitive — without this, *any* ocean-stuck bot dies. Same death will recur.
2. **[high]** Brain-side refusal of large-Y-drop targets at `mc move`/`mc bg_goto` entry — closes the progressive-drift loophole.
3. **[high]** Patch advise prompt to forbid `/kill` recommendations.
4. **[medium]** Investigate autoEat-during-action behaviour.
5. **[medium]** Disable or down-rank `maintain_wood` for the expedition prompt.
6. **[low, prompt]** Tell Steve: "if HP < 10 in water, immediately `mc swim_up` then `mc stop`, do NOT try goto."

## Telemetry we *did not* have but should have

- **Continuous position log** — would have shown the exact transition from land to water (which msg# / coords).
- **HP/food time-series** — would have made autoEat regression obvious in seconds.
- **Reactive layer audit log** — currently in-memory only (`ctx.reactive.autoActionLog`). Persist to disk for postmortems.

This is exactly what the new `scripts/exp.sh` + `positions.jsonl` + `events.jsonl` convention (commit `1c0e202`) gives us. Next run will have it.

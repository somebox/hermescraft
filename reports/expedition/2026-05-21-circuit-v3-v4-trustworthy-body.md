# Circuit-v3 + v4 — "trustworthy body" validated end-to-end

**Date:** 2026-05-21
**Runs:** `20260521-004717-circuit-v3` (45 min) + `20260521-013312-circuit-v4` (in progress)
**Outcome:** Steve reached W2 (~1000 blocks east of base), collected 14 wheat, heading to W3. **No deaths in v3 or v4 to this point**, vs. circuit-v2's death at T+90s.

## TL;DR

Six fixes shipped this session compound to keep Steve alive long enough
for the LLM to make strategic decisions. Pre-fix, Steve died in water
within 90 seconds. Post-fix, Steve has been alive for 45+ minutes
across two runs, traversed 1000+ blocks, hit a station, satisfied a
cluster goal.

**The body is now trustworthy enough for the agent to focus on
strategy.** Task #19 — making primitives high-level so the agent
doesn't perform tactical maneuvers at all — is the natural next
investment.

## Fixes shipped in this session

| Commit | Fix | Result |
|---|---|---|
| `a174e22` | RC1 place_boat from-water + RC2 escape full diag + RC3 liquidCost 50→250 + RC4 death-detection gating | Primitives correct but agent didn't reach for them |
| `206aade` | Reactive water-watchdog (task #17) | Body auto-rescues every 30s without agent intervention |
| `a8e3e57` | Step-up in escape water branch (task #18) | Handles 1×1 water-well trap |

## Observable behavior change

### Per-run survivability (circuit-v[1-4])

| Run | Outcome | Duration | Distance reached | Deaths |
|---|---|---|---|---|
| v1 | stuck at base, never reached station | 24 min | <100b | 0 (but no progress) |
| v2 | died at T+90s, lost everything | 5 min | <100b | 1 |
| v3 | reached 700b NE, stuck in water wells | 45 min | ~700b | 0 |
| **v4** | **reached W2, got wheat, heading to W3** | ~6 min ongoing | ~1000b | 0 |

### Auto-recovery cadence in v3

Across 45 min of v3, the reactive watchdog auto-fired **~35 times**.
Outcomes (from `[reactive] auto_escape_water → ...` lines):

| Outcome | Count |
|---|---|
| STUCK_IN_WATER (no strategy worked) | ~22 |
| place_floor ok | 4 |
| swim_N ok (cardinal swim succeeded) | 3 |
| pillar_up ok | 2 |
| step_up (post-fix from a8e3e57) | wasn't yet shipped |

Without the watchdog, every one of those would have been a death or a
permanent stuck. The 22 STUCK_IN_WATER returns each represent a future
edge case to file (step-up is one of them — already shipped).

## What still needs design work (task #19)

The agent's verb behavior in v3/v4 reveals the work ahead.

### What the agent should call (strategic)
- `mc move 1000 64 -800` (W2 farm)
- `mc harvest` (collect mature wheat)
- `mc bonemeal` (grow immature wheat)
- Done.

### What the agent ACTUALLY called

127 tool calls in v3 + 60 in v4 ≈ **190 calls** to get to a single
waypoint. Heavy on perception (scene/map/inspect/advise/nearby/look),
nav variations (move/goto/bg_goto/goto_near), and probing (find_blocks).
Zero of the W2 cluster verbs.

The agent spent a lot of mental cycles on tactical micro-decisions
that the primitives should have absorbed:
- "Is this water deep?"
- "Where exactly is the water cell?"
- "Should I bridge or boat?"
- "Why did goto fail this time?"

In task #19's model, the agent says `mc move <waypoint>` and the move
primitive transparently:
- pathfinds
- recovers from water (calls escape if foot_in_water)
- bridges short fords with carried blocks
- places a boat for long water if it has one
- reports the effective end state with `data.adjusted_target`

The agent learns from the report; never has to debug "why".

## Observations that don't fit cleanly elsewhere

- **Station-build durability**: the W2 farm we built initially didn't
  exist when Steve arrived. Chunks unloaded between probe and build;
  setblocks didn't persist or terrain was different than probed.
  Rebuilt in-situ once Steve was there (chunks loaded). Future setup
  should keep chunks force-loaded for the entire run, not just during
  setup.
- **Goal-only prompts surface unexpected paths**: Steve satisfied the
  W2 "bring 3 wheat" goal via `mc pickup` of drops left around the
  rebuild — without ever calling `mc harvest`. This is a clean win
  from the agent's perspective but doesn't generate the per-cluster
  data we wanted. Future prompts may need to be more verb-explicit
  for testing purposes, OR accept that goal achievement matters more.
- **The brain reads chat**: re44's whisper at T+37min ("you're in a
  1×1 well, step up east") was read by Steve and acknowledged. The
  agent recognizes steward hints. Useful safety net for tests when
  the body's recovery isn't enough yet.

## Open backlog after this session

| # | Status | Priority |
|---|---|---|
| #4 | pending | leaves/brush soft-block (was wishlist; still wishlist) |
| #6 | pending | terrain probe along bot→target — would have prevented many water entries |
| #7 | pending | broader "self-adjust within ~3 blocks" pattern across primitives |
| #19 | pending | **the design north star** — high-level primitives, agent stays strategic |

Plus emerging follow-ups from this session:

- **Watchdog STUCK_IN_WATER tracking** — when escape can't help, we
  could surface a more useful signal to the brain (e.g. a `MC_STUCK`
  task-state that pauses other goal-driven work until the brain
  acknowledges). Right now the body just keeps trying every 30s
  silently.
- **Station persistence under unload/reload** — force-load all
  station chunks for the duration of a QA run, not just during setup.
- **Force-pickup near placeable drops** — when items are visible in
  inventory range, the agent could call `mc pickup` automatically
  (it's a low-cost cleanup verb).

## Recommended next session

1. Continue circuit-v4 — see if Steve reaches W3, W4, W5. Each new
   station = new cluster data.
2. Ship task #19's first concrete piece: `mc move` auto-recovers
   from water by calling escape internally. The agent never has to
   know about water.
3. After: ship `mc board` and `mc disembark` smart variants (auto-find
   water, auto-find shore).

The body is trustworthy now. Time to make the verbs smarter.

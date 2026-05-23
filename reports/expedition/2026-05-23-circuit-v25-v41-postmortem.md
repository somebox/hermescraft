# circuit v25-v41 — long session postmortem (20 commits, 0 successful runs)

- **Date:** 2026-05-22 → 2026-05-23 (overnight)
- **Branch:** `experiment/hermes-agents`
- **Commits:** 20 in this session (8204c7d → 74b5675)
- **Suite:** 458 → 504 tests, all green
- **W1/W2/W3 completed:** None
- **Boats consumed:** ~30 across v25-v41; never sailed a complete journey
- **Session outcome:** body is robust on every measurable axis;
  Steve still ends up swimming or stuck

## What we fixed

| # | What | Verified by |
|---|---|---|
| F1 | `stock-steve.sh` no fall damage (y=80 → y=65 + resistance) | HP=20 on every restock |
| F2 | `place_boat` refuses BOT_IN_WATER (gated) | unit test |
| F3 | `walk_to_entry` post-water guard | unit test |
| F4 | reactive `auto_escape_water` give-up after N fails | unit test |
| F5 | prompt: check inventory before crafting | prompt edit |
| F6 | `sail_to` retry-loop detector | unit test |
| F7 | `bg_goto` retry-loop detector | unit test |
| F8 | **CLI surfaces Phase-2 `next_action_hint`** (meta-fix; agent never saw hints before) | unit test |
| F9 | `sail_to` in-water rescue branch | unit test |
| F10 | `nearest_water_candidate` via findBlocks scan to 64b | unit test + live |
| F11 | prompt: use mc advise after 2 failed nav attempts | prompt edit |
| F12 | candidate filter: surface water only (not cave pools) | live (y=62 vs y=58) |
| F13 | POND_DISCONNECTED surfaces nearest non-pond water | unit test |
| F14 | `mc advise` handles OpenRouter timeouts gracefully | unit test |
| F15 | candidate filter: navigable depth (rejects 1-deep shallows) | unit test |
| F16 | `findExitShore` checks sloped beach (y+1) | unit test |
| F17 | `mc advise --target=X,Y,Z` (negative coord safety) | unit test |
| F18 | `SAIL_TO_RETRY_LOOP` carries candidate in hint | unit test |
| F19 | partial-route sanity check loosened (10b sail accepted) + retry counter resets on movement | live (Steve sailed 70b before timeout) |
| F20 | **advise system prompt teaches `mc sail_to`** (not the gated 4-verb chain) | live (advise output now says sail_to) |

Plus stop-script audit (`8204c7d`) and the meta-fixes catching
detached-method bugs (`0ad538b`, `970d33b`).

## What still doesn't work

The agent **gets to the right area** and **sees correct hints**, but
consistently fails at one specific step: **walking from inland to the
shore cell.**

v41 trajectory (8 minutes of agent time):
- 00:29: spawn at base (350, 64, -594), HP 20, 2 oak_boats
- 00:30: `mc sail_to -300 63 -100` → BOAT_REQUIRED (correct: no water at base)
- 00:30: `mc advise` → recommends `mc sail_to -300 63 -100` (F20 working ✓)
- 00:31: `mc bg_goto 300 64 -200` → started but agent abandoned
- 00:32–00:34: `mc move 348 64 -540`, `-570`, `-590`, `-610`, `-630` (chained mc move calls)
- 00:34: **Steve at (348, 66, -622)** — overshot, now ON water
- 00:35: Steve at (293, 62, -569) — IN water now
- 00:35: Steve at (257, 62, -541) — drifting SW through ocean
- Final: ~~300 blocks from start, no progress toward any waypoint, swimming

Agent reasoning at the critical moment:
> "Good intel — water is nearby but the route is through unloaded chunks. Let me walk southwest to load terrain"

The agent walked SW with `mc move` (chained, no awareness of shore
proximity) and walked **past** the shore into open water.

## Root cause

**The body has all the data but surfaces the wrong coord to the agent.**

When sail_to refuses with `NO_NAVIGABLE_ROUTE`, F10/F12/F15/F18 ship
`nearest_water_candidate` — a navigable water cell. The hint says:

```
Hint: mc bg_goto 311 62 -569  # nearest water — then mc sail_to ...
```

But **(311, 62, -569) is a water cell**, not a walkable stance. `mc
bg_goto` refuses target-unstandable. The agent then ignores the hint
and uses `mc move` to walk toward "the area" — overshooting into
deep water.

The body has the right concept (`findEntryShore` near
`entry_water`) but exposes water coords externally and shore coords
only internally. The agent never gets a "walk to THIS coord and call
sail_to" instruction — it gets "walk to this WATER cell" which
won't pathfind.

Secondary issues:
- F19 retry-counter reset (32b threshold) doesn't clear when the
  agent shuffles around within a small radius — counter stays sticky
  across 4 quick attempts in the same area.
- Advise's BFS-via-LLM is slower (15-30s) than the agent expects,
  encouraging "let me just walk that way" shortcuts.
- The `mc move` verb is synchronous and runs the pathfinder. When
  the agent chains `mc move 348 64 -570, -590, -610, -630`, each
  call pathfinds independently — no "stop when you hit the shore"
  awareness.

## Why test count keeps growing but live runs don't improve

The 504/504 green suite verifies **logic** — given a known mock world
state, the BFS/refusal/candidate path produces the right envelope. It
does **not** verify **interaction**: that the coord we ship in a hint
is something `mc bg_goto` will actually walk to. The arena tests at
`tests/functional/test_water_navigation.py` would catch this but are
@xfail pending fixture work.

We've been refactoring at the wrong abstraction level. Each Fxx polishes
an internal: tighter classifier, smarter scan, better fallback. The
agent-facing API — "given this verb + observed_state, what does the
agent DO next" — hasn't been the unit of work. F8/F20 are the only
fixes that operate at that level, and they're the only ones with
visible behavioral impact.

## Action items, ordered by ROI

| # | Action | Why |
|---|---|---|
| **1** | **F21: `nearest_water_candidate` → `nearest_shore_stance`** | The single highest-impact fix. Compute the walkable cell adjacent to the candidate (via `isShoreCell` already-existing helper) and surface THAT in the hint. The agent gets a coord `mc bg_goto` will actually accept. |
| 2 | **Skip-test the arena fixtures** to validate F21 end-to-end. The "fixture iteration" blocker on `tests/functional/test_water_navigation.py` should not block F21 verification — write a minimal scenario that uses a /fill'd stone pool with sand beach. | Without arena verification we'll keep shipping fixes that mock-test green and live-fail. |
| 3 | **Cut F19's reset distance from 32 → 12 blocks** | 32b was conservative; in practice the agent shuffles in a 10-15b cluster between failures. Counter holds when it shouldn't. |
| 4 | Body-side `mc move` retry-loop counter (mirror of F7 but for the sync verb) | The agent escaped F7's bg_goto loop by switching to `mc move`. Same retry guard applies. |
| 5 | Dashboard: live token-cost / model-call counter | We're flying blind on cost per circuit. Should be one number per run. |
| 6 | F11 prompt: clarify when to call advise vs when to just bg_goto to the body's suggested coord | The current prompt says "after 2 failed nav attempts" but doesn't differentiate failed-with-no-info from failed-with-candidate. |

The hard truth: **F1-F20 are correct fixes for real bugs**, but the
agent's behavioral fate hinges on F21. Without it, every advise/sail_to
refusal lands the agent on a coord it can't walk to, and it
improvises by mc-moving past the shore.

## Tasks closed by this session

#21–#33 (pre-session), #38–#52, #54–#58 — 23 task closures.

## Next session opening move

Implement F21 first. Re-launch v42. If Steve reaches W1, the F1-F20
work is validated. If he still overshoots, the problem is upstream
of the body — likely persona/prompt or model choice.

# circuit-v5 series — making the boat workflow actually work

**Date:** 2026-05-21
**Runs:** v5, v5b, v5c, v5d, v5e, v5f, v5g, v5h, v5i (nine attempts)
**Goal:** ship the four-phase backlog (tasks #4, #6, #7, #19, #20) and
validate live against the five-station survival circuit.
**Result:** body workflow shipped, validated, and locked down with
393 → 403 passing tests. Steve sailed ~670 blocks of a 720-block water
crossing toward W1 mining outcrop — the first successful long-distance
boat use of any expedition run. Still no station completion;
remaining failure mode is HP/recovery near the shore at journey's end.

## What we set out to do

Coming out of circuit-v3/v4, the trustworthy body was validated for
short-range work but the agent kept driving the bot into water and
drowning over long distances. The pre-session backlog had five tasks:

| # | Title | Layer |
|---|---|---|
| #4 | Soft-block allowlist for navigation | Pathfinder |
| #6 | Target-bearing terrain probe in advise | Perception |
| #7 | Bot actions: self-adjust within reason | Action primitives |
| #19 | Design principle: high-level primitives | Action primitives |
| #20 | Reactive watchdog: backoff + idle | Reactive layer |

All five shipped before the live runs started.

## Commits shipped (in order)

| Commit | Headline | Layer |
|---|---|---|
| `1a1b14c` | reactive watchdog backoff + idle | Phase A |
| `2f9553d` | pathfinder soft-block allowlist | Phase A |
| `b550fe9` | self-adjust place_boat/till/plant/bucket_* | Phase B |
| `13af777` | high-level move/board/disembark/craft | Phase C |
| `9a87345` | route_preview + advise --target | Phase D |
| `7c2e9bd` | advise log raw_preview + JSON fence strip | Diagnostics |
| `a8f6c9c` | boat-entity-by-type detection | v5d fix |
| `02c6c22` | bg_goto BOAT_REQUIRED preflight refusal | v5c fix |
| `d0ce446` | task dispatch surfaces synchronous refusals | v5c fix |
| `bab56e0` | place_boat walk-into-water fallback | v5d fix |
| `f0bbb35` | place_boat shore-water self-adjust | v5d fix |
| `c00d451` | BOAT_REQUIRED hint → mc board (no-args) | v5d fix |
| `b8d90bb` | run-steve-bot.sh sources .env | v5d fix (infrastructure) |
| `eaf0c5c` | mc sail detour + disembark auto-escape | v5f fix |
| `846d49d` | mc sail timeout auto-scales with distance | v5h fix |

15 commits, all live-validated against successive circuit runs.

## Per-run results

| Run | Duration | Outcome | Lesson learned |
|---|---|---|---|
| v5 | killed | walked into lake, swam, dug sand to escape | task #21 idea: refuse long water walks |
| v5b | manual stop | same swim-instead-of-boat pattern | refusal hadn't landed yet |
| v5c | killed | refusal fired but place_boat coord was deep water | shore-water self-adjust needed |
| v5d | killed | place_boat NO_STANCE in open water | walk-into-water fallback |
| v5e | crashed (token limit) | place_boat target was base oak_planks | prompt was guiding to wrong verb |
| v5f | drowned | **first `mc board` success**, then sail wedged | sail detour + recovery hint |
| v5g | model error | empty response from OpenRouter | transient, not a code bug |
| v5h | drowned at -252,-130 | **670/720 blocks sailed toward W1** | sail timeout too short |
| v5i | drowned near W1 | confirmed pattern with timeout scaling | HP management is next |

The arc: every run identified one or two specific failure modes that
became the next commit. By v5h the boat workflow had end-to-end
plumbing; v5i confirmed the same with relaxed timeouts.

## Behaviors validated live

These are the things that *demonstrably worked* in production:

### Refusal layer (Phase D + task #21)
- `mc bg_goto -300 63 -100` (720 blocks west, crosses big lake) returns
  `BOAT_REQUIRED` synchronously in the HTTP response, not via task
  polling. The agent sees `code: BOAT_REQUIRED` immediately and acts on
  the `next_action_hint`. **Confirmed v5c onward.**
- The hint shape `Walk to the shore at (X, Y, Z) then call mc board` is
  legible — multiple agent thoughts reference it ("Route crosses water
  — time to use the boat! Following the BOAT_REQUIRED instructions").

### Boat placement (commits `a8f6c9c`, `bab56e0`, `f0bbb35`, `b8d90bb`)
- `mc board` (no-args) from the shore stance: finds water within 12
  blocks → calls `place_boat` → PaperMCP server-side summons →
  detects the boat entity via `isBoatEntity()` checking both name and
  type → mounts. **First confirmed success: v5h, 6.0s wall time.**
- `data.auto_placed` envelope carries the synthesis trail.

### Sail (commits `eaf0c5c`, `846d49d`)
- Single `mc sail -300 63 -100` call sailed Steve ~200+ blocks per
  60s timeout. In v5h Steve made FOUR sail calls covering ~670 blocks
  of the 720-block crossing.
- TIMEOUT envelope includes `next_action_hint: mc sail X Y Z` to
  continue — distinguishes partial progress from genuine stuck.

### Underlying infrastructure
- `run-steve-bot.sh` sources `.env`. Discovered live (commit `b8d90bb`)
  when boat-place fallbacks were silently disabled the entire previous
  session.

## Remaining failure modes

Steve never finished W1. Both v5h and v5i died within 50 blocks of the
mining outcrop with the same pattern:

1. Sail brings Steve to (-252, 62, -130) or thereabouts.
2. Boat wedges in shallow water at the shore approach.
3. Steve's HP has been ticking down (drowned mobs in lake? slow drowning?).
4. Agent tries `mc eat` while mounted — fails (can't eat in boat).
5. Agent tries `mc disembark` — fails (disembark auto-sail-to-shore
   itself wedges).
6. Steve dies, respawns at base, loses everything.

The body's auto-escape after dismount works in unit tests but the
sequence in practice doesn't fire because the agent never reaches
`mc disembark` cleanly — sail's TIMEOUT envelope is the response the
agent sees, and it keeps retrying sail.

New backlog tasks (added during this session):

- **#21** (completed) — bg_goto/move: refuse long water routes
- **#22** (pending) — auto-break disposable terrain (dirt/sand) when
  escaping water or boxed in
- **TBD** — mc sail should know when to stop sailing and start
  disembarking. Right now the agent has to make that call from the
  TIMEOUT envelope.
- **TBD** — mc eat should work while mounted. (Vanilla MC allows
  eating in boats; mineflayer's bot.consume may need a different
  invocation path.)
- **TBD** — when boat wedges within N blocks of dry shore, sail should
  return SHORE_REACHED (not TIMEOUT) and recommend disembarking.

## Test count growth

| Phase | Baseline | Δ | Final |
|---|---|---|---|
| Phase A (tasks #4, #20) | 327 | +18 | 345 |
| Phase B (task #7) | 345 | +12 | 357 |
| Phase C (task #19) | 357 | 0 | 357 |
| Phase D (task #6) | 357 | +22 | 379 |
| circuit-v5* fixes | 379 | +14 | 393 |
| Functional locks (post-session) | 393 | +10 | 403 |

**403 tests passing, 0 failing.** +76 over the session, most of them
unit tests; the new `bot/test/integration/boat-workflow.test.js` adds
10 functional tests that exercise the boat-stack handlers end-to-end
against a mock bot rather than just testing pure helpers.

## What the body now does autonomously

Before this session, the agent had to know:
- Whether the route crosses water (manual `mc advise` or `mc map`)
- The exact water cell to place a boat at
- How to recover from a stuck boat (often impossible)
- That PaperMCP fallbacks exist for shallow-water placement

After this session, the body handles all of those:
- `mc bg_goto` refuses water routes with explicit shore-stance hint
- `mc board` (no-args) handles finding water + placing + mounting
- `mc sail` detours around obstacles, scales timeout to distance,
  returns retry hint on partial progress
- `mc disembark` chains auto-escape if it lands the bot in water
- `place_boat` self-adjusts to shore-water within 6 blocks, walks
  into water if no dry stance

The agent's mental model collapses from
"`mc place_boat X Y Z` then `mc board <id>` then `mc sail` then `mc disembark`"
(four verbs with coord guessing) to
"`mc bg_goto`, read the hint, `mc board`, `mc sail`, `mc disembark`"
(three verbs, all coord-free).

## What still needs the agent's strategic attention

- Choosing WHICH waypoint to attack first (boats are gone after they
  break — Steve has 2 oak_boats total; the circuit has 2 water
  crossings: W1 and W4, so the agent must conserve)
- Recovery after a death (where did I die? what's salvageable?)
- HP management mid-sail (when to disembark vs. keep sailing)
- Acknowledging when the body refused something and changing plan
  rather than retrying the same coord

## Next session

1. Lock-down: extend `bot/test/integration/boat-workflow.test.js`
   with route_probe + bg_goto preflight refusal coverage (HTTP-level).
2. Investigate why Steve drowns within 50 blocks of W1 every time:
   probably hostile mob presence + slow approach + sail unable to
   tell "you're at the shore, disembark now."
3. Tasks #22 (disposable terrain), and the TBDs above.

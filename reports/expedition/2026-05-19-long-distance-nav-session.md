# Long-distance navigation QA — session summary (2026-05-19 → 2026-05-20)

Two-evening session focused on testing Steve's ability to walk multi-km
expeditions between waypoints. Started with the hydration-trap arc
(from the prior session), then built out per-run logging infrastructure,
then ran 6 expedition attempts (exp1 through exp6 — numbering offset
because exp4 became exp5 became exp6 as bugs surfaced and we restarted).

## What shipped

Commit chain (newest → oldest in this session):

| Commit | What |
|---|---|
| `631dbb5` | water primitives: PaperMCP fallbacks hardcoded `landfolk-test` world — fixed across place_boat/board/sail/disembark/bucket_empty |
| `14a10db` | advise prompt: macro route awareness — recognise ocean barriers, recommend boats |
| `7b0539b` | pathfinder: depth-aware water avoidance (shallow fords allowed) + `exp.sh watch` merges thinking + positions + events |
| `d16754d` | mc escape: swim-to-surface phase before land scan + advise prompt forbids `/kill` recommendations |
| `6b89c7e` | postmortem: exp3 drowning + `exp.sh watch` subcommand |
| `1c0e202` | exp: deterministic per-run logging convention (`scripts/exp.sh` + `exp_lib.py`) |
| `761229b` | `mc advise`: read reason from `globals.reason` (post-stripGlobalFlags) |
| `48b6741` | `mc harvest`: smart Y auto-detect + actionable NOTHING_TO_HARVEST hint |
| `3cfa2c1` | ACTION_CAPS_MS: raise goto 5s→5min for long-distance bg_goto |
| `e55d4e7` | pathfinder: cap cumulative Y-drop relative to bot foot Y |
| `be9d652` | preflightNav: bypass NAV_TARGET_UNSTANDABLE for unloaded-chunk targets |

### Highlights

- **Per-run logging convention** (`scripts/exp.sh` + `scripts/exp_lib.py`
  + `scripts/exp_watch.py`). One dir per run at
  `/tmp/hermescraft/runs/<RUN_ID>/`, with `positions.jsonl` /
  `events.jsonl` for objective post-analysis, `current` symlink so
  monitoring scripts always find the active run, structured
  `summary.md` on stop. See `docs/experiments/run-logging.md`.

- **`exp.sh watch`** merges four streams (assistant reasoning,
  assistant content, tool calls, tool outputs, position samples,
  structured events) into one colourised live tail. Replaces the
  earlier ad-hoc `watch-steve.py` + tail combo.

- **Long-distance navigation now actually works.** Three fixes:
  1. `be9d652` — preflight bypasses NAV_TARGET_UNSTANDABLE when the
     target chunk is unloaded (was refusing every long bg_goto target).
  2. `3cfa2c1` — pathfinder wallclock cap raised 5s → 5min for `goto`
     and 12s → 30s for `move`. The 4s no-progress watchdog still
     catches real stalls.
  3. `e55d4e7` — cumulative Y-drop cap relative to bot foot Y so
     pathfinder doesn't drift Steve down a slope into water.

- **`mc escape` survives deep ocean.** Step 0 is now "spam jump for
  3.75s to ride buoyancy to surface". After surfacing the land-search
  radius widens from 4 → 16 blocks. exp3 drowning would not have
  killed the new code.

- **Pathfinder allows shallow fords.** `BOT_AVOID_WATER` now accepts
  `hard | shallow (default) | off`. Shallow mode wraps `safeOrBreak`
  to refuse only water cells without solid floor below (wading
  threshold). Long detours still get expensive via `liquidCost=50`.

- **Advise LLM is route-aware.** When the digest sees water between
  bot and target (or repeated NAV_BLOCKED toward a far target), it
  now recommends boats with the exact verb sequence (`mc place_boat`
  → `mc board` → `mc sail` → `mc disembark`). Also explicitly forbids
  recommending `/kill` for stuck recovery.

- **All five water primitives' PaperMCP fallbacks were broken** —
  hardcoded `execute in landfolk-test run ...` for a world that only
  exists in test fixtures. Production server's overworld silently
  ignored every fallback. Fixed across place_boat / board / sail /
  disembark / bucket_empty.

### Tests

327 passing (started session at 312). Net +15 across:
- `nav-helpers.test.js` (+5) — `targetChunkLoaded` chunk-unloaded probe
- `bot-manager.test.js` (+7) — Y-drop cap + shallow water mode
- `farming.test.js` (+7) — `resolveHarvestY` smart Y auto-detect

## In-game results

By the time we paused exp6:
- **W5 (enchanted_golden_apple) collected** — 3× (artifact of earlier
  duplicate spawn cleanup; the duplicate-prevention now lives in
  `/tmp/hermescraft/spawn-items.sh`).
- Other 4 waypoints (W1 diamond, W2 emerald, W3 netherite_ingot,
  W4 totem_of_undying) still pending. Steve was on the W4 leg when we
  paused, stuck on a peninsula with the boat-placement bug above.
- Total walked across all runs: ~1500–3000 blocks per run, peak pace
  ~140 b/min once cap + preflight + Y-cap landed together.

## Open backlog (next session priorities)

| # | Task | Why it matters |
|---|---|---|
| #4 | Allow bot to clear harmless leaves/brush when stuck | Steve repeatedly stalled in dense forest; `canDig=false` keeps him from breaking leaves/grass that pathfinder respects as obstacles. |
| #5 | Expedition prompt: include boats + axe in starter loadout | exp6 needed 2× hand-delivered oak_boats via RCON; bootstrap from zero is too long for a navigation test. Boats + axe should be in the prompt's loadout for ocean-crossing waypoints. |
| #6 | Add target-bearing terrain probe to perception bundle | The advise LLM now suggests boats when it sees water on the map (32-block radius). For 1km+ targets it's inferring. Active sampling along the bot→target line — force-load chunks, blockAt every ~15 blocks — would give concrete "600 blocks open water" data. Lets advise be CONFIDENT not GUESSING. |
| #7 | Bot actions: self-adjust within reason, report what changed | exp6 fingerprint: Steve thrashed for 15 min trying `mc place_boat` with wrong coords. Many primitives are too brittle. Generalised pattern: actions auto-adjust within ~3 blocks when given a wrong-but-close target, and return `data.adjusted_target` so the agent learns. Applies to `place_boat`, `place`, `till`, `plant`, `bucket_*`, `fish`. Shared helper would extract preflight + adjustment + report. |

Plus the smaller followups noted inline in reports:
- Investigate autoEat behaviour during long bg_goto (food=13 didn't
  trigger auto-eat in exp3; threshold is 14).
- Down-rank `maintain_*` autonomous goals during expedition mode so
  they don't pull Steve into resource-gathering detours.

## How to resume

```bash
# Restart everything (or just bot+viewer if no agent needed)
./scripts/run-steve.sh

# Start an expedition run with the new logging
./scripts/exp.sh start expedition

# Watch live (Ctrl-C to exit)
./scripts/exp.sh watch

# After the run
./scripts/exp.sh stop          # write summary, clear current
./scripts/exp.sh analyze       # post-mortem stats
```

Pause-state at end of session: all services stopped; ports 3000 / 3001 /
4001 free; world state intact (items at W1-W4 are singletons, Steve at
the base or wherever last seen — restock + heal before resuming via
`/tmp/hermescraft/stock-steve.sh`).

# Live pinch test — pilot-navigator vs flint baseline

> **Update 2026-06-06 (later same day):** the headline finding here did **not**
> replicate. A × 3 follow-up on a fair task (start position without the terrain
> trap) found wide actually beats narrow on every metric except success rate
> (which ties at 3/3). See [`2026-06-06-pinch-test-replication.md`](./2026-06-06-pinch-test-replication.md)
> for the corrected analysis. The original run is preserved below for the
> record. Treat its conclusions as **not supported by replication**.

**Date:** 2026-06-06
**World:** live Paper MC server at 192.168.1.202:25565
**Body:** flint Mineflayer process on :3002
**Model:** deepseek/deepseek-v4-flash (both sides)
**Task:** navigate the bot from (33.5, 69, -49.5) to `:muster_south:` (31, 64, -29) — about 21 blocks south-east-down

## Headline

| | Narrow (pilot-navigator) | Wide (flint) |
|---|---|---|
| **Outcome** | ✅ done | ❌ blocked (AUTO_STUCK_BLOCK) |
| Worker runs | 1 | 2 (one reclaimed, one auto-blocked) |
| API calls | 5 | 15 (combined) |
| Tokens in (sum) | 265,455 | 925,277 |
| Tokens out (sum) | 1,799 | 3,677 |
| Turn-1 in-context | 52,191 | 38,797 |
| Final in-context | 53,959 | 69,248 |
| Wall time | 52 s | ~100 s + auto-block |
| `mc` invocations | 4 | ~21 across both runs |
| Ended at | (32.7, 64, -29.5) — 1.6 blocks from target | (33, 66, -50) — never moved off start |

The narrow worker solved the task. The wide worker got trapped on the descent and didn't escape.

## What this is (and isn't)

This is the test the prototype plan deliberately scoped out — the architecture's
core bet from `docs/architecture/target.md` § "What success looks like":
*smaller scope per agent invocation produces better outcomes than today's
wide skill-catalog workers, on the same task.*

It's a **single trial per side**, not a controlled multi-run benchmark.
Variance hasn't been measured. Treat the headline as a strong signal, not
proof.

## Setup

Identical:

- Same MC server, same world, same body (flint Mineflayer process on port 3002)
- Same model: `deepseek/deepseek-v4-flash` via OpenRouter
- Same starting position: (33.5, 69, -49.5)
- Same target: `:muster_south:` at (31, 64, -29)
- Same task body text: "Navigate the bot to mark :muster_south:..."

Differing:

- **Narrow** spawned on `~/.hermes-proto-agent-arch/profiles/pilot-navigator/` with
  `--skill agent-navigator --skill minecraft-navigation --skill minecraft-survival`
  (4 total: those 3 plus the built-in kanban-worker).
  SOUL.md is the short generated one from `setup.sh`.
- **Wide** spawned on the existing `~/.hermes/profiles/flint/` profile, which
  loads the full hermescraft skill catalog (minecraft-{navigation, mining,
  building, blueprints, combat, chores, farming, flint-mission, goals,
  mapping, steward-*}) plus flint's role-built-up SOUL.md.

## What happened — narrow

5 API calls in 52 s wall time. Token totals: 265k in, 1.8k out. 98% cache hit
on the calls that report cache stats.

Bot reached (32.7, 64, -29.5) — about 1.6 blocks from the target. Worker
completed cleanly, emitted §7 handoff metadata (`exit_pos`, `exit_facing`,
`arrived_at: 'muster_south'`).

The four `mc` tool calls were tight: probably `mc status`, `mc marks`,
`mc move @:muster_south:`, then a status check at completion.

## What happened — wide

**Run 12** (started 19:45:00): the worker spawned with the full flint
profile context. Made 2 API calls (38.8k + 55.6k tokens in). The
`scripts/auto-stuck-check` watcher reclaimed it after detecting it wasn't
making progress.

**Run 13** (started 19:46:17, blocked 19:46:49): a fresh worker spawned.
Same starting state. Made 13 API calls (sum: 488k tokens in, 2.3k out).
Bot moved a few blocks down from (33.5, 69, -49.5) to (33, 66, -50), then
got stuck. The bot HTTP API returned:

> `ERROR [move]: Cannot navigate — you are trapped at 33,66,-50. All 4
> cardinal dirs blocked at foot or head. Use mc dig <coord> to break out,
> or mc escape if available.`

The worker did not call `mc dig` or `mc escape`. After 4 rounds of
identical `move:done` actions the auto-stuck-check escalated to BLOCK with
fingerprint `d7861d85279d`.

Final position: (33, 66, -50). Final state: `blocked`.

## Why the wide worker failed

The bot's error message **literally told the worker what to do** (`mc dig` or
`mc escape`). The narrow `agent-navigator.md` skill ships with §5 escape
rules and a verb table that explicitly lists `mc escape` and a `mc move`
retry budget. The wide flint profile's SOUL has many priorities competing
(orchestration concerns, Steward role context, mining-and-building options)
and didn't deterministically reach for the in-context escape primitive.

The narrow worker likely never even got into the trap state — its
`mc move @:muster_south:` resolved the mark, and the bot pathfinder
descended through a different cell. Possibly the wide worker chose a
different first verb (`mc goto X Y Z` instead of `mc move @MARK`) and
ended up in the trap.

## What this tells us

1. **The narrow bundle worked on a real task the wide bundle blocked on.**
   That's a stronger result than the architecture asked for.
2. **The "turn-1 in-context tokens" comparison favored wide** (38.8k vs
   52.2k) — the narrow worker preloads its agent bundle (because the
   kanban-worker SOUL pattern calls `skill_view` on the first listed skill
   on turn 1) whereas flint's many skills are lazy. So the architecture's
   "smaller context" hypothesis isn't supported by the *initial* context
   measurement.
3. **Total tokens-to-resolution still favored narrow ~3.5×** because the
   wide worker did 3× more turns AND failed. If the wide worker had also
   succeeded, the per-turn token bill might have been comparable.
4. **Mark resolution matters more than verb-count.** The interesting
   architectural lever isn't "fewer skills" — it's "the right escape
   rules and verb-choice are *eager*, not buried behind progressive
   disclosure."

## What this is NOT yet evidence of

- A single trial. No variance estimate. A second narrow run might fail; a
  second wide run might succeed.
- One target, one terrain pocket, one bot, one model, one day. Don't
  generalize to "narrow always wins."
- The wide failure was partially the wide skill bundle and partially
  flint's history-rich SOUL.md (built up across weeks of fleet ops).
  Some of that may transfer benefit to *other* tasks the wide bundle is
  asked to do.
- The narrow worker still bilks 52k turn-1 tokens. The "small per-card
  context" idea from the architecture isn't free.

## Suggested next steps

- **Replicate × 3 each side** to get variance. If narrow wins 3/3 and
  wide blocks 3/3, the signal is real.
- **Try a different starting position** that doesn't lead to the
  (33, 66, -50) trap, so wide gets a fair shot at completion.
- **Inspect what `mc` verbs each worker actually chose.** Use the bot's
  HTTP access log (or proxy it for the run). Confirm the trap-vs-not
  hypothesis.
- **Profile by SOUL size separately from skill count.** Re-run narrow
  with flint's SOUL but only navigator skills, and vice versa, to
  separate "skill catalog effect" from "SOUL prior effect."

## Reproducibility

The narrow run is reproducible end-to-end:

```bash
export HERMES_HOME=$HOME/.hermes-proto-agent-arch
# Repoint MC_API_URL to live flint port (3002) in pilot-navigator/.env
# Or use whatever bot port is online
hermes kanban create --tenant proto-agent-arch \
  --assignee pilot-navigator \
  --skill agent-navigator --skill minecraft-navigation --skill minecraft-survival \
  --body "Navigate the bot to mark :muster_south:..." \
  "to :muster_south:"
hermes kanban dispatch --max 1
```

Wide-side reproduction is the same but with `--assignee flint` and against
the real `~/.hermes`.

Pre-pinch agent.log backups for both sides:

- `~/.hermes-proto-agent-arch/profiles/pilot-navigator/logs/agent.log.bak-pre-pinch`
- `~/.hermes/profiles/flint/logs/agent.log.bak-pre-pinch`

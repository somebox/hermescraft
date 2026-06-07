# landfolk-test environment review (pre trial-2)

Short audit of the world-side + Hermes-profile-side settings that
affect trial 2 outcomes. Companion to
[`two-bot-trial-2-prereqs.md`](two-bot-trial-2-prereqs.md).

## Landfolk-test world (server-side)

Healthy and well-curated for testing:

| Setting | Value | Why it matters |
|---|---|---|
| Game mode | SURVIVAL | Standard; bots act like players |
| Difficulty | PEACEFUL | No hostile mob damage |
| Spawn | (0, 65, 0) | Tester's home; demo seed is at (300, 65, 300) |
| `doMobSpawning` | false | No surprise zombies |
| `doDaylightCycle` | false | Always day → no torch logistics |
| `doWeatherCycle` | false | No rain/thunder interruptions |
| `keepInventory` | true | Death doesn't lose hard-won inventory |
| `doImmediateRespawn` | true | No respawn-screen pause |
| `doInsomnia` | false | No phantoms |
| `mobGriefing` | false | Creepers (already off) don't blow up builds |
| `naturalRegeneration` | true | HP regenerates from food |
| `doTileDrops` | true | **Mining drops items** — required for cobble loop |
| `randomTickSpeed` | **0** | Scheduled ticks off — fire doesn't spread, crops don't grow naturally; item despawn appears unaffected (item entities tick separately) |
| `spawnRadius` | 10 | Default; not relevant for the trial |

**MC server (process-wide):**

| Setting | Value |
|---|---|
| `network-compression-threshold` | 256 |
| `simulation-distance` | 10 |
| `view-distance` | 12 |
| `max-players` | 10 |
| `spawn-monsters` | true (overridden by landfolk-test gamerule) |

**Findings:**

- The world is **fit for purpose**. No setting actively works against the trial.
- `randomTickSpeed: 0` is the one quirk to track — if a future card needs grass-to-dirt aging or wheat ripening, it would silently fail. The wheat-farm capstone (separate session) should re-enable it.
- `network-compression-threshold: 256` is tight; Mineflayer packets above 256 bytes get compressed. Default for vanilla servers; nothing to change.

## Hermes pilot profiles (worker-side)

Trial 1 ran with a **minimal config.yaml** that omitted the live fleet's tuned settings:

| Section | Trial 1 (pilot-pip) | Trial 2 (after fix) | Source |
|---|---|---|---|
| `model.context_length` | 250000 | 250000 (same) | Both |
| `compression` | **missing → defaults** | `enabled: true, threshold: 0.7, target_ratio: 0.3` | Matches flint |
| `context.engine` | **missing** | `compressor` | Matches flint |
| `memory` | **missing → defaults work but unspecified** | `enabled: true, char_limit: 2200, flush_min_turns: 6, nudge_interval: 10, user_profile_enabled: true` | Matches flint |
| `tool_output.max_bytes` | **missing** | 50000 | Matches flint |
| `tool_output.max_line_length` | **missing** | 2000 | Matches flint |
| `tool_output.max_lines` | **missing** | 2000 | Matches flint |
| `prompt_caching.cache_ttl` | **missing** | 5m | Matches flint |
| `terminal.env_passthrough` | **missing** | `[MC_API_URL, MC_USERNAME, _MC_API_URL_LOCKED, HERMES_KANBAN_*, HERMES_HOME]` | Matches flint, dropped fields not relevant for proto |

### Why this matters for trial 2

Trial 1 evidence:

- **z_mine session reached 86,000 tokens** before being killed. Far from the 250k cap but already large. With trial 2's 13-card graph (vs trial 1's 11), longer sessions are likely. **Compression at threshold 0.7 means compression fires at ~175k tokens** — well-positioned for safety.
- **Memory tool worked with defaults**: pip's `MEMORY.md` has 5 well-shaped entries from the trial. But: trial 1 didn't exercise the `nudge_interval` (would have nudged the model to save more memory in long sessions) or the `user_profile_enabled` (which builds a longitudinal model of operator preferences). With explicit settings, behaviour is reproducible across Hermes upgrades.
- **Tool output caps**: trial 1's `mc nearby 16` output was 813 chars; `mc inventory` outputs were small. Trial 2 may invoke larger `mc observe` or `mc map --radius 32` responses; the 50000-byte cap prevents runaway context bloat from a single tool call.
- **Terminal env passthrough**: trial 1 worked because the worker process inherits env from its parent, but if the bundle ever shells out (e.g. `mc batch` invocations from a script), the child needs MC_API_URL too. Explicit passthrough is defensive.

### What was applied

`prototypes/agent-arch/setup-pilot-pip-zee.sh` updated to write the full config. **Idempotent** — re-running overwrites with the new sections. Verified:

```bash
prototypes/agent-arch/setup-pilot-pip-zee.sh
# → wrote pilot-pip/config.yaml + pilot-zee/config.yaml
# → 6 new sections present in both

HERMES_HOME=~/.hermes-proto-agent-arch hermes config check
# → Config version: 27 ✓
```

## What's not changed

Deliberately left untouched:

- `agent.max_turns: 200` (vs flint's 150). The pilots may need more turns for the longer 13-card chain; 200 is sane.
- The full `flint/config.yaml` includes ~30 other sections (browser, dashboard, voice, slack, etc.) that don't apply to a Mineflayer worker. Importing them all would add noise.
- `terminal.backend: local` (matches what flint uses for non-containerised workers). The proto rig is local-only.
- `auxiliary` (Nous client) — trial 1 surfaced "Nous unauthenticated" warnings; that's a known auxiliary feature we don't need.

## Pre-trial-2 checklist

- [x] `setup-pilot-pip-zee.sh` writes compression + memory + context + tool_output + terminal + prompt_caching.
- [x] `hermes config check` against the proto HERMES_HOME is green.
- [ ] After `scripts/reset-open-test.sh`, confirm `~/.hermes-proto-agent-arch/profiles/pilot-pip/config.yaml` has `compression.enabled: true`.
- [ ] Compare token count in a trial-2 zee miner session vs trial 1's 86k — compression should kick in around 175k if a session gets that long, and trim back to ~52k (target_ratio: 0.3).

## Player + world snapshot (verified 2026-06-07)

The fixture targets `world: landfolk-test`. After `scripts/colony start --all` with `MC_HOST=192.168.1.202` and a fresh fixture prep, the server reports:

| Player | Dimension | Role in trial 2 | Bot port | Pilot profile |
|---|---|---|---|---|
| Pip | `minecraft:landfolk-test` | demo bot (pip's 7-card lane) | 3005 | pilot-pip |
| Zee | `minecraft:landfolk-test` | demo bot (zee's 6-card lane) | 3006 | pilot-zee |
| Tester | `minecraft:landfolk-test` | observer for `mc verify at_mark seed --block oak_sign` | 3004 | (none — script bot) |
| Mox | `minecraft:overworld` | **not in trial 2** — reserved for wheat capstone | 3007 | (none yet) |
| re44 | (varies) | human operator if logged in to spectate | — | — |

Notes:

- The demo only uses **Pip and Zee** as worker bots. Mox running in `overworld` is fine — it's the wheat-farm capstone's body, not load-bearing here. If Mox isn't running, `scripts/colony status` will WARN but trial 2 doesn't read its state.
- After `scripts/reset-open-test.sh`, the fixture's `mvtp Pip landfolk-test` / `mvtp Zee landfolk-test` lines move both demo bots into the test world (verified above). Mox stays where it was.
- `Tester` must be running and in `landfolk-test` BEFORE the trial — `scripts/run-tester-bot.sh` puts it there.
- `re44` (or any human player) joining is harmless; the demo doesn't interact with non-bot players.

Quick verification command:

```bash
ssh -n ubuntu-host "sudo docker exec minecraft rcon-cli 'list'"
# expect: "There are N of a max of 10 players online: Tester, Pip, Zee, Mox[, ...]"

for p in Pip Zee Tester; do
  ssh -n ubuntu-host "sudo docker exec minecraft rcon-cli \"data get entity $p Dimension\""
done
# expect each: "minecraft:landfolk-test"
```

## Live conversation following (trial 2)

`scripts/proto-logs-follow.py` mirrors `scripts/landfolk-logs-aggregate.py`'s
ergonomics for the proto rig. It polls the `state.db` `messages` table on
each pilot profile (the proto worker conversations don't write
`session_*.json` files — Hermes' state lives in sqlite) and prints
assistant thoughts, tool calls, tool responses, and the bot HTTP chat
log, all in a single tailed stream with per-profile color.

Recommended trial-2 watch setup:

```bash
# In one terminal — start the trial:
scripts/reset-open-test.sh
HERMES_HOME=~/.hermes-proto-agent-arch \
  python prototypes/agent-arch/capstone/run_two_bot_base.py \
    --run-id trial-$(date +%s) --watch

# In another terminal — follow the conversations live:
scripts/proto-logs-follow.py

# Or, --quiet hides successful tool responses + user messages, keeping
# only thoughts, tool calls, and errors. Great for reading at speed:
scripts/proto-logs-follow.py --quiet

# Add --reasoning to surface the hidden chain-of-thought when the model
# emits it. Useful for debugging "why didn't the agent block?" questions.
scripts/proto-logs-follow.py --reasoning
```

Also tail the dispatcher and bot logs separately when needed:

```bash
tail -F /tmp/two-bot-dispatcher-*.log    # kanban tick + spawn events
tail -F /tmp/hermescraft/bot-{pip,zee}.log  # raw bot HTTP API events
```

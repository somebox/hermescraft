# Test World — landfolk-test

The Phase 2 capability test suite runs against a dedicated Multiverse world (`landfolk-test`) so production play stays clean and tests get reproducible starting conditions.

## Worlds on the server

| World | Generator | Purpose |
|-------|-----------|---------|
| `world` | NORMAL (default) | Production play. Untouched by tests. |
| `world_nether`, `world_the_end` | NETHER, END | Default companions; unused for Phase 2. |
| `landfolk-test` | NORMAL + FLAT world type, `--no-structures` | Phase 2 capability tests. Disposable. |
| `testflat` | NORMAL | Pre-existing flat world (someone else made). Phase 2 doesn't use it. |

## landfolk-test setup (already done; documented for reference)

Created with:
```
/mv create landfolk-test NORMAL --world-type FLAT --no-structures
/mv modify landfolk-test set difficulty PEACEFUL
/mv gamerule set doDaylightCycle false landfolk-test
/mv gamerule set doMobSpawning false landfolk-test
/mv gamerule set doWeatherCycle false landfolk-test
/mv gamerule set keepInventory true landfolk-test
/execute in landfolk-test run time set 6000
/execute in landfolk-test run weather clear
/mvsetspawn landfolk-test:0,65,0
/execute in landfolk-test run forceload add 0 0
```

Spawn platform at (0, 64, 0): an **extended 16×11 stone surface** at Y=64 covering x=−5..10, z=−5..5. Bots stand at Y=65. Bedrock floor at Y=−64.

The platform was extended east on 2026-05-09 (from the original 11×11 to 16×11) to accommodate L0.10/L0.13 fixtures that place targets at x=4..5. Without the extension, bots tp'd to (0, 72, 0) for slow-fall would land off the platform and fall to bedrock. Restored if accidentally damaged via:
```
/execute in landfolk-test run fill -5 64 -5 10 64 5 minecraft:stone
```

## Coordinate conventions

### **Fixture-design rules** (learned the hard way — see F8/F10 below)
1. **NEVER fill below Y=65 in the spawn region.** `fill -5 60 -5 10 80 5 air` will destroy the platform stones at Y=64 and turn the test into a "bot freefalls to bedrock" run. Always use `fill -5 65 -5 10 80 5 air`.
2. **Walls obstructing LoS must be at least 2 blocks tall.** Bot eye height ≈ 1.38 above feet — a 1-tall wall is BELOW the eye, and rays at downward pitches in (-14°, -6°) clear the wall and hit blocks behind. Use `fill X 65 Z1 X 66 Z2 minecraft:<wall>`.
3. **Targets BELOW the platform** require either (a) a hole drilled through the platform with `setblock X 64 Z minecraft:air` so LoS reaches them, or (b) placing them at z=±6 (outside the platform's z-range).

### Coordinate conventions

- **Spawn platform**: 16×11 stone at Y=64 covering x=−5..10, z=−5..5. Bots stand at Y=65.
- **Test region partitioning** (planned): each capability level gets a 64-block X-axis offset to avoid cross-test contamination:
  - L0 tests: centered at (0, 65, 0) — the spawn platform
  - L1 tests: centered at (50, 65, 0)
  - L2 tests: centered at (100, 65, 0)
  - L3 tests: centered at (150, 65, 0)
  - L4 tests: centered at (200, 65, 0), with deep digging area below
- **Below Y=64**: stone (filled by fixtures as needed) down to bedrock at Y=-64. ~128 blocks of vertical room for mining tests.

## Cross-world teleport gotchas (learned the hard way)

1. **Forceload the chunk first.** `forceload add 0 0` on `landfolk-test` keeps the spawn chunk resident. Without this, the bot may teleport to coords whose chunk isn't loaded yet, phase through "air" that's actually unrendered solid blocks, and suffocate.

2. **Tp at a height, not directly onto the floor.** The fixture pattern is:
   ```yaml
   - "mvtp Flint landfolk-test"
   - "execute in landfolk-test run tp Flint 0 72 0"   # 7 blocks above platform
   - "effect give Flint minecraft:slow_falling 5 0 true"
   ```
   The bot tp's into air, slow-falls onto the platform with chunks fully loaded. **Without this, Flint suffocates inside the platform and dies in ~17s.**

3. **Inventory persists across Multiverse worlds.** Always `clear <bot>` in prep. The bot carries items between `world` and `landfolk-test`.

4. **Dimension is reported as `overworld` for both** `world` and `landfolk-test` — the bot framework can't distinguish them. Identify world by the `mvtp` command issued and the bot's coordinates.

## Fixture YAML schema

Files at `data/test-fixtures/<level>/<test_id>.yaml`:

```yaml
world: landfolk-test                       # Multiverse world name
prep:                                      # rcon commands run before the test
  - "execute in landfolk-test run fill -5 65 -5 5 80 5 minecraft:air"
  - "execute in landfolk-test run setblock 1 65 0 minecraft:dirt"
  - "mvtp Flint landfolk-test"
  - "execute in landfolk-test run tp Flint 0 72 0"
  - "clear Flint"
  - "effect give Flint minecraft:saturation 1 10"
  - "effect give Flint minecraft:instant_health 1 10 true"
  - "effect give Flint minecraft:slow_falling 5 0 true"
cleanup:                                   # rcon commands run after the test
  - "execute in landfolk-test run fill -5 65 -5 5 80 5 minecraft:air"
  - "execute in landfolk-test run setblock 1 65 0 minecraft:air"
  - "mvtp Flint world"
  - "execute in landfolk-test run kill @e[type=item,distance=..32]"
```

The runner `scripts/run-fixture.sh` parses these:
```
scripts/run-fixture.sh prep    <fixture>
scripts/run-fixture.sh cleanup <fixture>
scripts/run-fixture.sh both    <fixture>   # smoke test only — runs both back to back
```

Internally, each command is sent through `ssh -n ubuntu-host sudo docker exec minecraft rcon-cli '<cmd>'`. The `-n` flag on ssh is **load-bearing** — without it, ssh consumes the bash heredoc fed to the loop and only the first command runs.

## Helper script — `scripts/run-fixture.sh`

Behavior:
- Reads the YAML's `world:` line and the `prep:` / `cleanup:` lists
- Runs each command via rcon, prints `cmd -> result`
- Stops on first failure (`set -e`)
- ANSI color codes stripped from rcon output for readability

The script does NOT:
- Run the test action_sequence (that's the worker's job)
- Validate the success_predicate (that's the worker + steward's job)
- Verify cleanup left the world in a known state (steward responsibility)

## When to use `prep` vs full reset

- **Per-test `prep`** (default) is enough for almost everything. Each fixture starts with a `fill ... air` over the test region and rebuilds.
- **Full reset** (`scripts/reset-test-world.sh` — TODO): `mv delete landfolk-test --force && /mv create landfolk-test FLAT ...`. Run weekly or when fixtures drift. Loses all forceload state, world spawn, custom platform.

## Findings carried forward from this prep work

| Finding | Action |
|---------|--------|
| `mc dig` removes block but does NOT auto-add to inventory; drop entity stays at coord | Action contract (§8 in `phase-2-architecture.md`) needs `data.dropped_items` and a clarification: success_predicates that need item-in-inventory must include `mc pickup` in the action_sequence |
| Cross-world tp can suffocate the bot if chunk isn't loaded | Fixed in fixture pattern; document the tp-from-height + forceload combo |
| `mc --json` flag exists | All test runners should use it for clean structured output |
| `ssh -n` required in heredoc loops | Fixed in `run-fixture.sh`; document for future scripting |
| Inventory persists across Multiverse worlds | `clear <bot>` in every fixture's prep |
| Production world is named `world`, not `landfolk` | Fixture cleanup uses `mvtp Flint world` |

## Ops cheat sheet

```bash
# List worlds
ssh ubuntu-host "sudo docker exec minecraft rcon-cli 'mv list'"

# Inspect landfolk-test
ssh ubuntu-host "sudo docker exec minecraft rcon-cli 'mv info landfolk-test'"

# Manually tp a bot via Multiverse
ssh ubuntu-host "sudo docker exec minecraft rcon-cli 'mvtp <Bot> landfolk-test'"

# Verify a block (without keep mode confusion: use `if block`)
ssh ubuntu-host "sudo docker exec minecraft rcon-cli 'execute in landfolk-test if block 0 64 0 minecraft:stone run say YES'"

# Clear all dropped items in test region
ssh ubuntu-host "sudo docker exec minecraft rcon-cli 'execute in landfolk-test run kill @e[type=item,distance=..32]'"

# Verify forceload status
ssh ubuntu-host "sudo docker exec minecraft rcon-cli 'execute in landfolk-test run forceload query'"
```

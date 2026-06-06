# Test agent LLM runbook

Spec-driven end-to-end tests that drive a real Hermes LLM agent through Minecraft scenarios and grade the result against deterministic predicates. Sister to the L0–L6 capability fixtures (which test the *bot action layer* in isolation) — these test the *agent + bot together*.

Playbook-pass matrices (chop, tower, scaffold) are **closed**; harness and YAMLs remain for regression. New world-varied work uses **procedural topics** — see [`../testing/procedural/testing-model.md`](../testing/procedural/testing-model.md). **Smoke on live `proc-lab`:** [`procedural-smoke-runbook.md`](procedural-smoke-runbook.md). Playbook closure: [`../testing/playbooks/improvement-pass-closure.md`](../testing/playbooks/improvement-pass-closure.md).

Shipped in Sprint A (`docs/archive/phase-2-design/sprints.md`).

## Quick start

```bash
# Single test
python3 scripts/agent-test.py data/agent-tests/F2_phantom_search.yaml

# Override model
python3 scripts/agent-test.py --model openai/gpt-4o-mini data/agent-tests/G1_stone_pickaxe.yaml

# Override max turns
python3 scripts/agent-test.py --max-turns 30 data/agent-tests/G1_stone_pickaxe.yaml
```

A run prints per-stage timing and a pass/fail summary. The full report (predicates, tool-call sequence, agent chat, stderr) is written to `data/agent-tests/runs/<test_id>-<timestamp>.json`.

## Bot URL and identity

The runner drives **one** Mineflayer HTTP API and launches Hermes with matching env:

| Setting | Default | Override |
|---------|---------|----------|
| Bot API | `http://localhost:3001` | `--bot-url http://…` |
| `MC_USERNAME` | `Flint` (set by runner) | not overridable today — specs use Flint in `prep`/`cleanup` rcon |
| `MC_API_URL` | same as `--bot-url` | `--bot-url` |

Start the **Flint** bot body on port 3001 before running (e.g. landfolk launch scripts). The pytest **functional** suite uses **Tester** on port 3004 via [`config/hermescraft.yaml`](../../config/hermescraft.yaml) — that is a different harness (`tests/conftest.py`), not `agent-test.py`.

If you point `--bot-url` at another port, the process on that port must still be the **Flint** account; prep commands teleport and reset `Flint` in `landfolk-test`. Using Tester on 3004 without changing the runner will mismatch rcon prep and `MC_USERNAME`.

Optional per-spec **`early_exit.bot_url`** (see `G20_survival_night_cycle.yaml`) only affects the watchdog’s status poll, not the main `--bot-url`.

Smaller **B1–B4** smelt/fetch specs: `data/test-fixtures/behavior/B*.yaml` — same runner and defaults.

```bash
python3 scripts/agent-test.py --bot-url http://localhost:3001 data/agent-tests/F2_phantom_search.yaml
```

## Suite

| Class | Test | Capability | Avg time |
|---|---|---|---|
| Perception | P1 | mixed-block scene; specific names (oak vs birch vs spruce) | 13s |
| Failure modes | F1 | "wood" → birch_log canonicalization | 25s |
| | F2 | phantom search — give up cleanly when target doesn't exist | 12s |
| | F3 | stuck in 3-deep pit (`mc pillar_step` / `mc stair_up`) | 48s |
| | F4 | wooden vs stone pickaxe tier mismatch on iron_ore | 22s |
| | F5 | door blockade — `mc goto`→NAV_BLOCKED→`mc through` | 20s |
| | F6 | axe-break cascade (planks→sticks→table→axe→mine) | 60s |
| Composite | G1 | full chain to `stone_pickaxe` from nothing | 100-200s |
| | G2 | 5×5 cobblestone shelter walls | 45s |
| | G3 | one-call fence enclosure + gate | 32s |
| | G4 | selective container I/O (peek + withdraw by type) | 18s |
| | G5 | mine iron_ore + coal_ore → smelt → iron_ingot | 43s |
| | G6 | combat: iron-equipped bot fights a NoAI zombie | 20s |

All pass reliably with `google/gemini-2.5-flash` (default). See "Model findings" below for variants.

## Spec format (YAML)

```yaml
agent_test_id: G5_iron_smelt
world: landfolk-test

prompt: |
  You are a Minecraft bot named Flint. The `mc` CLI is on PATH …
  Goal: end with iron_ingot in your inventory.

skills: [minecraft-survival]   # passed to hermes -s
max_turns: 12                  # passed to hermes --max-turns
timeout_seconds: 240           # hard wall-clock cap (subprocess.run timeout)
stall_seconds: 75              # OPTIONAL; kill hermes if session file
                               #   stops growing for this long. Default 75.
inventory_reset:             # OPTIONAL; cleared on every run before cleanup
  - minecraft:cobblestone
settle_seconds: 6              # OPTIONAL; wait for chunk packets after prep.
                               #   Default 6.

expect:
  bot_inventory:
    iron_ingot: ">=1"
  mc_verbs_include_any: [smelt]
  mc_cli_invocations_max: 18

verify_after_prep:             # sanity-check the arena before launching hermes
  - { block: iron_ore, min_count: 1 }
  - { block: coal_ore, min_count: 1 }

prep:                          # batched rcon commands; run BEFORE hermes
  - "execute in landfolk-test run difficulty peaceful"
  - "execute in landfolk-test run setblock 3 65 0 minecraft:iron_ore"
  ...

cleanup:                       # batched rcon commands; run AFTER hermes
  - "execute in landfolk-test run kill @e[type=!player]"
  ...
```

`prep` and `cleanup` are both batched into single `ssh ubuntu-host docker exec -i minecraft rcon-cli` invocations via stdin, so a 20-command prep is ~200ms instead of ~10s.

### Pre-prep and run cycle

Each run executes in order:

1. **Pre-prep** — reset Flint (fire, effects, health); optional `inventory_reset` item clears; then the spec's **`cleanup`** (wipes the prior arena and parks at the spec's spawn).
2. **`prep`** — rebuild arena and give starter items.
3. **`settle_seconds`** (default 6) — wait for chunk/block cache on the bot.
4. Optional **`verify_after_prep`** — abort if the arena is wrong before Hermes starts.
5. **Hermes** — `HERMES_KANBAN_TASK` matches the same id substituted into `{{TASK_ID}}` in the prompt.
6. **Predicates** — evaluated **before** post-run `cleanup` (rcon block probes are batched for large bboxes).
7. **`cleanup`** — also runs on interrupt (Ctrl+C).

Do not rely on a global teleport to the chop park; each spec's `cleanup`/`prep` ends with the correct `tp` for that arena.

## Predicates

| Predicate | Shape | Pass when |
|---|---|---|
| `agent_chat_contains` | `[str, …]` | every needle is a substring of the agent's final chat output (case-insensitive) |
| `agent_chat_contains_any` | `[str, …]` | at least one needle is in chat |
| `agent_chat_does_not_contain` | `[str, …]` | no needle is in chat |
| `bot_at` | `{x, y, z, range}` | bot position is within `range` of target (Euclidean) |
| `bot_y_at_least` | `int` | bot foot Y ≥ value (height check for pit-escape tests) |
| `bot_inventory` | `{ item: count_or_">=N", … }` | every item meets its threshold |
| `bot_inventory_any` | `{ item: count, … }` | ANY one item meets its threshold (e.g. "has SOME axe variant") |
| `bot_inventory_excludes` | `{ item: count_or_">=N", … }` | NO item from this set meets the threshold |
| `world_block_at` | `[{x, y, z, block}, …]` | each block IS the named material in-world |
| `world_no_entity_of_type` | `[type, …]` | no entity of that type exists in the test world |
| `mc_verbs_include_any` | `[verb, …]` | at least one of these verbs appears in `mc <verb> …` calls |
| `mc_cli_invocations_max` | `int` | total mc CLI calls ≤ cap (catches loops/chattiness) |

For each probe, the runner runs `execute in landfolk-test if block X Y Z minecraft:<block>` via rcon (batched with other probes). Paper prints `Test passed` / `Test failed` on stdout; the runner parses that line.

### How `world_no_entity_of_type` works

Runs `execute in landfolk-test run data get entity @e[type=X,limit=1]` via rcon. The stdout prints entity NBT when one exists, or `"No entity was found"` when absent. Read-only — we don't kill the entity during predicate evaluation.

### Custom predicate types

Add to `predicate_results()` in `scripts/agent-test.py`. Each predicate returns `{kind, pass, detail}`. The overall test passes if all predicates pass and the run wasn't a timeout or stall.

## Stall watchdog

`subprocess.Popen` instead of `subprocess.run` so we can poll while hermes runs. Every 1s the watchdog checks the mtime of our hermes session file (`~/.hermes/sessions/session_*.json`). If it doesn't grow for `stall_seconds` (default 75s), terminate hermes with SIGTERM.

Threshold is 75s rather than 60s because hermes's own per-tool-call timeout is 60s — a single slow `mc collect` shouldn't trip the stall watchdog.

The watchdog is the second line of defense. The first is `subprocess.run`-style timeout that hard-kills hermes at `timeout_seconds` regardless of activity.

## Timing instrumentation

Every run prints a `timing:` line and a `hermes breakdown:` line:

```
  timing: total=43.2s | pre_prep=0.7s prep=0.2s settle=6.0s verify=0.1s
          hermes=36.1s hermes_model_think=29.1s hermes_tool_exec=0.0s
          hermes_other=7.0s post=0.0s cleanup=0.2s
  hermes breakdown: model_think=29s(4 calls, avg 7.3s) | tool_exec=0s | other=6s
```

- `model_think` = sum of (gap since prev message → arrival of an `assistant` message). LLM round-trip latency.
- `tool_exec` = sum of (gap since prev message → arrival of a `tool` message). Tool execution latency.
- `other` = startup + final flush + anything not covered above.

**Caveat**: when an assistant message and its tool result both flush to the session file in the same 1s poll cycle (which happens when mc commands return in well under 1s), the dt collapses to 0 and gets attributed to `model_think` instead. So `tool_exec` is a *lower* bound. For tools that block several seconds (e.g. `mc smelt`, which takes ~12s/item), the split is accurate. `model_think` is correspondingly an *upper* bound.

Empirically across the suite: framework overhead is ~7s flat per test. The variable cost is almost entirely LLM inference. G1 (the biggest test) spends 175s of 200s in `model_think`.

To see the raw message timeline:

```bash
AGENT_TEST_TIMELINE=1 python3 scripts/agent-test.py data/agent-tests/G5_iron_smelt.yaml
```

## Bot-level timeouts (Sprint A fixes)

Three pathfinder-spin bugs were fixed alongside the test runner. See the Sprint A entry in `docs/archive/phase-2-design/sprints.md` for details. Summary:

- `gotoWithTimeout(bot, goal, ms)` helper in `bot/lib/actions/mining.js` — races `b.pathfinder.goto` against a wall-clock deadline; on timeout stops the pathfinder, clears control states, throws `pathfinder_timeout`. Applied to `mc collect` (5 callsites, 5-8s caps), `mc dig` (1 callsite, 10s cap), `mc pickup` (1 callsite, 6s cap per item + 25s overall budget).
- PaperMCP server-side craft fallback in `bot/lib/actions/crafting.js` — works around an open Mineflayer bug where 3×3 table-required `b.craft()` returns delta=0 on Paper 1.21+. Requires `clear` in PaperMCP `command_whitelist`.
- rcon stdin path in `scripts/agent-test.py:run_rcon` — fixes the `unknown shorthand flag: '2' in -2` failure for any rcon command containing negative coordinates.

## Model findings (terminal-tool agent context)

| Model | Notes |
|---|---|
| `google/gemini-2.5-flash` (default) | reliable, fast (2-8s per LLM round-trip), good tool-call accuracy |
| `google/gemini-2.5-flash-lite` | refuses ~50% of tasks claiming "no Minecraft tools available" — avoid as baseline |
| `openai/gpt-4o-mini` | wanders off to `memory` / `search_files` tools instead of the terminal — fine for direct-API benchmarks, bad for terminal-tool agents |
| `meta-llama/llama-3.1-8b-instruct` | comparable to gemini-lite — cheap regression tier |
| `deepseek/deepseek-v4-flash` | works, but 2-3× slower than gemini-2.5-flash |

Change the default by editing `DEFAULT_MODEL` near the top of `scripts/agent-test.py`. The CLI flag `--model` overrides per-run.

## Adding a new test

1. Copy an existing spec — e.g. `data/agent-tests/G5_iron_smelt.yaml` as a starting point if you're testing a multi-step composite.
2. Pre-prep: think about what the arena needs to look like for the test to be deterministic. Reset every block. Place exactly the inputs the agent will need. Use `NoAI:1b` on summoned mobs if you want them stationary; use `data merge block` for chest contents (inline NBT silently ignores stack counts in 1.21+).
3. Pick predicates that test the *outcome*, not the *method*. `bot_inventory` + `world_block_at` + `mc_verbs_include_any` covers most cases without over-prescribing which verbs the agent must use.
4. Run it 3 times. If 1/3 pass, the prompt is probably ambiguous or the predicates over-prescriptive. If 0/3 pass, there's a real bug somewhere.
5. Cap `max_turns` and `timeout_seconds` to roughly 1.5× the median successful run time. Tighter caps catch loops earlier.

## Known limitations

- `mc smelt` blocks ~12s/item server-side. Tests with several smelts can hit the stall watchdog if turn count is low; bump `stall_seconds` if needed.
- Mineflayer chunk cache lag: if a test's prep `fill`s a region with new blocks via rcon, the bot's local view may be stale for a few seconds. The default 6s settle handles this; bump `settle_seconds` in the spec if a test runs into stale-block issues.
- `tool_exec` timing under-counts as described above.
- The mineflayer 3×3 craft bug fix uses PaperMCP, which is a server-side override — counts as a craft semantically but isn't actually exercising mineflayer's craft path. Real-server play uses the same fallback, so this isn't a test-only artifact, but it's worth knowing.

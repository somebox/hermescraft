# Perception digest (MVP)

**Experiment write-up and in-game MVP proposal:** [perception-digest-experiment.md](perception-digest-experiment.md)

Offline-style integration test: build a fixed scene in `landfolk-test`, call the Tester bot HTTP API for perception payloads, send them plus an **intent string** to OpenRouter for a one-shot JSON summary, and write reports for human comparison.

The intent is **not** passed to `mc observe` yet (external-only for MVP). Same scene, different intents → compare two report files.

## Timing benchmarks

Script: `scripts/perception-digest-bench.py` — samples each HTTP path (and optionally OpenRouter digest) with mean/min/max.

```bash
python3 scripts/perception-digest-bench.py --runs 5
python3 scripts/perception-digest-bench.py --prep d2 --runs 5 --digest --digest-runs 5
```

Typical order of magnitude on a local Tester bot (macOS, 5-run mean): `map` and `nearby` ~5–9 ms; lean `observe` ~2–6 ms; full `status` ~2–5 ms; **sequential 5-endpoint bundle** ~20 ms; **OpenRouter digest** (deepseek-v4-flash, ~15 KB input) ~10–35 s depending on provider load and reasoning tokens. Full pytest integration (D1×2 + D2) is ~90 s wall time, mostly LLM.

## Run

Prerequisites:

- Minecraft + Multiverse test world running
- Tester bot HTTP API up (`config.bot.roles.tester`, default port 3004)
- `OPENROUTER_API_KEY` in the environment, or `openrouter_api_key` in repo-root `secrets.yaml`

```bash
cd ~/hermescraft
export OPENROUTER_API_KEY=...
.venv/bin/pytest tests/integration/test_perception_digest.py -v -s
# D2 only:
.venv/bin/pytest tests/integration/test_perception_digest.py::test_perception_digest_stuck_collecting_wood -v -s
```

Optional: `DIGEST_MODEL` (default `deepseek/deepseek-v4-flash`).

## Reports

Under `config.logging.dir` / `tests/<run-id>/perception-digest/`:

- `find_oak_wood.json`
- `collect_grass_seeds.json`

Each file contains `intent`, full `perception_input`, and `digest` (`raw`, `parsed`, `usage`, `elapsed_s`, `model`).

## Scenes

**D1** — [data/perception-digest/fixtures/D1_mixed_scene.yaml](../data/perception-digest/fixtures/D1_mixed_scene.yaml): 32×32 mixed biome (trees, grass, water, cow, …). Parametrized intents `find oak wood` / `collect grass seeds`.

**D2** — [data/perception-digest/fixtures/D2_stuck_pit_wood.yaml](../data/perception-digest/fixtures/D2_stuck_pit_wood.yaml): Tester in a 2-block dirt pit at `(0, 63, 0)`, oak at `x≈5` and `x≈14`, intent `blocked collecting wood`. Test runs `POST /action/goto` toward the nearer log, then captures `observe` + `status?preserve=true` + `scene` + **`nearby?radius=8`** + **`map?radius=12`**, plus the goto response body.

## Perception input bundle

The test sends three HTTP snapshots to the model:

| Key | Endpoint | Why |
|-----|----------|-----|
| `observe` | `GET /observe?lean=true` | Goals, task, alerts (matches `mc observe`) |
| `status` | `GET /status?lean=false` | Position, nearby entities, notable blocks |
| `scene` | `GET /scene?range=32&lean=true` | Visible entities/landmarks in FOV |
| `nearby` | `GET /nearby?radius=8` | D2 only — block/entity list around bot (pit walls) |
| `map` | `GET /map?radius=12` | D2 only — ASCII top-down layout |

Lean `/observe` alone does not include block-level spatial detail ([bot/lib/runtime/observation.js](../bot/lib/runtime/observation.js)).

## Digest schema (target)

```json
{
  "summary": "...",
  "recommendations": [{
    "kind": "goto_collect",
    "block_or_entity": "oak_log",
    "position": [8, 65, -6],
    "distance_m": 12,
    "confidence": "high",
    "rationale": "..."
  }],
  "caveats": [],
  "nothing_actionable": false
}
```

MVP assertions: valid JSON and a `recommendations` array only.

### What to eyeball

**find oak wood** — top recommendation should be `oak_log` near `(8,65,-6)` or `(-10,65,4)`, not birch at `(-4,65,-12)`.

**collect grass seeds** — recommend `short_grass` / `tall_grass` (breaking grass for seeds); should not send the bot to chop oak.

## Code

- Runner: [tests/integration/test_perception_digest.py](../tests/integration/test_perception_digest.py)
- OpenRouter helper: [tests/_lib/openrouter.py](../tests/_lib/openrouter.py)

## In-game (`mc advise`)

```bash
mc advise --reason="find oak wood"
mc advise --dry-run --reason="test"   # HTTP bundle only
```

Logs: `$LOG_DIR/mc-advise.jsonl`. Implementation: [tests/_lib/perception_advise.py](../tests/_lib/perception_advise.py), [scripts/mc-advise-cli.py](../scripts/mc-advise-cli.py), [bot/cli/advise.mjs](../bot/cli/advise.mjs). Skill: [skills/minecraft-perception-advise.md](../skills/minecraft-perception-advise.md).

## Forced-reason mode (`MC_FORCE_REASON=1`)

Set in `scripts/run-steve.sh` for Steve. When on, **observation commands
wrap through the digest pipeline** and require `--reason="<sub-goal>"`:

| Command | Behavior with MC_FORCE_REASON=1 |
|---------|---------------------------------|
| `mc scene --reason=...` | Digest with scene+nearby+chat bundle |
| `mc map --reason=...` | Digest with scene+map+chat bundle |
| `mc find --reason=...` | Digest with scene+nearby+chat bundle |
| `mc nearby --reason=...` | Digest with scene+nearby+chat bundle |
| `mc status` (unchanged) | **Thin** projection (position, HP, food, holding, time, phase) — NO LLM, no `--reason` needed |
| `mc advise --reason=...` | Full bundle digest (unchanged) |

Bundle composition is parameterized by `kind` in
[tests/_lib/perception_advise.py](../tests/_lib/perception_advise.py):
`scene`/`find`/`nearby` skip the wide `map`; `map` skips `nearby`. Every
wrapped call includes the last 10 chat events so the digest can pick up
the agent's own announcements + re44's recent whispers.

Status is deliberately **not** wrapped so the agent has a cheap
self-state primitive; rich world-state is gated behind `--reason`. The
intercept lives in `dispatchHttpLike` in [bot/cli/index.mjs](../bot/cli/index.mjs).

Logs are tagged with `kind` (`scene` / `status` / `map` / `find` /
`nearby` / `advise`) so you can distinguish explicit advise from
auto-wrapped observation in `mc-advise.jsonl`.

## System-prompt grounding (Minecraft facts)

[tests/_lib/openrouter.py](../tests/_lib/openrouter.py) anchors the
digest LLM with hard rules it cannot invent around:

- **Food edibility list** (raw beef/mutton/porkchop OK; egg / raw chicken
  / rotten flesh / spider eye / pufferfish forbidden or last-resort)
- **Tool tier prerequisites** (wooden → stone → iron → diamond chain)
- **Cooking needs furnace + fuel** (no fuel → no cooked food)
- **Shears don't work on chickens/cows/pigs**
- **POSITION must be a 3-int `[x, y, z]` array** and must be a STANDABLE
  cell — not the resource block itself. For an oak_log at trunk-mid y,
  recommend the ground cell at the trunk base, not the trunk itself.
  This avoids `NAV_TARGET_UNSTANDABLE` errors on `mc move`.

## Watchers

```bash
scripts/watch-advise.py                # follow new digest calls
scripts/watch-advise.py --last 10 --full
scripts/watch-advise.py --kind map

scripts/watch-steve.py                 # pretty-tail Steve's session JSON
scripts/watch-steve.py --tail 30       # backfill then follow
scripts/watch-steve.py --reasoning     # include hidden thoughts
```

`watch-steve.py` reads `~/.hermes-landfolk-steve/sessions/session_*.json`
(canonical agent record) — far cleaner than the ANSI-laden TUI stdout.

## Deferred

- Server-side `/advise`, caching of identical (reason, position) calls
- Parallel specialist digests
- Rubric graders and golden answers under `data/perception-digest/runs/`

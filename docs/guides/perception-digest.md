# Perception digest

Compression layer between raw bot HTTP payloads and the Hermes agent: bundle reads + a one-shot LLM digest keyed on an explicit **reason** (sub-goal). Used in integration tests, `mc advise`, and (for Steve) `MC_FORCE_REASON=1` wrapping of observation commands.

Historical write-ups: [perception-digest-experiment.md](../archive/perception-digest-experiment.md), [perception-digest-findings.md](../archive/perception-digest-findings.md).

## Run (integration tests)

Prerequisites: Minecraft + Multiverse test world, Tester bot HTTP API (`config.bot.roles.tester`, default port 3004), `OPENROUTER_API_KEY` or `openrouter_api_key` in repo-root `secrets.yaml`.

```bash
cd ~/hermescraft
export OPENROUTER_API_KEY=...
.venv/bin/pytest tests/integration/test_perception_digest.py -v -s
.venv/bin/pytest tests/integration/test_perception_digest.py::test_perception_digest_stuck_collecting_wood -v -s
```

Optional: `DIGEST_MODEL` (default `deepseek/deepseek-v4-flash`).

### Timing benchmarks

```bash
python3 scripts/perception-digest-bench.py --runs 5
python3 scripts/perception-digest-bench.py --prep d2 --runs 5 --digest --digest-runs 5
```

Typical order of magnitude (local Tester, 5-run mean): `map` / `nearby` ~5–9 ms; lean `observe` ~2–6 ms; full `status` ~2–5 ms; **5-endpoint bundle** ~20 ms; **OpenRouter digest** ~10–35 s. Full pytest (D1×2 + D2) ~90 s wall time, mostly LLM.

### Reports

Under `config.logging.dir` / `tests/<run-id>/perception-digest/`: `find_oak_wood.json`, `collect_grass_seeds.json` (intent, `perception_input`, `digest`).

### Scenes

- **D1** — [data/perception-digest/fixtures/D1_mixed_scene.yaml](../../data/perception-digest/fixtures/D1_mixed_scene.yaml): mixed biome; intents `find oak wood` / `collect grass seeds`.
- **D2** — [data/perception-digest/fixtures/D2_stuck_pit_wood.yaml](../../data/perception-digest/fixtures/D2_stuck_pit_wood.yaml): pit + nearby oak; intent `blocked collecting wood`; bundle includes `nearby`, `map`, failed `goto` body.

### Perception input bundle

| Key | Endpoint | Why |
|-----|----------|-----|
| `observe` | `GET /observe?lean=true` | Goals, task, alerts |
| `status` | `GET /status?lean=false` | Position, entities, notable blocks |
| `scene` | `GET /scene?range=32&lean=true` | FOV summary |
| `nearby` | `GET /nearby?radius=8` | D2 — pit context |
| `map` | `GET /map?radius=12` | D2 — layout |

Lean `/observe` alone lacks block-level detail ([bot/lib/runtime/observation.js](../../bot/lib/runtime/observation.js)).

### Digest schema (`perception_answer_v1`)

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

MVP tests assert valid JSON and a `recommendations` array.

## What was built (in-game)

- **`mc advise --reason="..."`** — client-side bundle + digest; logs to `$LOG_DIR/mc-advise.jsonl`. See [skills/minecraft-perception-advise.md](../../skills/minecraft-perception-advise.md), [bot/cli/advise.mjs](../../bot/cli/advise.mjs), [tests/_lib/perception_advise.py](../../tests/_lib/perception_advise.py).
- **`MC_FORCE_REASON=1`** (Steve via [scripts/run-steve.sh](../../scripts/run-steve.sh)): `mc scene` / `mc map` / `mc find` / `mc nearby` route through the same pipeline and require `--reason`. `mc status` stays thin (no LLM). Intercept in [bot/cli/index.mjs](../../bot/cli/index.mjs).
- **Bundle-by-kind** in `capture_perception_bundle(kind=...)`: scene/find/nearby skip wide `map`; all wrapped calls include last 10 chat events.
- **System-prompt grounding** in [tests/_lib/openrouter.py](../../tests/_lib/openrouter.py): food rules, tool tiers, furnace/fuel, standable `[x,y,z]` positions (not resource blocks).

Runbook: [running-steve.md](running-steve.md).

## What we learned

- **No single read is enough** — steward-style bundle (map + nearby + status + observe) plus explicit reason matches agent needs; digest collapses token load.
- **Intent filtering works** — D1 oak vs grass; D2 blocked wood with map beats scene-only for enclosure.
- **Latency** — HTTP ~20 ms; digest ~10–35 s. OK for rare advise / wrapped observation; not every ReAct turn without caching.
- **Wrapping changed behavior** — observation calls carry sub-goals; grounding removed egg-as-food hallucinations.
- **Limits** — Agent sometimes ignores digest caveats (separate LLM from main loop). Pathfinder/water edges remain the bottleneck after good coordinates. Source-diving and raw `curl` to bot API bypass wrapping unless prompt/tool restrictions tighten.

## Watchers

```bash
scripts/watch-advise.py                # digest log
scripts/watch-steve.py --tail 30       # session JSON (canonical agent record)
```

## Code

- Tests: [tests/integration/test_perception_digest.py](../../tests/integration/test_perception_digest.py)
- OpenRouter: [tests/_lib/openrouter.py](../../tests/_lib/openrouter.py)

## Open questions

- Promote safety caveats (food, unreachable coords, `nothing_actionable`) into agent prompt rules?
- Cache digest by `(kind, reason_hash, quantized position)` for ~30 s?
- Pathfinder / drowning / `NAV_TARGET_UNSTANDABLE` retries?
- Restrict filesystem / curl tools for landfolk profiles?

## Deferred

- Server `POST /advise`, parallel specialist digests, rubric graders under `data/perception-digest/runs/`

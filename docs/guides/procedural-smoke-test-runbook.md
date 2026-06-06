# Procedural smoke test — tester runbook

Minimal loop: **mapcatalog pool** → **materialize `proc-lab`** → **agent-test** (spawn → muster). Use this before topic-specific agent tests.

See also: [procedural-testing-model.md](../features/procedural-testing-model.md), [agent-tests.md](agent-tests.md), [procedural-bench-ops.md](procedural-bench-ops.md).

---

## Prerequisites

| Item | Check |
|------|--------|
| SSH + Docker rcon | `ssh ubuntu-host sudo docker exec -i minecraft rcon-cli list` |
| `server.local.yaml` | Copy from `server.local.yaml.example`; `world.name: proc-lab` |
| Python deps | Repo venv or `pip install -e .` + PyYAML |
| **Flint** bot | HTTP API on **port 3001** (default `agent-test.py` / this runbook) |
| Hermes | On PATH; model API keys as you normally use for agent tests |

Optional: cubiomes binary path in `server.local.yaml` for faster/better find during refresh.

---

## One-command smoke (recommended)

From repo root on the bench host:

```bash
chmod +x scripts/scenario-smoke-agent.sh   # once
./scripts/scenario-smoke-agent.sh
```

Environment overrides:

| Variable | Default | Meaning |
|----------|---------|---------|
| `SERVER` | `server.local.yaml` | Mapcatalog server profile |
| `VARIANT` | `smoke` | Registry variant (`smoke` or legacy `scenario_homestead_smoke`) |
| `MATERIALIZE` | `1` | Run `mapcatalog try` for the picked seed before agent-test |
| `BOT_URL` | `http://localhost:3001` | Flint Mineflayer API (use `:3002` if that is where Flint runs) |
| `TRY_SEED` | (empty) | Skip catalog/find; `mapcatalog try` this seed then agent-test |
| `TRY_SEED_FALLBACK` | `800` | Used when catalog is empty after refresh |
| `SKIP_FIND` | `0` | Set `1` to skip auto-refresh when catalog empty |

Pass extra args after the script (forwarded to `agent-test.py`):

```bash
./scripts/scenario-smoke-agent.sh --model openrouter/google/gemini-2.5-flash --max-turns 8
```

**Pass criteria:** `proc_smoke_map_anchor` — Flint within 4 blocks of map **muster**, chat contains `anchor ok`, ≤14 `mc` CLI calls.

Report JSON: `data/agent-tests/runs/proc_smoke_map_anchor-<timestamp>.json`.

### Fast path (no catalog / after failed find)

Known-good smoke seeds (also tried first during `find`): **800**, **2024**, **271828**.

```bash
BOT_URL=http://localhost:3002 ./scripts/scenario-smoke-agent.sh \
  --model deepseek/deepseek-v4-flash
# empty catalog → auto fallback seed 800

# Or force a seed (skips find entirely):
TRY_SEED=800 BOT_URL=http://localhost:3002 ./scripts/scenario-smoke-agent.sh \
  --model deepseek/deepseek-v4-flash

python3 scripts/agent-test-from-map.py --try-seed 800 -s server.local.yaml \
  -- --bot-url http://localhost:3002 --model deepseek/deepseek-v4-flash
```

---

## Manual steps (debugging)

### 1. Lint registry

```bash
scripts/scenario-pools.sh lint
scripts/scenario-pools.sh list
```

### 2. Refresh smoke pool (first time or after requirement edits)

Needs live server + MV world config from `server.local.yaml`:

```bash
scripts/scenario-pools.sh refresh --only smoke -s server.local.yaml --allow-partial
```

Target: at least one JSON under `catalog/smoke/map_engine/` (gitignored locally).

### 3. Pick a map

```bash
scripts/scenario-pools.sh map smoke | tee /tmp/smoke-map.json
```

Note `seed`, `spawn`, `muster`, and `_scenario.requirements`.

### 4. Materialize world

```bash
python -m mapcatalog try \
  -r requirements/scenario_homestead_smoke.yaml \
  -s server.local.yaml \
  --seed <seed from map>
```

Confirms `proc-lab` loads with that seed and placements.

### 5. Agent test with injected anchors

```bash
python3 scripts/agent-test-from-map.py \
  --map /tmp/smoke-map.json \
  --materialize \
  -s server.local.yaml \
  -- --bot-url http://localhost:3001
```

Resolved spec (for inspection): `data/agent-tests/runs/.generated/proc_smoke_map_anchor-seed-<seed>.yaml`.

Template (placeholders): `data/agent-tests/topics/smoke/map-anchor.yaml`.

---

## Known limits

- **`world_block_at` / structure probes** in `agent-test.py` still hardcode `landfolk-test`. Smoke test uses **`bot_at`** only (bot API position in whatever dimension Flint is in).
- **`procedural_map:`** in the YAML is documentation until MC-T9; injection is via `agent-test-from-map.py`.
| **#3 Option B refresh** | Smoke has no biome gates; Pass 2 no longer re-runs Pass 1 biome probes (`metrics.evaluate_gates` filters `pass_num==2`). Re-run `refresh --only smoke`. |

See [procedural-smoke-closure.md](../features/procedural-smoke-closure.md) for backlog vs done.

---

## Quick unit checks (no server)

```bash
pytest tests/unit/test_agent_test_from_map.py -q
pytest tests/unit/test_mapcatalog_*.py tests/unit/test_scenario_registry.py -q
```

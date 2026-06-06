# Procedural bench operations

How to run capability tests on **`proc-lab`** without slow world rebuilds every time, and how to inspect agent runs.

Related: [procedural-smoke-runbook.md](procedural-smoke-runbook.md), [smoke-closure.md](../testing/procedural/smoke-closure.md), [establish-operator-runbook.md](establish-operator-runbook.md) (full landfolk establish on proc-lab).

---

## Worlds and players

| World | Use |
|-------|-----|
| **`proc-lab`** | Scratch MV world for mapcatalog / agent tests (`proc-*` only) |
| **`landfolk-test`**, **`world`** | Campaign / humans — **not** deleted by mapcatalog |

**Materialize** (`mapcatalog try`, `find`) runs `mv delete` + `mv create` on **`proc-lab` only**. Before that, only **`world.evac.bot_players`** (default **`Flint`**) are mvtp'd out of proc-lab to the hub. **`re44`** on the main campaign world is not affected.

If a human is standing in proc-lab during materialize, add them to `bot_players` only if you intend to move them — otherwise avoid visiting proc-lab during refresh.

---

## Fast setup (reuse seed)

| Mechanism | When |
|-----------|------|
| **`data/runtime/proc-lab-state.json`** | Written after full materialize; records last seed |
| **`world.reuse_seed: true`** in `server.local.yaml` | `mapcatalog try --reuse-world` skips delete/create when state seed matches |
| **`AUTO_REUSE=1`** (default) in `scenario-agent-test.sh` | Skips `--materialize` when map seed == state seed |
| **`MATERIALIZE=0`** | Agent-only re-run on same map JSON (no `try`) |
| **`data/runtime/last-scenario-map.json`** | Copy of last picked catalog card for `proc-lab-ops agent-only` |

Typical iteration after one full run:

```bash
# Full loop once (~4–5 min with materialize)
BOT_URL=http://localhost:3002 scripts/scenario-agent-test.sh building.flat_pad \
  -- --model deepseek/deepseek-v4-flash

# Tune prompt/model/skills (~30–40s)
scripts/proc-lab-ops.sh agent-only -- --bot-url http://localhost:3002 \
  --model deepseek/deepseek-v4-flash
```

Force full rebuild:

```bash
MATERIALIZE=1 AUTO_REUSE=0 scripts/scenario-agent-test.sh building.flat_pad -- …
```

---

## Logs and reasoning

```bash
scripts/proc-lab-ops.sh status
scripts/proc-lab-ops.sh tail-report                    # latest run
scripts/proc-lab-ops.sh tail-report proc_building_flat_pad_watch
scripts/proc-lab-ops.sh tail-session                   # Hermes JSON from latest report
```

Full JSON: `data/agent-tests/runs/<test_id>-<timestamp>.json` (predicates, tool calls, chat).

Live run: `scenario-agent-test.sh` stdout is line-buffered; pipe to `tee` if you want a file.

---

## Start / stop

| Action | Command |
|--------|---------|
| Flint bot | **`scripts/landfolk start --profiles flint`** (or bench launch on port **3002**) — scenario wrappers poll `/health` + one `/connect` like `landfolk-control.sh` |
| Hermes agent | Started/stopped by `agent-test.py` per run (no daemon) |
| Abort | Ctrl+C during agent-test; Flint stays connected |
| proc-lab state | `scripts/proc-lab-ops.sh status` |

### Setup sequence (matches landfolk capability tests)

1. **Bot up** — listener on `BOT_URL` (default `http://localhost:3001`; bench often `:3002`).
2. **Full scenario once** — `scripts/scenario-agent-test.sh <variant>` materializes proc-lab when needed and writes `last-scenario-map.json`.
3. **Agent-only iterations** — `scripts/proc-lab-ops.sh agent-only` skips `mapcatalog try` but **`agent-test.py` still runs spec `prep`** (`mvtp Flint proc-lab` + tp to spawn). Prior run `cleanup` moves Flint to `landfolk-test`; prep is what fixes dimension mismatch (do not skip prep when tuning prompts).

Defaults: **`AGENT_TEST_MODEL=deepseek/deepseek-v4-flash:exacto`**, merged in `scripts/scenario-agent-common.sh` / `agent-test-from-map.py` (user `--model` after `--` wins; no duplicate-flag errors).

---

## Capability roadmap (after infra)

| Phase | Topic | Infra ready? | Notes |
|-------|--------|--------------|-------|
| Now | **Building** nav (`flat-pad-watch-post`) | Yes | Terrain/nav failures → tighten gates or skills |
| Next | **Scouting** | Pool + template | New `topics/scouting/` spec; reuse same runner |
| Then | **Farming / mining** | Pools need biome gates | Cubiomes skew / `verify_live` tuning (see cubiomes-paper-skew.md) |

**Follow-ups (capability, not infra):**

- **`reachable_from spawn`** placement modifier (pathfinder-safe anchors)
- Tighter **`neighbor height delta`** on building pool for nav-friendly maps
- Skill stack: add **`minecraft-mining`** when tests expect `mc tunnel` / dig-through
- **Steep slope acceptance:** after refreshing the pool, optional `requirements/scenario_scouting_steep_slope.yaml` — manual pass = worker receives NAV hint with `build_stairs` or lip `dig` (see [route-sculpt-navigation.md](../specs/nav/route-sculpt-hints.md))

---

## Config snippet

```yaml
# server.local.yaml
world:
  name: proc-lab
  reuse_seed: true
  evac:
    hub_world: landfolk-test
    hub_xyz: [0, 65, 0]
    bot_players: [Flint]   # only these are mvtp'd out of proc-lab before rebuild
```

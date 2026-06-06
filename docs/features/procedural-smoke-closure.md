# Procedural map catalog — smoke closure (2026-06)

Status: **CLOSED** — bench closure gate passed 2026-06-01 (`refresh --only smoke` accepts=1; full `scenario-smoke-agent.sh` PASS).

Parent docs: [procedural-map-catalog.md](procedural-map-catalog.md), [procedural-testing-model.md](procedural-testing-model.md), [procedural-smoke-test-runbook.md](../guides/procedural-smoke-test-runbook.md).

---

## Shipped (smoke / mapcatalog v1)

| Piece | Location |
|-------|----------|
| Registry v2 (topics + smoke) | `data/scenarios/registry.yaml` |
| Find / try / lint / scenario CLI | `mapcatalog/`, `scripts/scenario-pools.sh` |
| Pass 2 evaluates **pass2 gates only** | `mapcatalog/metrics.py` (`pass_num == 2`) |
| Gate contract docstrings | `mapcatalog/models.py`, `evaluate_gates` |
| Smoke requirements (flat + height only) | `requirements/scenario_homestead_smoke.yaml` |
| Agent smoke spec + map injection | `data/agent-tests/topics/smoke/map-anchor.yaml` |
| Generic topic runner | `scripts/scenario-agent-test.sh` (smoke wrapper: `scenario-smoke-agent.sh`) |
| Cubiomes vs Paper notes | `docs/features/cubiomes-paper-skew.md` |

---

## Next: capability testing on proc-lab (in progress)

| Step | Command |
|------|---------|
| First **building** topic agent test | `BOT_URL=http://localhost:3002 scripts/scenario-agent-test.sh building.flat_pad` |
| Refresh flat pad pool | `scripts/scenario-pools.sh refresh --only building.flat_pad -s server.local.yaml` |
| Spec | `data/agent-tests/topics/building/flat-pad-watch-post.yaml` |

`building.flat_pad` uses the same **no-biome-gate** pattern as smoke (live flat/height only) so find is not blocked by cubiomes/Paper skew.

---

## Backlog (not smoke)

| ID | Item |
|----|------|
| MC-T9 | `procedural_env` in `agent-test.py` |
| MC-T6 | scenario apply / prep / cleanup CLI |
| MC-T1+ | `mining.plains_iron` pool (needs biome pass1 + verify_live tuning or cubiomes rebuild) |
| — | Migrate legacy `tower-platform-3x3.yaml` predicates onto proc-lab card |
| — | Optional `pass2.live_biome` opt-in (only if a job needs live biome re-check at Pass 2) |

---

## Map → agent loop (any topic)

```bash
scripts/scenario-pools.sh refresh --only building.flat_pad -s server.local.yaml
scripts/scenario-agent-test.sh building.flat_pad -- --model deepseek/deepseek-v4-flash
```

Or manual: `scenario-pools.sh map …` → `agent-test-from-map.py --map … --spec …`

---

## Genesis / landfolk-test

Do **not** mix `scripts/genesis.sh` with `proc-lab` scenario loops. Legacy agent tests remain on `landfolk-test` under `data/agent-tests/F*.yaml`, `G*.yaml`, etc.

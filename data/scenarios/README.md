# Scenario registry

Canonical model: **[docs/testing/procedural/testing-model.md](../../docs/testing/procedural/testing-model.md)**

## Vocabulary

- **Topic** — mining, fishing, building, defense, farming (what the agent test is about)
- **Terrain profile** — mapcatalog requirements (gates + anchors); several per topic
- **Map** — one accepted seed JSON from `find` (do not call this a “card”; that’s kanban)

## Commands

```bash
scripts/scenario-pools.sh lint
scripts/scenario-pools.sh list
scripts/scenario-pools.sh refresh --only mining.plains_iron -s server.local.yaml
scripts/scenario-pools.sh refresh --only smoke --allow-partial
scripts/scenario-pools.sh map fishing.river_shore
```

Legacy ids still work (`scenario_homestead_smoke` → smoke).

## Agent tests (proc-lab)

| Variant | Spec |
|---------|------|
| `smoke` | `data/agent-tests/topics/smoke/map-anchor.yaml` |
| `building.flat_pad` | `data/agent-tests/topics/building/flat-pad-watch-post.yaml` |

```bash
scripts/scenario-agent-test.sh smoke
scripts/scenario-agent-test.sh building.flat_pad -- --model deepseek/deepseek-v4-flash
```

Flow: refresh pool → pick map → `try` → `agent-test-from-map.py` (anchors from map JSON).

Legacy regression: `data/agent-tests/` on `landfolk-test`.

## Genesis

Campaign boot (`scripts/genesis.sh`) is separate — do not use for procedural topic runs.

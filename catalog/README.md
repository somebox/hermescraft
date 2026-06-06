# Scenario maps (catalog pools)

Generated **maps** (seed + anchor placements) live here after `scenario-pools.sh refresh`. **Gitignored** except this README.

**Model:** [docs/features/procedural-testing-model.md](../docs/features/procedural-testing-model.md)

| In git | Local only |
|--------|------------|
| `data/scenarios/registry.yaml` (topics + terrains) | `catalog/**/*.json` |
| `requirements/`, `profiles/` | |

```bash
scripts/scenario-pools.sh list
scripts/scenario-pools.sh refresh --only smoke -s server.local.yaml
scripts/scenario-pools.sh map mining.plains_iron   # pick one map JSON
```

Layout: `catalog/topics/<topic>/<terrain>/` or `catalog/smoke/map_engine/`.

**Vocabulary:** **map** = catalog JSON; **kanban card** = Hermes board (unrelated).

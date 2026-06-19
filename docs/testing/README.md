# Testing documentation

| Area | Doc |
|------|-----|
| Test tiers (CI vs local) | [`../guides/test-overview.md`](../guides/test-overview.md) |
| `landfolk-test` world | [`../guides/test-world-landfolk.md`](../guides/test-world-landfolk.md) |
| LLM + bot agent tests | [`../guides/test-agent-llm-runbook.md`](../guides/test-agent-llm-runbook.md) |
| Arena quickstart | [`../guides/test-arena-quickstart.md`](../guides/test-arena-quickstart.md) |
| Context / prompt tuning | [`context-tuner/README.md`](context-tuner/README.md) |
| Terrain shaping → bot promotion | [`../planning/terrain-shaping-runtime-promotion.md`](../planning/terrain-shaping-runtime-promotion.md) |
| Terrain shaping standing (2026-06-19) | [`context-tuner/reports/2026-06-19-terrain-shaping-status.md`](context-tuner/reports/2026-06-19-terrain-shaping-status.md) |
| Procedural maps & scenarios | [`procedural/`](procedural/) — model in [`procedural/testing-model.md`](procedural/testing-model.md); data in [`../../data/scenarios/`](../../data/scenarios/) and [`../../mapcatalog/`](../../mapcatalog/) |
| Playbook improvement pass (closed) | [`playbooks/`](playbooks/) |

**Target architecture** for harness direction: [`../architecture/README.md`](../architecture/README.md).

## Operational vs historical

| Operational (maintained) | Historical ([`../archive/testing/`](../archive/testing/)) |
|--------------------------|-----------------------------------------------------------|
| [`procedural/testing-model.md`](procedural/testing-model.md), [`scenario-runs.md`](procedural/scenario-runs.md), [`map-catalog.md`](procedural/map-catalog.md), [`smoke-closure.md`](procedural/smoke-closure.md) | [`procedural/establishment-log.md`](../archive/testing/procedural/establishment-log.md) |
| [`context-tuner/`](context-tuner/) ops docs | Dated reports under [`context-tuner/reports/`](context-tuner/reports/) (optional archive later) |
| [`playbooks/improvement-pass-closure.md`](playbooks/improvement-pass-closure.md), [`design-composable-playbooks.md`](playbooks/design-composable-playbooks.md), [`catalog/`](playbooks/catalog/) | Playbook pass followup, test procedure, wave-6 lab, stage checklist under [`../archive/testing/playbooks/`](../archive/testing/playbooks/) |

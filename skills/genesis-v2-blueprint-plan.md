---
name: genesis-v2-blueprint-plan
description: Decomposition patterns for colony-planner when breaking epics into worker cards.
version: 1.0.0
platforms: [linux, macos]
metadata:
  hermes:
    tags: [genesis-v2, kanban, colony]
---

# Genesis v2 blueprint plan

Use with `genesis-v2-worker-card-schema`. Emergent establishment order (default):

1. Scout → `base_anchor` + resource marks
2. Storage → `chest_*` marks before haul/deposit chains
3. SUPPLY / gather loops from `lt_*` marks
4. Mine → `mine_*` + `mine_site` before deep dig
5. Flat pad + egress → CONSTRUCT shelter (plan-backed: run `./scripts/construct-plan-cards.py --dry-run` per phase to emit `[SUPPLY]` + `[CONSTRUCT]` from `materials_by_phase`). Plan file shape: [`docs/specs/world/blueprints-grabcraft.md`](../docs/specs/world/blueprints-grabcraft.md).

Wire siblings with `after:` / `Continues from <id>:` at the top of the body.
One assignee per card; no `skills` field on worker cards.

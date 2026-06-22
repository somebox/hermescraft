---
name: genesis-v2-planner-survey
description: Read-only board survey patterns for colony-planner and overseer on genesis-v2.
version: 1.0.0
platforms: [linux, macos]
metadata:
  hermes:
    tags: [genesis-v2, kanban, colony]
---

# Genesis v2 planner survey

Orient cold every dispatch:

1. `scripts/kanban board`
2. `scripts/kanban epic <id>` or `scripts/kanban card <id>` for active work
3. Check marks via worker HANDOFF comments and `[RETRO]` summaries — you have no body

Emergent mode: no phase gates. Gated mode: `scripts/genesis-v2.sh check` reflects P1–P5
when run live (not for postmortem on old runs).

Site-fit: poller may file site advisory cards from reconciled scout marks; treat as
input, not automatic relocation.

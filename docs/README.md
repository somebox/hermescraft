# Documentation index

**Fleet direction (target):** start at [`architecture/README.md`](architecture/README.md).

**CLI commands:** [`reference/mc-cheatsheet.md`](reference/mc-cheatsheet.md) is generated from `bot/cli/registry.mjs`. After registry changes, run `node scripts/gen-mc-cheatsheet.mjs` or `scripts/regenerate-artifacts.sh`.

## 1. Target architecture

| Doc | Purpose |
|-----|---------|
| [`architecture/README.md`](architecture/README.md) | Reading order, doc map, next steps |
| [`architecture/target.md`](architecture/target.md) | Canonical target statement |
| [`architecture/impact.md`](architecture/impact.md) | Code touchpoints for migration |

## 2. Reference (bot, `mc`, conventions)

| Doc | Purpose |
|-----|---------|
| [`reference/bot-codebase-map.md`](reference/bot-codebase-map.md) | `bot/lib/` layout and action domains |
| [`reference/hermes-mc-boundaries.md`](reference/hermes-mc-boundaries.md) | Hermes vs Mineflayer HTTP / `mc` |
| [`reference/engineering-patterns.md`](reference/engineering-patterns.md) | Maintainability patterns (P1–P20) |
| [`reference/mc-command-reference.md`](reference/mc-command-reference.md) | Verb intent, args, envelopes |
| [`reference/mc-cheatsheet.md`](reference/mc-cheatsheet.md) | Generated one-line per command |
| [`reference/world-coordinates.md`](reference/world-coordinates.md) | `block_y` / `surface_y` convention |
| [`reference/fleet-notes.md`](reference/fleet-notes.md) | Ops notes (registry, routing, perception) |
| [`reference/bot/handler-contract-adr.md`](reference/bot/handler-contract-adr.md) | Action handler ADR |
| [`reference/bot/handler-response-contracts.md`](reference/bot/handler-response-contracts.md) | Per-verb response shape |

## 3. Platform (Hermes upstream)

| Doc | Purpose |
|-----|---------|
| [`platform/hermes-upgrade-0.15-runbook.md`](platform/hermes-upgrade-0.15-runbook.md) | Upgrade procedure |
| [`platform/hermes-landfolk-integration.md`](platform/hermes-landfolk-integration.md) | Contributor integration practices |
| [`architecture/hermes-v0.15-reference.md`](architecture/hermes-v0.15-reference.md) | Primitives the target architecture cites |

## 4. Guides — current fleet ops

These describe the **Steward + roster** fleet until `@planner` / `@dispatcher` land. Target: [`architecture/target.md`](architecture/target.md).

| Doc | Purpose |
|-----|---------|
| [`guides/fleet-lifecycle-runbook.md`](guides/fleet-lifecycle-runbook.md) | `scripts/landfolk` start/stop/status |
| [`guides/kanban-facade-runbook.md`](guides/kanban-facade-runbook.md) | `scripts/kanban` facade |
| [`guides/dashboard-command-center.md`](guides/dashboard-command-center.md) | Fleet dashboard |
| [`guides/genesis-runbook.md`](guides/genesis-runbook.md) | Genesis runs |
| [`guides/genesis-prep-runbook.md`](guides/genesis-prep-runbook.md) | Genesis prep |
| [`guides/establish-base-runbook.md`](guides/establish-base-runbook.md) | Base establish |
| [`guides/establish-operator-runbook.md`](guides/establish-operator-runbook.md) | Operator establish |
| [`guides/procedural-smoke-runbook.md`](guides/procedural-smoke-runbook.md) | Procedural smoke |
| [`guides/procedural-bench-runbook.md`](guides/procedural-bench-runbook.md) | Procedural bench |
| [`guides/expedition-logging-runbook.md`](guides/expedition-logging-runbook.md) | `scripts/exp.sh` logging |
| [`guides/test-overview.md`](guides/test-overview.md) | Test tiers |
| [`guides/test-world-landfolk.md`](guides/test-world-landfolk.md) | `landfolk-test` world |
| [`guides/test-agent-llm-runbook.md`](guides/test-agent-llm-runbook.md) | Agent test runner |
| [`guides/test-arena-quickstart.md`](guides/test-arena-quickstart.md) | Arena tests |

## 5. Specs & testing

| Area | Index |
|------|--------|
| World / marks / regions | [`specs/world/marks-sign-anchored.md`](specs/world/marks-sign-anchored.md), [`specs/world/designated-regions.md`](specs/world/designated-regions.md), [`specs/world/blueprints-grabcraft.md`](specs/world/blueprints-grabcraft.md) |
| MC / nav / kanban / … | [`specs/`](specs/) — `mc/`, `nav/`, `kanban/`, `dashboard/`, `agent/` |
| Harnesses | [`testing/README.md`](testing/README.md) |

## Planning scratch

[`planning/session-devlog.md`](planning/session-devlog.md) — append-only session log (not canonical).

## Archive

[`archive/README.md`](archive/README.md) — superseded phase-2/3 design, old experiments, stale guides.

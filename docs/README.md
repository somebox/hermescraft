# Documentation index

**Fleet direction (target):** start at [`architecture/README.md`](architecture/README.md) — full owner map and reading order live there; the table below is a short index only.

**CLI commands:** [`reference/mc-cheatsheet.md`](reference/mc-cheatsheet.md) is generated from `bot/cli/registry.mjs`. After registry changes, run `node scripts/gen-mc-cheatsheet.mjs` or `scripts/regenerate-artifacts.sh`.

## 1. Target architecture

| Doc | Purpose |
|-----|---------|
| [`architecture/README.md`](architecture/README.md) | Reading order, doc map, maturity matrix, next steps |
| [`architecture/target.md`](architecture/target.md) | Canonical target statement |
| [`architecture/genesis-v2-stabilization.md`](architecture/genesis-v2-stabilization.md) | Genesis-v2 evidence gates, retro/stop (operator supplement) |
| [`guides/genesis-v2-dev-loop.md`](guides/genesis-v2-dev-loop.md) | Post-run measurement + improvement dev loop |
| [`testing/genesis-v2/competence-scorecard.md`](testing/genesis-v2/competence-scorecard.md) | Scorecard schema v1 |
| [`testing/genesis-v2/plan-alignment.md`](testing/genesis-v2/plan-alignment.md) | Plan vs shipped gv2 measurement gaps |
| [`architecture/stock-truth-model.md`](architecture/stock-truth-model.md) | Stored / reachable / withdrawable stock contract |
| [`architecture/embodied-control.md`](architecture/embodied-control.md) | Reflex-first interface — registry vs agent surface, delivery order, evidence loop |
| [`architecture/execution-kernel.md`](architecture/execution-kernel.md) | Bulk `orderCells` / `runCells` motor, partial envelope, port tiers |
| [`architecture/construct-canary.md`](architecture/construct-canary.md) | Construct mode rollout checks (`HERMES_CONSTRUCT_CONTEXT`); plan shape in [`specs/world/blueprints-grabcraft.md`](specs/world/blueprints-grabcraft.md) |
| [`architecture/impact.md`](architecture/impact.md) | Code touchpoints for migration |
| [`architecture/bot-lease.md`](architecture/bot-lease.md) | Runtime bot lease (`mc bot`, genesis v2) |
| [`architecture/bots-and-mc.md`](architecture/bots-and-mc.md) | Bot registry, fleet names, `mc`, marks, fleet binding |
| [`architecture/components.md`](architecture/components.md) | Runtime processes, ticks, supervision |
| [`architecture/board-dynamics.md`](architecture/board-dynamics.md) | Dispatcher tick, bind, maintenance |
| [`architecture/data-api.md`](architecture/data-api.md) | Recall stream + fleet operations HTTP |
| [`architecture/scheduled-operations.md`](architecture/scheduled-operations.md) | Colony cron / scheduled card pattern |
| [`architecture/mc-verify-spec.md`](architecture/mc-verify-spec.md) | `mc verify` facade contract |
| [`architecture/example-wheat-farm-walkthrough.md`](architecture/example-wheat-farm-walkthrough.md) | Worked wheat epic timeline (companion to epic-lifecycle) |
| [`architecture/observe-cards.md`](architecture/observe-cards.md) | `[VERIFY]` / observe card kinds |
| [`architecture/dashboard-metrics-spec.md`](architecture/dashboard-metrics-spec.md) | Colony dashboard metrics (wireframes: [`dashboard-wireframes.html`](architecture/dashboard-wireframes.html)) |
| [`architecture/pi-vs-hermescraft-mapping.md`](architecture/pi-vs-hermescraft-mapping.md) | Pi platform thought experiment (not migration plan) |

## 2. Reference (bot, `mc`, conventions)

| Doc | Purpose |
|-----|---------|
| [`reference/bot-codebase-map.md`](reference/bot-codebase-map.md) | `bot/lib/` layout and action domains |
| [`reference/bot/handlers-directory.md`](reference/bot/handlers-directory.md) | Actions tree — adding a verb |
| [`reference/hermes-mc-boundaries.md`](reference/hermes-mc-boundaries.md) | Hermes vs Mineflayer HTTP / `mc` |
| [`reference/engineering-patterns.md`](reference/engineering-patterns.md) | Maintainability patterns (P1–P20) |
| [`reference/mc-command-reference.md`](reference/mc-command-reference.md) | Verb intent, args, envelopes — **syntax SoT:** cheatsheet/registry; §A transitional |
| [`reference/mc-cheatsheet.md`](reference/mc-cheatsheet.md) | Generated one-line per command |
| [`reference/world-coordinates.md`](reference/world-coordinates.md) | `block_y` / `surface_y` convention |
| [`reference/minecraft-gameplay-mechanics.md`](reference/minecraft-gameplay-mechanics.md) | Player physics, traversal, traps, ore bands (agent primer; not `mc` syntax) |
| [`reference/fair-play-charter.md`](reference/fair-play-charter.md) | Parity principle, sensing vs acting, LOS vs scan-solidity |
| [`reference/fleet-notes.md`](reference/fleet-notes.md) | Ops notes (registry, routing, perception); context-test promotion ledger |
| [`reference/bot/handler-contract-adr.md`](reference/bot/handler-contract-adr.md) | Action handler ADR |
| [`reference/bot/handler-response-contracts.md`](reference/bot/handler-response-contracts.md) | Per-verb response shape |

**Audits:** [`reference/audits/audit-mc-commands-2026-05-29.md`](reference/audits/audit-mc-commands-2026-05-29.md) (taxonomy baseline); [`reference/audits/bot-test-coverage-2026-06-06.md`](reference/audits/bot-test-coverage-2026-06-06.md) (regen: `scripts/bot-test-coverage-report.mjs`).

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
| [`guides/establish-operator-runbook.md`](guides/establish-operator-runbook.md) | Operator establish (proc-lab) |
| [`guides/procedural-smoke-runbook.md`](guides/procedural-smoke-runbook.md) | Procedural smoke |
| [`guides/procedural-bench-runbook.md`](guides/procedural-bench-runbook.md) | Procedural bench |
| [`guides/expedition-logging-runbook.md`](guides/expedition-logging-runbook.md) | `scripts/exp.sh` logging |
| [`guides/bot-lease-live-runbook.md`](guides/bot-lease-live-runbook.md) | Two-body lease spike + genesis trial (operator) |
| [`guides/test-overview.md`](guides/test-overview.md) | Test tiers |
| [`guides/test-world-landfolk.md`](guides/test-world-landfolk.md) | `landfolk-test` world |
| [`guides/test-agent-llm-runbook.md`](guides/test-agent-llm-runbook.md) | Agent test runner |
| [`guides/test-arena-quickstart.md`](guides/test-arena-quickstart.md) | Arena tests |

## 5. Specs & testing

| Area | Index |
|------|--------|
| World / marks / regions | [`specs/world/marks-sign-anchored.md`](specs/world/marks-sign-anchored.md), [`specs/world/designated-regions.md`](specs/world/designated-regions.md), [`specs/world/blueprints-grabcraft.md`](specs/world/blueprints-grabcraft.md) — committed plan JSON (**[Terminology](specs/world/blueprints-grabcraft.md#terminology)**), verify, RCON capture/paste; construct rollout: [`architecture/construct-canary.md`](architecture/construct-canary.md) |
| MC / nav / kanban / agent | [`specs/`](specs/) — `mc/`, `nav/`, `kanban/`, `dashboard/`, `agent/` (e.g. [`specs/agent/scripting-layer-dsl.md`](specs/agent/scripting-layer-dsl.md)) |
| Procedural harness | [`testing/procedural/testing-model.md`](testing/procedural/testing-model.md), [`scenario-runs.md`](testing/procedural/scenario-runs.md), [`map-catalog.md`](testing/procedural/map-catalog.md), [`smoke-closure.md`](testing/procedural/smoke-closure.md) |
| Context tuner | [`testing/context-tuner/README.md`](testing/context-tuner/README.md) — scenarios in [`data/context-tests/`](data/context-tests/) |
| Playbooks (closed pass) | [`testing/playbooks/improvement-pass-closure.md`](testing/playbooks/improvement-pass-closure.md); precursor: [`design-composable-playbooks.md`](testing/playbooks/design-composable-playbooks.md) (see architecture README) |
| Harness hub | [`testing/README.md`](testing/README.md) |
| Data roots | [`data/scenarios/README.md`](data/scenarios/README.md), [`mapcatalog/README.md`](mapcatalog/README.md), [`catalog/README.md`](catalog/README.md), [`data/agent-tests/`](data/agent-tests/) |

## Planning scratch

[`planning/session-devlog.md`](planning/session-devlog.md) — append-only session log (not canonical).

[`planning/adaptive-road-planning.md`](planning/adaptive-road-planning.md) — active roadplan / proc-nav program (implementation contract; not architecture canon).

## Archive

[`archive/README.md`](archive/README.md) — superseded phase-2/3 design, old experiments, stale guides.

Legacy redirects at `docs/` root: [`architecture.md`](architecture.md), [`mc-cheatsheet.md`](mc-cheatsheet.md), [`mc-commands.md`](mc-commands.md), [`context-tests/README.md`](context-tests/README.md).

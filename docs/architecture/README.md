# Architecture direction: bots and agents

This folder holds the working design for hermescraft's next architectural direction — separating the body (which Minecraft player) from the expertise (what kind of work). A card pairs them per phase. Steward dissolves into bot-less agents. Workers spawn fresh per card with a narrow skill catalog.

Status: **design exploration** (2026-06-05). Not yet built. Validating with one prototype skill bundle ([`skills/agent-navigator.md`](../../skills/agent-navigator.md)) before scaling.

## Doc map (canonical owner — avoid duplicating elsewhere)

| Topic | Owner doc | Do not re-spec in |
|---|---|---|
| Problem, vocabulary, card-flow diagram | [`target.md`](target.md) | README (summary only) |
| **Reflex-first bot ↔ agent interface** (registry vs agent surface, delivery order, evidence loop) | [`embodied-control.md`](embodied-control.md) | mc-command-reference § A (sunset to generator); duplicate taxonomy in skills |
| Hermes profiles, L0–L3, skill matrix, DSL parse shapes | [`hermes-agents.md`](hermes-agents.md) | target (link only) |
| Epic metadata, `--epic` / `--depends-on`, card modes, auto-nav | [`epic-lifecycle.md`](epic-lifecycle.md) | hermes-agents (link) |
| Bot registry, fleet names, `mc`, marks, mutex, **fleet binding** | [`bots-and-mc.md`](bots-and-mc.md) | bot-roster (stub) |
| **Bot lease** (`mc bot checkout`, genesis v2 pull bodies) | [`bot-lease.md`](bot-lease.md) | bots-and-mc (summary only) |
| Bot/worker **supervision** (PID, restart) | [`components.md`](components.md) § Supervision contract | bots-and-mc (link only) |
| **Fleet status** snapshot schema | [`data-api.md`](data-api.md) § Fleet state record | dashboard spec (UI only) |
| Processes, ticks, APIs | [`components.md`](components.md) | impact (migration only) |
| Git workspace, OWNERS, two boards | [`workspaces.md`](workspaces.md) | data-api (recall vs git table only) |
| Recall stream + host operations HTTP | [`data-api.md`](data-api.md) | dashboard spec (UI) |
| Dispatcher tick, bind, maint | [`board-dynamics.md`](board-dynamics.md) | target flow (one diagram) |
| Colony dashboard UI + trends | [`dashboard-metrics-spec.md`](dashboard-metrics-spec.md) | data-api (rollup pointer) |
| Dashboard wireframes (HTML) | [`dashboard-wireframes.html`](dashboard-wireframes.html) | metrics spec (ASCII removed) |
| End-to-end board example | [`example-wheat-farm-walkthrough.md`](example-wheat-farm-walkthrough.md) | epic-lifecycle (summary row) |
| Observation cards (W2 desk peek) | [`observe-cards.md`](observe-cards.md) | bots-and-mc (detail) |
| Hermes upstream primitives | [`hermes-v0.15-reference.md`](hermes-v0.15-reference.md) | target v0.15 table (high level) |
| Today → target code touchpoints | [`impact.md`](impact.md) | components (inventory) |
| Visual narrative + walkthrough stepper | [`architecture-visual-guide.html`](architecture-visual-guide.html) | keep in sync with target + walkthrough |
| **`mc verify`** facade | [`mc-verify-spec.md`](mc-verify-spec.md) | embodied-control (summary); observation grammar (detail) |
| Scheduled / cron colony cards | [`scheduled-operations.md`](scheduled-operations.md) | epic-lifecycle (card shape only) |

## Reading order

| # | Doc | What it gives you |
|---|---|---|
| 1 | [architecture-visual-guide.html](architecture-visual-guide.html) | Visual language + **§10 wheat walkthrough stepper** (sync with markdown). |
| 2 | [target.md](target.md) | Canonical target-architecture statement. Layers, vocabulary, what's load-bearing. |
| 2a | [embodied-control.md](embodied-control.md) | **Convergence strategy** — reflex-first vision, registry vs agent surface, spine/facade delivery order, evidence loop; not a fourth taxonomy. |
| 2b | [components.md](components.md) | **Runtime map** — processes, ticks, host scripts, APIs, agent userland. |
| 3 | [hermes-agents.md](hermes-agents.md) | Hermes profiles, skill layers (L0–L3), roster matrix, planner DSL, coordination agents. |
| 3b | [bots-and-mc.md](bots-and-mc.md) | Bot registry, fleet names (§ Target fleet roster), `mc`, HTTP, marks, § Fleet binding. |
| 3c | [bot-roster.md](bot-roster.md) | Redirect → bots-and-mc (stable link). |
| 3d | [epic-lifecycle.md](epic-lifecycle.md) | Epic metadata, `--epic` vs `--depends-on`, card modes, auto-nav. |
| 3e | [example-wheat-farm-walkthrough.md](example-wheat-farm-walkthrough.md) | Worked example: board timeline, handoffs, latency overhead, artifacts. |
| 4 | [workspaces.md](workspaces.md) | Storage model: access layers, five-domain workspace, OWNERS.yaml, two-board split, lifecycle. |
| 5 | [data-api.md](data-api.md) | Host data API — append-only **recall stream** (`subject` + `type` + place) plus fleet operations endpoints. |
| 6 | [board-dynamics.md](board-dynamics.md) | Operations layer: leasing, lexicographic bind, maintenance, recovery, capacity. |
| 7 | [impact.md](impact.md) | Where the new model touches existing code (grouped by area). |
| 8 | [hermes-v0.15-reference.md](hermes-v0.15-reference.md) | Hermes primitives our architecture cites. |
| 9 | [dashboard-metrics-spec.md](dashboard-metrics-spec.md) | **Colony & fleet overview** — metrics, plumbing, phases. Wireframes: [dashboard-wireframes.html](dashboard-wireframes.html). |

## Next steps (working list)

Not a roadmap — what's actively in play. Update as we go.

- POC: hand-write one card using the [`skills/agent-navigator.md`](../../skills/agent-navigator.md) prototype + measure context/turns/time vs today's wide-worker baseline.
- If POC wins: write `skills/agent-miner.md` next (largest payoff target).
- Open: agent registry file timing (`data/agents.yaml`) — see [`hermes-agents.md`](hermes-agents.md) open questions.
- Open: pinch test on `@crafter` — needs a `minecraft-crafting` companion skill that doesn't exist yet ([`hermes-agents.md`](hermes-agents.md) skill matrix).
- **Fleet binding:** normative contract in [`bots-and-mc.md`](bots-and-mc.md) § Fleet binding; **W1 wheat PASS** (`w1-1780879052`) supports A6 on single-bot role profiles + `.env` MC channel — next: wire `spawn-with-bot.sh` for per-card body (W4); fleet-state writer per [`data-api.md`](data-api.md) § Fleet state record.
- **Bot lease MVP:** [`bot-lease.md`](bot-lease.md) + live runbook [`../guides/bot-lease-live-runbook.md`](../guides/bot-lease-live-runbook.md); follow-ups in § Deferred (post-MVP).

## Related docs that stay where they are

- [`../platform/hermes-upgrade-0.15-runbook.md`](../platform/hermes-upgrade-0.15-runbook.md) — **v0.15 upgrade runbook** (prerequisite for architecture primitives). Design catalog: [`hermes-v0.15-reference.md`](hermes-v0.15-reference.md).
- [`../specs/kanban/plugin-landfolk.md`](../specs/kanban/plugin-landfolk.md) — per-bot mutex (still load-bearing because `max_in_progress` is board-wide, not per-assignee). Note: the doc's "hooks never registered" banner is stale; the hook IS live at `plugins/landfolk/__init__.py:28`.
- [`../specs/world/marks-sign-anchored.md`](../specs/world/marks-sign-anchored.md) — `:mark:` notation borrowed here.
- [`../testing/playbooks/design-composable-playbooks.md`](../testing/playbooks/design-composable-playbooks.md) — superseded precursor. Stays for the closed improvement-pass artifacts it documents. **Successor harness direction:** [`../testing/procedural/testing-model.md`](../testing/procedural/testing-model.md).
- [`../planning/adaptive-road-planning.md`](../planning/adaptive-road-planning.md) — roadplan / proc-nav implementation contract (not re-specified here).
- Colony narrow-vs-wide POC postmortem (archived): [`../archive/planning/expeditions/2026-06-13-colony-poc-narrow-vs-wide.md`](../archive/planning/expeditions/2026-06-13-colony-poc-narrow-vs-wide.md).

## What this direction is, briefly

Today: one profile per bot carries the whole skill catalog. Target: **agents** (Hermes expertise) + **bots** (registry bodies) per card — see [`target.md`](target.md). Interface philosophy: **reflex-first embodied control** — see [`embodied-control.md`](embodied-control.md).

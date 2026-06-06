# Architecture direction: bots and agents

This folder holds the working design for hermescraft's next architectural direction — separating the body (which Minecraft player) from the expertise (what kind of work). A card pairs them per phase. Steward dissolves into bot-less agents. Workers spawn fresh per card with a narrow skill catalog.

Status: **design exploration** (2026-06-05). Not yet built. Validating with one prototype skill bundle ([`skills/agent-navigator.md`](../../skills/agent-navigator.md)) before scaling.

## Doc map (canonical owner — avoid duplicating elsewhere)

| Topic | Owner doc | Do not re-spec in |
|---|---|---|
| Problem, vocabulary, card-flow diagram | [`target.md`](target.md) | README (summary only) |
| Hermes profiles, L0–L3, skill matrix, DSL parse shapes | [`hermes-agents.md`](hermes-agents.md) | target (link only) |
| Epic metadata, `--epic` / `--depends-on`, card modes, auto-nav | [`epic-lifecycle.md`](epic-lifecycle.md) | hermes-agents (link) |
| Bot registry, fleet names, `mc`, marks, mutex | [`bots-and-mc.md`](bots-and-mc.md) | bot-roster (stub) |
| Processes, ticks, APIs | [`components.md`](components.md) | impact (migration only) |
| Git workspace, OWNERS, two boards | [`workspaces.md`](workspaces.md) | data-api (recall vs git table only) |
| Recall stream + host operations HTTP | [`data-api.md`](data-api.md) | dashboard spec (UI) |
| Dispatcher tick, bind, maint | [`board-dynamics.md`](board-dynamics.md) | target flow (one diagram) |
| Colony dashboard UI + trends | [`dashboard-metrics-spec.md`](dashboard-metrics-spec.md) | data-api (rollup pointer) |
| End-to-end board example | [`example-wheat-farm-walkthrough.md`](example-wheat-farm-walkthrough.md) | epic-lifecycle (summary row) |
| Hermes upstream primitives | [`hermes-v0.15-reference.md`](hermes-v0.15-reference.md) | target v0.15 table (high level) |
| Today → target code touchpoints | [`impact.md`](impact.md) | components (inventory) |
| Visual narrative + walkthrough stepper | [`architecture-visual-guide.html`](architecture-visual-guide.html) | keep in sync with target + walkthrough |

## Reading order

| # | Doc | What it gives you |
|---|---|---|
| 1 | [architecture-visual-guide.html](architecture-visual-guide.html) | Visual language + **§10 wheat walkthrough stepper** (sync with markdown). |
| 2 | [target.md](target.md) | Canonical target-architecture statement. Layers, vocabulary, what's load-bearing. |
| 2b | [components.md](components.md) | **Runtime map** — processes, ticks, host scripts, APIs, agent userland. |
| 3 | [hermes-agents.md](hermes-agents.md) | Hermes profiles, skill layers (L0–L3), roster matrix, planner DSL, coordination agents. |
| 3b | [bots-and-mc.md](bots-and-mc.md) | Bot registry, fleet names (§ Target fleet roster), `mc`, HTTP, marks. |
| 3c | [bot-roster.md](bot-roster.md) | Redirect → bots-and-mc (stable link). |
| 3d | [epic-lifecycle.md](epic-lifecycle.md) | Epic metadata, `--epic` vs `--depends-on`, card modes, auto-nav. |
| 3e | [example-wheat-farm-walkthrough.md](example-wheat-farm-walkthrough.md) | Worked example: board timeline, handoffs, latency overhead, artifacts. |
| 4 | [workspaces.md](workspaces.md) | Storage model: access layers, five-domain workspace, OWNERS.yaml, two-board split, lifecycle. |
| 5 | [data-api.md](data-api.md) | Host data API — append-only **recall stream** (`subject` + `type` + place) plus fleet operations endpoints. |
| 6 | [board-dynamics.md](board-dynamics.md) | Operations layer: leasing, lexicographic bind, maintenance, recovery, capacity. |
| 7 | [impact.md](impact.md) | Where the new model touches existing code (grouped by area). |
| 8 | [hermes-v0.15-reference.md](hermes-v0.15-reference.md) | Hermes primitives our architecture cites. |
| 9 | [dashboard-metrics-spec.md](dashboard-metrics-spec.md) | **Colony & fleet overview** dashboard — economy, productivity, strategy, intelligence, LLM burn (wireframes). |

## Next steps (working list)

Not a roadmap — what's actively in play. Update as we go.

- POC: hand-write one card using the [`skills/agent-navigator.md`](../../skills/agent-navigator.md) prototype + measure context/turns/time vs today's wide-worker baseline.
- If POC wins: write `skills/agent-miner.md` next (largest payoff target).
- Open: agent registry file timing (`data/agents.yaml`) — see [`hermes-agents.md`](hermes-agents.md) open questions.
- Open: pinch test on `@crafter` — needs a `minecraft-crafting` companion skill that doesn't exist yet ([`hermes-agents.md`](hermes-agents.md) skill matrix).

## Related docs that stay where they are

- [`../guides/hermes-0.15-upgrade.md`](../guides/hermes-0.15-upgrade.md) — **v0.15 upgrade runbook** (prerequisite for architecture primitives). Design catalog: [`hermes-v0.15-reference.md`](hermes-v0.15-reference.md).
- [`../features/landfolk-plugin.md`](../features/landfolk-plugin.md) — per-bot mutex (still load-bearing because `max_in_progress` is board-wide, not per-assignee). Note: the doc's "hooks never registered" banner is stale; the hook IS live at `plugins/landfolk/__init__.py:28`.
- [`../features/sign-anchored-placemarks.md`](../features/sign-anchored-placemarks.md) — `:mark:` notation borrowed here.
- [`../features/agent-playbooks.md`](../features/agent-playbooks.md) — superseded precursor. Stays for the closed improvement-pass artifacts it documents.

## What this direction is, briefly

Today: one profile per bot carries the whole skill catalog. Target: **agents** (Hermes expertise) + **bots** (registry bodies) per card — see [`target.md`](target.md).

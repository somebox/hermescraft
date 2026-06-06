# Target architecture

Status: **design exploration** (2026-06-05). Not yet built. This is the canonical statement of the architecture we're building toward. Other docs in this folder zoom into specific parts: [`hermes-agents.md`](hermes-agents.md) for Hermes profiles and skills, [`bots-and-mc.md`](bots-and-mc.md) for in-game control, [`components.md`](components.md) for processes and APIs, [`workspaces.md`](workspaces.md) for the storage model, [`board-dynamics.md`](board-dynamics.md) for operations, [`impact.md`](impact.md) for where this touches existing code.

If you want the visual version first, open [`architecture-visual-guide.html`](architecture-visual-guide.html) in a browser.

---

## The problem

Long Minecraft worker sessions thrash. The diagnosis:

- Worker context grows linearly per turn; decision-relevant context stays roughly constant.
- A single worker loads a wide skill catalog (nav + mining + crafting + building + survival) regardless of what the current card actually needs.
- A flash-tier model with too many plausible next actions per turn produces fewer good ones.
- Phase transitions inside one card (navigate → mine → return → craft) accumulate noise in the working set — failed move attempts, stale observations, intermediate plans.

The fix is not a stronger model. It's **smaller scope per agent invocation**. The card boundary is the natural place to reset scope.

## The model in three sentences

**Agents are actor identities. Bots are bodies. Cards pair them per phase.**

An **agent** is a Hermes profile that owns expertise — its own home (`~/.hermes/profiles/<agent>/`), its preferred model, its skills, its accumulated cross-bot memory, its SOUL. `@navigator`, `@miner`, `@crafter` are agents; so are bot-less coordinators `@planner`, `@dispatcher`, `@overseer`. A **bot** is a Minecraft player body — a Mineflayer process with login credentials and an HTTP API on a known port. Bots aren't Hermes profiles; they're registry entries (`data/bots/<bot>.yaml`) the agents remote-control. Each card spawns a fresh worker on the agent's profile (with the bot's MC env injected when bot-bound), runs one phase, and exits clean.

## The vocabulary

Six categories. Detailed in [`architecture-visual-guide.html`](architecture-visual-guide.html); summarized here:

| Category | What it is | Examples |
|---|---|---|
| **Role** | Architectural concern | planning, allocation, execution, review, watch, tooling |
| **Agent** | A named actor identity — Hermes profile with expertise | `miner`, `navigator`, `crafter`, `planner`, `dispatcher` |
| **Bot** | A named player body — Mineflayer + registry entry; persona (later) | [`bots-and-mc.md`](bots-and-mc.md#target-fleet-roster) |
| **Workspace** | A directory of state and code (often git-backed) | `data/agents/miner/`, `~/.hermes/profiles/miner/workspace/` |
| **Card** | A unit of work on the kanban board | `assignee=<agent>` + optional `metadata.bot=<bot>` + optional `metadata.card_kind` |
| **Human** | The operator | Sets goals, reviews, intervenes on edge cases |

## Three concerns

Architectural concerns are abstract jobs. Each maps to one or more **Hermes agent profiles** (not bots). Data flows top to bottom; execution completes back up through review and side channels (watch, tooling).

| Order | Concern | Primary agent(s) | Bot-bound? | Delivers |
|---|---|---|---|---|
| 1 | **Planning** | `@planner` | No | Parses `@mention` DSL → intents; triage + research cards; LLM for prose cards |
| 2 | **Allocation** | `@dispatcher` (script OK at MVP) | No | Fleet snapshot; bind `metadata.bot`; maintenance + rebind ([`board-dynamics.md`](board-dynamics.md)) |
| 3 | **Execution** | `@navigator`, `@miner`, `@crafter`, `@builder`, `@farmer`, `@soldier`, … | Yes (when `metadata.bot` set) | One phase per card; fresh worker; MC env injected at spawn |
| 4 | **Review** | `@overseer` | No | Epic judgment; optional per-card verify |
| — | **Watch** | *(no profile at MVP)* | — | URGENT cards, dispatcher tick |
| — | **Curation** | *(no profile at MVP)* | — | Recall compaction → git ([`data-api.md`](data-api.md)) |
| — | **Tooling** | operator + back-office | — | Workspace scripts, `[MR]` cards |

There is no Steward orchestrator bot. `@planner`, `@dispatcher`, and `@overseer` replace Steward’s planning, dispatch, and judgment. The Steward **player** (if kept) is a normal registry bot. See [`hermes-agents.md`](hermes-agents.md) for roster and **additional profile ideas**.

## How cards flow

```
Operator drops triage card with @mention DSL body
   │
   ▼
@planner (Hermes profile) wakes on triage event
   │   Reads body, parses @mentions, validates :marks: (bot /marks or base file)
   │
   ▼
@planner emits N intents (agent named, bot blank) to @dispatcher
   │
   ▼
@dispatcher (Hermes profile) reads fleet state, applies bind rules
   │   Sets metadata.bot per intent ([`board-dynamics.md`](board-dynamics.md))
   │
   ▼
@dispatcher writes N kanban_create calls:
   │   assignee = <agent>      (e.g. "miner")
   │   metadata.bot = <bot>    (e.g. "pip")
   │   skills = [agent-miner-bundle, ...]
   │
   ▼
Hermes/landfolk dispatcher claims first card
   │   Profile=~/.hermes/profiles/miner/ → loads agent home
   │   metadata.bot=pip → spawn injects MC_API_URL + MC_USERNAME for pip
   │
   ▼
Worker spawns with miner's expertise + pip's body env
   │   Calls skill_view('agent-miner') turn 1; runs phase
   │
   ▼
Worker calls kanban_complete with handoff metadata; exits
   │
   ▼
post_tool_call hook promotes next ready card for that bot
   │   (mutex enforced on metadata.bot, not assignee)
   │
   ▼
(chain continues; on failure, @dispatcher writes a repair card)
   │
   ▼
All children done → parent root ready → @overseer judges epic completion
```

Epic **metadata**, **`--epic` vs `--depends-on`**, progress as child counts, review + follow-up doc: [`epic-lifecycle.md`](epic-lifecycle.md).

Detail walkthroughs: [`hermes-agents.md`](hermes-agents.md) (profiles + DSL), [`bots-and-mc.md`](bots-and-mc.md) (`mc` + registry), [`board-dynamics.md`](board-dynamics.md) (dispatch tick, mutex, recovery).

## What we lean on v0.15 for

| Need | v0.15 primitive |
|---|---|
| Narrow skill catalog per card | `kanban_create(skills=[...])` |
| Per-phase budget | `kanban_create(max_runtime_seconds=N)` |
| Safe retries | `kanban_create(idempotency_key=...)` |
| Lease + heartbeat + reclaim | `claim_lock` + `kanban_heartbeat` + TTL |
| Event-driven rebind | `WS /api/plugins/kanban/events?since=<id>` |
| Worker introspection | `GET /api/plugins/kanban/workers/active` |
| Sequential / parallel phases | `kanban_create(parents=[...])` |
| Intra-phase model routing | `delegate_task(model=...)` for short bot-less cards |

Field-level detail in [`hermes-v0.15-reference.md`](hermes-v0.15-reference.md).

## What we build

| Need | Where it lives |
|---|---|
| Hermes profile per agent | `~/.hermes/profiles/<agent>/` (one per agent, set up by deploy script) |
| Bot registry | `data/bots/<bot>.yaml` (port, username, description) |
| Per-card MC env injection at spawn | Custom dispatcher layer (see below) |
| Per-bot mutex | `landfolk` plugin gate-check, extended to read `metadata.bot` |
| `@mention` DSL parser | Deterministic Python lib + `@planner` agent loop |
| Fleet state + bind rules | `@dispatcher` tick (lexicographic; see [`board-dynamics.md`](board-dynamics.md)) |
| Agent skill bundles | `data/workspace/reference/skills/agent-<name>.md` — skill **layers** L0–L3 in [`hermes-agents.md`](hermes-agents.md) |
| Agent SOULs | `data/workspace/reference/souls/<agent>.md` — deployed to each profile's `SOUL.md` |
| Shared git workspace (audited / designed content) | `data/workspace/` — domain-organized (geo, infra, production, operations, reference); ownership in `OWNERS.yaml`; PRs via back-office board |
| Live operational data | Host data API at `/api/workspace/*` — **recall stream** (cross-bot report/query for task-time memory) + fleet/dispatch operations. Compacted catalogs land in git via workspace cards. Optional spatial catalog is phase 2. See [`data-api.md`](data-api.md). |
| Bot-bound runtime context | Card metadata + agent workspace (when needed) |
| Distributed commands | `bin/` (e.g. `mc`) — installed to each profile's PATH at deploy; read-only at runtime |
| Preemption + repair chains | Conventions on top of `kanban_block` reasons |

### The per-card MC env injection problem

v0.15 has **no native `pre_spawn` hook** for per-card env modification. For bot-bound cards (`metadata.bot` is set), the worker spawn needs the bot's MC env vars (`MC_API_URL`, `MC_USERNAME`) injected at spawn time. The agent profile doesn't have them in its `.env` — they're per-card.

Resolution: bot-bound spawn goes through our custom dispatcher (either an extension to the `landfolk` plugin's gate-check, or a small spawn wrapper). For bot-less cards (no `metadata.bot`), Hermes' embedded dispatcher handles spawn natively (just loads the agent profile).

This is a real but bounded customization, consistent with what `scripts/landfolk-control.sh` already does today (explicit `env … hermes …` invocation).

## What we deliberately don't do

- **Late binding at dispatch.** v0.15 requires `assignee` at create. `@dispatcher` binds at write time and rebinds via `hermes kanban reassign` on WS death events.
- **Per-task `model_override`.** Not exposed on v0.15. Per-agent profile model + intra-phase `delegate_task` are the only routing knobs.
- **Mid-card agent swap.** One card = one agent = one fresh context. Phase transitions are card boundaries.
- **Hermes core patches.** Spawn-env injection is in our dispatcher layer, not in Hermes itself.
- **`kanban swarm` for outer phases.** Our work is sequential at the bot level (one body, one act at a time). Swarm topology is for parallelizable problems.
- **Agent runtime access to the source tree.** Workers spawn with `cwd=data/workspace/` and a `pre_tool_call` hook in the landfolk plugin enforces a path allowlist. Agents see workspace + their own Hermes home + distributed `bin/` commands; they don't see `bot/`, `plugins/`, `scripts/`, `dashboard/`. See [`workspaces.md`](workspaces.md) for the five-layer access model.

## What success looks like

The prototype card on `@navigator` beats today's baseline on:
- Worker context tokens at completion (smaller)
- Turn count (fewer)
- Time to complete (faster or equal)
- Success rate (equal or better)

If yes, the architecture pays off and we scale. If no, the bundle content is wrong, not the model — revise content first.

**Reading order and per-topic owners:** [`README.md`](README.md).

There is no roadmap doc. Next steps live in the README as a short working list.

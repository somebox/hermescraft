# Hermes agents — profiles, skills, and card roles

Status: **design exploration** (2026-06-05). **Hermes-side** design: who runs on a card (`assignee`), skill layers, coordination profiles, and planner routing. **In-game control** (`mc`, bot HTTP, registry bodies) lives in [`bots-and-mc.md`](bots-and-mc.md). Vocabulary and flow: [`target.md`](target.md).

| Topic | Doc |
|---|---|
| Epic metadata, spec list vs DSL, `@mentions` | [`epic-lifecycle.md`](epic-lifecycle.md) |
| Dispatch bind, mutex on bot | [`board-dynamics.md`](board-dynamics.md) |
| Recall on complete | [`data-api.md`](data-api.md) |
| Skills/SOULs in git | [`workspaces.md`](workspaces.md) |
| Hermes primitives cited | [`hermes-v0.15-reference.md`](hermes-v0.15-reference.md) |
| Registry vs agent `mc` surface | [`embodied-control.md`](embodied-control.md) |

Skill sources today: [`skills/`](../../skills/) (bundles + `minecraft-*` companions). Benchmark bundle: [`skills/agent-navigator.md`](../../skills/agent-navigator.md).

---

## Assignee vs body (one sentence each)

- **Agent** — Hermes profile (`~/.hermes/profiles/<agent>/`): SOUL, model, skills, memory. Card field **`assignee`**.
- **Bot** — Mineflayer player via registry (`data/bots/<bot>.yaml`). Card field **`metadata.bot`** when bot-bound.

Do not create Hermes profiles named `pip` / `mox` (those are **bots**). Registry: [`bots-and-mc.md`](bots-and-mc.md#target-fleet-roster). Vocabulary: [`target.md`](target.md).

**Worker lifecycle (Hermes):** one card → one spawn on the **agent** profile → complete or block → exit. No mid-card agent swap. Bot-bound spawns get `MC_*` injected at the host layer ([`bots-and-mc.md`](bots-and-mc.md), [`impact.md`](impact.md) § F).

Bot-less cards: `@planner`, `@dispatcher`, `@overseer`, research/desk work. `@engineer`, `@reporter`, `@sentinel` are not separate MVP profiles (see [Additional profile ideas](#additional-profile-ideas)).

---

## Skill layers (every worker)

| Layer | What | Who loads it |
|---|---|---|
| **L0 — Kanban** | [`kanban-worker.md`](../../skills/kanban-worker.md) | Every dispatched worker |
| **L1 — Survival + opportunistic craft** | [`minecraft-survival.md`](../../skills/minecraft-survival.md) | All **bot-bound execution** agents |
| **L2 — Agent bundle** | `agent-<name>.md` — scope, done/stop, handoff | `skill_view` turn 1 |
| **L3 — Companions** | `minecraft-*.md`, playbooks | `kanban_create(skills=[...])` |

**Agent surface (`mc` visibility):** the full handler registry stays large; each worker sees a **curated subset** — L2 **Verbs** sections, L3 companions, and playbook phase whitelists define the **core lane** for that card; everything else is **microscope tier** (valid but not turn-1 context). Target: generated `mc help --profile <agent>` from registry tiers. Policy: [`embodied-control.md`](embodied-control.md) § Two layers.

**L1** — short craft ladder (torches, tools, table) without a `@crafter` card; no bulk smelt or chest org.

| | L1 (execution agents) | `@crafter` |
|---|---|---|
| Craft | Tools, torches, emergency gear | Smelt/craft at scale, equip journeys |
| Storage | Use chests | Chest organisation, deposit/withdraw contracts |
| Later | — | Machines (hoppers, simple automation) |

Companion gap: author **`minecraft-crafting.md`** (merge useful parts of `minecraft-chores.md`).

**Desk modes** — workspace file tools, recall read APIs: `metadata.card_kind` ≠ `execute` ([`epic-lifecycle.md`](epic-lifecycle.md)); not full `minecraft-navigation` on spawn.

---

## Card roles (summary)

Execution vs plan/review/research and **`metadata.card_kind`** — full mode table, desk skills, and `@mentions` rules: [`epic-lifecycle.md`](epic-lifecycle.md) (§ Card modes, § Kanban `@mentions`).


## Planner routing: explicit DSL (pilot parser)

**Spec-first epics** and task-kind → assignee map: [`epic-lifecycle.md`](epic-lifecycle.md) (§ Task spec vs `@agent`).

**Explicit `@` lines** — implement parser shapes in order:

1. `@navigator <bot> to :mark:`
2. `@<agent> <bot> <free-text action>`
3. `[parents: …]` — optional deps

Example:

```
@crafter pip equip for journey (pickaxe, food, torches)
@navigator pip to :mine_nw:
@miner pip extract 32 iron at :mine_nw:
@navigator pip return to :base_anchor:
```

Each `@` line → `kanban_create`: `assignee`, `metadata.bot`, `skills`, chained `parents`. **Single-bot chain:** epic sets `metadata.bot`; assignee rotates navigator → miner → … on the same body ([`epic-lifecycle.md`](epic-lifecycle.md)).

**Intent vs materialized card:** When `@planner` emits **intents** (ready rows with `assignee` but **no** `metadata.bot` yet), `@dispatcher` BIND sets the body per [`board-dynamics.md`](board-dynamics.md). When the pilot DSL parser materializes a line directly (bot name in the `@` line), **`metadata.bot` is set at create** — dispatcher only validates availability and mutex, it does not silently reassign a named bot.

Cards **without** `@mentions` use prose decomposition or Hermes auto-decompose.

---

## Profile tiers (build order)

| Tier | Profiles | Rationale |
|---|---|---|
| **Pilot** | `@navigator` | Phase-as-card proof |
| **MVP chain** | + `@planner`, `@dispatcher` | Parse + bind; dispatcher script-first |
| **Core execution** | + `@miner`, `@crafter`, `@builder` | Mine → store → build |
| **Later** | `@farmer`, `@soldier`, `@overseer` | Food/combat/review |

---

## Core profiles — skill matrix

| Agent | Agent bundle | Spawn skills (L2+L3) | Phase scope | Hooks |
|---|---|---|---|---|
| `@navigator` | `agent-navigator.md` ✓ | `agent-navigator`, `minecraft-navigation`, `minecraft-survival` | Move to `:mark:`; L1 craft only | recall terrain; dispatcher travel |
| `@miner` | `agent-miner.md` | `agent-miner`, `minecraft-mining`, `minecraft-survival` | Extract; tunnels; L1 tools | `subject=iron_ore`, `type=resource` |
| `@crafter` | `agent-crafter.md` | `agent-crafter`, `minecraft-crafting` (new), `minecraft-survival` | Smelt/craft/deposit; chest org | chest snapshots |
| `@builder` | `agent-builder.md` | `agent-builder`, `minecraft-building`, `minecraft-blueprints` | Blueprint place/verify | regions / damage |
| `@farmer` | `agent-farmer.md` | `agent-farmer`, `minecraft-farming`, `minecraft-chores`, `minecraft-survival` | Crops, animals, coops | playbook ingest updates |
| `@soldier` | `agent-soldier.md` | `agent-soldier`, `minecraft-combat`, `minecraft-survival` | URGENT combat; L1 armor | preempt ([`board-dynamics.md`](board-dynamics.md)) |
| `@planner` | `agent-planner.md` | `agent-planner`, `minecraft-planning` (shrink) | Parse DSL; triage; spawn research | board, goals, marks |
| `@dispatcher` | optional / script | — | Lexicographic bind; maint | fleet-state ([`data-api.md`](data-api.md)) |
| `@overseer` | `agent-overseer.md` | `agent-overseer` | Epic verify | acceptance metadata |

**@farmer** consolidates former `@forager` / `@rancher` — hunt vs tend is **card body**, not separate profiles.

**Bundle sections (MVP):** scope, **verbs** (point to [`bots-and-mc.md`](bots-and-mc.md) + L3 companions), done, stop. Add **Research** for doc cards on `@farmer`, `@builder`, `@planner`.

---

## Coordination agents (compact)

- **@planner** — Bot-less. Spec map + DSL parse; LLM for prose triage; spawns research/review cards.
- **@dispatcher** — Bot-less or **script tick** ([`board-dynamics.md`](board-dynamics.md)). Bind, maint, WS rebind; no LLM in bind at MVP.
- **@overseer** — Bot-less. Epic completion; per-card verify absorbed from `@verifier` idea.

---

## Hermes mapping (no core patches)

| Need | Primitive |
|---|---|
| Narrow skills | `kanban_create(skills=[...])` |
| Sequence / parallel | `parents=[...]` |
| Timeout / idempotency | `max_runtime_seconds`, `idempotency_key` |
| Bot mutex | landfolk gate-check on `metadata.bot` ([`bots-and-mc.md`](bots-and-mc.md)) |
| Escalation | WS kanban events; dispatcher tick |

Spawn env injection is **host layer**, not Hermes core ([`target.md`](target.md)).

---

## MVP build (Hermes-side)

| Piece | MVP | Defer |
|---|---|---|
| Agent registry | Hard-coded task-kind map in planner | `data/agents.yaml` until ≥2 agents |
| Parser | Regex/line parser + tests for shape (1) | Flags, prose mixing |
| Bundles | Deploy `agent-navigator.md` to profile | Full fleet |
| Profiles | `setup-landfolk-profiles.sh` → agent homes | Retire bot-named Hermes homes |

Pilot success: parent body → predictable child cards in one planner pass; navigator pilot vs wide-worker baseline ([`target.md`](target.md) pinch test).

---

## Skill inventory vs [`skills/`](../../skills/)

| Skill | Layer | Used by |
|---|---|---|
| `kanban-worker.md` | L0 | all workers |
| `minecraft-survival.md` | L1 | bot-bound execution |
| `agent-navigator.md` | L2 | `@navigator` (shipped) |
| `minecraft-navigation.md` | L3 | navigator |
| `minecraft-mining.md` | L3 | miner |
| `minecraft-building.md`, `minecraft-blueprints.md` | L3 | builder |
| `minecraft-farming.md`, `minecraft-chores.md` | L3 | farmer |
| `minecraft-combat.md` | L3 | soldier |
| `minecraft-planning.md` | L3 | planner (shrink into agent-planner) |
| `minecraft-perception-advise.md` | L3 | optional observe-heavy |
| `minecraft-goals.md`, `minecraft-steward-*` | retire | planner / overseer |
| `playbook-*.md` | L3 | builder, navigator, farmer |
| **`minecraft-crafting.md`** | L3 **to author** | crafter |

---

## Additional profile ideas

| Idea | Notes |
|---|---|
| `@verifier` | Merge into `@overseer` |
| `@scout` | Survey mode on navigator cards |
| `@reporter` | Recall curation; else compaction |
| `@sentinel` | Watch loops; else URGENT + dispatcher |
| `@engineer` | Back-office `[MR]`; else operator |
| Steward orchestrator | Split: planner + dispatcher + overseer |

---

## Open questions

1. **`data/agents.yaml`** — when to replace hard-coded planner map.
2. **Bot persona** — registry `persona:` vs `reference/souls/bots/` ([`bots-and-mc.md`](bots-and-mc.md)).
3. **`minecraft-basic-craft.md`** — split from survival vs one L1 section.
4. **Research tag** — `[RESEARCH]` title vs `card_kind: research` only.

---

## Pilot checklist (Hermes)

1. ✓ `skills/agent-navigator.md` prototype  
2. Parser stub: DSL shape (1) + tests  
3. Agent profile `navigator` + deploy script path  
4. One `@navigator` pilot card + metrics vs baseline  
5. If win: `@miner` bundle + shape (2); then `data/agents.yaml`  

Plugin/spawn/mutex steps: [`bots-and-mc.md`](bots-and-mc.md).

---

## Related

- [`bots-and-mc.md`](bots-and-mc.md) — registry, `mc`, HTTP, marks, mutex  
- [`target.md`](target.md) — vocabulary and card flow  
- [`epic-lifecycle.md`](epic-lifecycle.md) — epic links, modes, spec-first  
- [`board-dynamics.md`](board-dynamics.md) — bind / maint / interrupt  

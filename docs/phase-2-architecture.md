# Phase 2 Architecture — Hermes-driven Autonomous Minecraft Settlement

> **Status:** architecture draft, post-Phase-1 (validated through Experiments 1.1–1.4).
> **Branch:** `experiment/hermes-agents`. Refactor-scope changes only — no backwards-compat constraint.

## Context

Phase 1 ran four experiments and validated three things and disproved two. **Validated:** `/goal` works as a bounded mission primitive; Hermes Kanban is a real distributed task queue with atomic claims, dependencies, and per-task workers; comments-as-IPC plus auto-injected `worker_context` make cross-card data sharing trivial. **Disproved:** long-lived `/goal` sessions in tmux per character (sessions exit after a few minutes); custom-metric goal-preset injection (unknown metrics get urgency=0).

This document formalizes the architecture Phase 2 will implement.

## The story in one paragraph

A human posts a coarse intent ("we need more stone"). The **steward** — a Hermes profile with its own bot body parked at a fixed tower — enriches it into a structured spec, locates relevant places via the **marks catalog** it curates, and decomposes it into character-assigned kanban cards with explicit coordinates and acceptance predicates. The **kanban dispatcher** spawns a short-lived worker per card, scoped to one character profile and one Mineflayer body. Workers read their brief plus parents' comments (auto-injected by `worker_context`), use the `mc` CLI to act in-game, optionally fan out via `delegate_task` for transient sub-work, post a comment summarizing what they did, and exit. Dependent cards auto-promote and the chain proceeds. The steward simultaneously runs the team's logistics: tracks chest contents, computes distances and supply-chain efficiency, issues rebalancing missions when chests overflow or sit far from where they're needed. The **kanban board + marks catalog + chest inventory** are the entire coordination protocol.

```
HUMAN INTENT  ──────────────────────────────────────────────┐
                                                             │
                          STEWARD                            │
                ┌─────────────────────────────┐              │
                │ Specifier (mission writer)  │ ←────────────┘
                │ Marks catalog (where)       │
                │ Chest inventory (what/where)│
                │ Logistics planner (efficiency)
                │ In-game ATC (chat / patrol) │
                │ Treasury custodian          │
                └─────────────────────────────┘
                              │
                writes cards referencing @marks
                              ↓
                   KANBAN BOARD (the spine)
                              ↓
                   dispatcher → worker (per card)
                              ↓
                   worker uses `mc` against its bot body
                              ↓
                              MINECRAFT
```

## Roles

Five Hermes profiles, each with isolated `HERMES_HOME`, dedicated Mineflayer body, and `MC_API_URL` env scoped to that body.

| Profile | Body | Function | Model |
|---------|------|----------|-------|
| `steward` | port 3001 — fixed tower | Specify, curate marks, plan logistics, ATC chat, treasury | Kimi K2.6 |
| `gatherer` | port 3002 — mobile | Wood, food, plants, scouting | DeepSeek V4 Flash |
| `flint` | port 3003 — mobile | Mining (stone, ore, deep ops) | DeepSeek V4 Flash |
| `mason` | port 3004 — mobile | Building, walls, structures | DeepSeek V4 Flash |
| `barley` | port 3005 — mobile | Farming, food prep, livestock | DeepSeek V4 Flash |

Five Mineflayer bot bodies running long-lived (managed by `landfolk-bodies-only.sh` or systemd-style supervisor), one HTTP server per bot. Hermes processes spawn and exit on demand per kanban task.

## Three layers of control

```
┌────────────────────────────────────────────────────────────┐
│ MACRO   Kanban board                                       │  Persistent.
│         specify → triage → ready → running → done|blocked  │  Audit trail.
└────────────────────────────────────────────────────────────┘
                       ↓ dispatcher spawns
┌────────────────────────────────────────────────────────────┐
│ MISSION One worker process per card                        │  Bounded mission.
│         hermes -p <profile> --skills kanban-worker chat    │  5–20 min, exits.
└────────────────────────────────────────────────────────────┘
                       ↓ worker uses mc
┌────────────────────────────────────────────────────────────┐
│ MICRO   Goal engine on the bot body                        │  Per-tick reflexes.
│         food, threat, supply_*, deposit_* (existing)       │  Steward retargets.
└────────────────────────────────────────────────────────────┘
                       ↓ Mineflayer
                  MINECRAFT WORLD
```

**Macro is the planning surface.** Cards, dependencies, comments. Survives crashes, restarts, and the model-of-the-day.

**Mission is the autonomy unit.** A worker is spawned, briefed via card body + parent comments, runs until `kanban_complete` or `kanban_block`, exits. Token-budgeted, time-budgeted (`max-runtime`), restartable.

**Micro is the survival reflex.** The bot's existing goal engine (`food_score`, `threat_score`, `supply_*`, `deposit_*`) handles autonomic priorities. The steward retargets *known* metrics to bias idle behavior. New objectives don't go here — they go on the kanban board.

## The marks catalog — shared world map

The marks catalog is the team's **canonical spatial vocabulary**. Owned and curated by the steward. Every mission brief references marks by name.

### Schema

```yaml
# data/marks/canonical.yaml — steward-owned, replicated to bot caches
marks:
  base:
    coords: [0, 80, 0]
    kind: settlement
    last_verified: 2026-05-09T17:32
  tower:
    coords: [0, 90, 0]
    kind: structure
    parent_mark: base
    notes: "steward's post; treasury chest adjacent"
  stone_chest:
    coords: [2, 79, -1]
    kind: chest
    holds: [cobblestone, stone]
    capacity_warning_at: 0.8
    parent_mark: base
    inventory:                    # tracked by steward
      cobblestone: 47
      stone: 0
      last_audit: 2026-05-09T17:35
      last_modified_by: mason
  iron_chest:
    coords: [3, 79, -1]
    kind: chest
    holds: [iron_ore, iron_ingot, raw_iron]
    parent_mark: base
    inventory:
      iron_ingot: 12
      raw_iron: 8
      last_audit: 2026-05-09T16:50
      last_modified_by: flint
  treasury:
    coords: [0, 91, 2]
    kind: chest
    holds: [diamond, ender_pearl, golden_apple, enchanted_book]
    access: steward-gated         # workers must request via chat
    parent_mark: tower
  quarry-east:
    coords: [180, 50, 0]
    kind: poi
    notes: "exposed stone vein, 12 blocks visible surface"
    expires_after_h: 48           # re-verify if stale
    discovered_by: flint
    last_verified: 2026-05-08T11:20
  oak-NE:
    coords: [120, 70, 80]
    kind: biome_resource
    holds: [oak_log]
    expires_after_h: 24
```

### Schema choices that earn their keep

- **`kind`** — `settlement | structure | chest | poi | biome_resource | danger | spawn`. Drives default treatment in dashboard + agent prompts.
- **`holds`** — explicit content type list for chests; workers know which chest matches an item.
- **`inventory`** — first-class field for chest marks; logistics depends on this.
- **`capacity_warning_at`** — triggers steward to spawn overflow/expansion missions.
- **`parent_mark`** — relational; if `base` moves, dependent marks can be updated together.
- **`access: steward-gated`** — diegetic permission system; workers request rare items via chat to the steward's in-game body.
- **`expires_after_h`** — POIs and biome resources go stale; steward re-verifies on cadence.
- **`discovered_by` / `last_modified_by`** — provenance for trust/conflict resolution.

### Mark sync across bots

Source of truth: `data/marks/canonical.yaml`, owned by steward profile.
Each bot has a local cache via the existing `bot/data/marks.json` (per-bot file).
Sync paths:
- **At dispatch time:** the dispatcher includes a hook that pushes the relevant subset of marks to the assignee's bot via `POST /marks/replace` before spawning the worker.
- **At runtime, on update:** when steward updates the canonical, it `POST /marks/diff` to all bot bodies.
- **At worker start:** worker can call `mc marks` to see the current local set; the brief can include "ensure marks include @stone_chest, @base, @quarry-east" as a defensive prefix.

If a worker hits stale data (`mc dig @mark_coords` finds nothing), the worker chats `@steward @mark is wrong`. Steward verifies and updates.

## Chest inventory tracking & logistics

The steward's most distinctive role: **simulating logistics without actually pretending it's not Minecraft**. It tracks what's where, computes flows, and routes work to keep supplies near demand.

### How chest inventory stays current

Three concurrent paths, each cheap:

1. **On every deposit/withdraw mission**, the worker is required to comment with the delta (e.g., "deposited 32 cobblestone in @stone_chest"). Steward parses comments and updates canonical.
2. **Periodic audit cron**: every 30 min, dispatcher spawns a `steward-audit-chests` mission. Steward walks to each non-distant chest, calls `mc chest @mark` for each, updates canonical from ground truth.
3. **On-demand audit**: when steward is unsure (conflicting reports, mission planning needs accurate counts), it spawns a single audit task before issuing the dependent missions.

### Logistics planner (steward's reasoning)

The steward periodically (cron or in response to inputs) runs a logistics check. Inputs:
- Marks catalog with chest inventories
- Recent mission completions (what was produced, where, by whom)
- Recent chat (what's been requested)

Outputs (decisions):
- **Capacity warnings** — `@stone_chest` at 80% → spawn "build overflow chest" or "consume some" mission
- **Distance optimization** — `@workshop_chest` always low while `@stone_chest` always full and they're 200 blocks apart → spawn "move 32 stone from @stone_chest to @workshop_chest"
- **Mark relocation suggestions** — repeated tasks consuming from one chest → propose adding a closer dedicated chest
- **Supply-chain throttling** — if iron production has outpaced consumption for 3+ days, deprioritize iron missions; if below threshold, prioritize them
- **Stale POI cleanup** — quarry-east verified 50h ago and `expires_after_h: 48` → spawn verify mission
- **Lost/damaged structure detection** — chest mark exists but `mc chest @mark` returns no container → mark removed; "rebuild @stone_chest" mission spawned

These outputs become **kanban cards posted by the steward** — the same primitives we already validated.

### Distance computation

Two cheap heuristics, suitable for steward-side planning:
- **Manhattan / Euclidean 3D** for default ranking (low cost, "close enough" for routing).
- **Cost-per-block** modifiers per `kind`: water adds X, mountains add Y, danger zones add Z.

Steward keeps a derived table:

```
distance(@base, @quarry-east) = 180.1 blocks (flat)
distance(@base, @oak-NE)      = 145.3 blocks (over hills)
distance(@workshop, @quarry-east) = 220.5 blocks
```

Refreshed lazily; recomputed only when marks change.

## Mission templates

The steward draws from a small library of mission templates. Each has a body shape, default skills, and default success predicate.

| Template | Body shape | Success predicate |
|----------|-----------|-------------------|
| `supply` | "Mine N <item> near @poi, deposit in @chest" | `@chest.inventory[<item>] increased by ≥ N` |
| `withdraw` | "Take N <item> from @chest, deliver to @loc" | `@chest.inventory[<item>] decreased by N` and worker holds N |
| `rebalance` | "Move N <item> from @chest_A to @chest_B" | A decreased, B increased by same |
| `audit` | "Walk to @chest, count contents, comment" | `last_audit` updated; comment present |
| `scout` | "Explore N blocks around @origin in <direction>, mark POIs" | ≥1 new mark created with `discovered_by` set |
| `verify_mark` | "Visit @mark, confirm coords + state" | `last_verified` updated |
| `build` | "Construct <pattern> at @site using N <block>" | Block count at @site matches pattern |
| `respond_chat` | (steward-only) "Read chat for `@steward` mentions, respond, update marks" | Comment per response posted |
| `treasury_dispense` | (steward-only) "Worker requested N diamonds; verify and place in @recipient_chest" | Recipient_chest gained N diamonds |

Templates make steward decomposition tractable — instead of writing prose every time, it picks a template and fills slots.

## The steward's in-game body — when does it act?

The steward profile's bot is a Mineflayer body parked at the tower. It is operated **only when a steward worker is spawned**, which happens via:
- Periodic `respond_chat` cron tasks (every 2 min by default)
- Chest audit cron tasks (every 30 min)
- Logistics-planner cron tasks (every 5 min, wake-gated on changes)
- Treasury dispense missions (one per chat request)
- Initial setup or relocation missions

Between worker invocations the body sits at the tower with goal-engine handling food/threat/staying near the spawn. A custom `steward-role.json` goal-preset pins it to within ~10 blocks of `@tower`. Optionally we add a body-side flag that rejects `dig`/`fight`/`craft` for the steward profile so a hallucinating worker can't make the steward dig a hole.

## Issue management (full table)

| Failure mode | Detection | Response |
|--------------|-----------|----------|
| Worker crash mid-task | Claim TTL expires | Reclaim → respawn next dispatcher tick (validated 1.4) |
| Mission infeasible (tools missing) | Worker recognizes via `mc` errors | `kanban_block` with reason; human or steward replans |
| Hallucinated child cards | `kanban_complete.created_cards` rejected | Worker retries without phantom IDs |
| Bot body crashes | `/health.connected=false` | Supervisor restarts body; current worker blocks; steward reissues affected card |
| Stale mark coordinates | Worker's `mc dig @mark` returns wrong block | Worker chats steward; steward verifies + updates; mission retried |
| Chest contents drift from catalog | Worker's `mc chest @mark` count differs from `inventory` | Worker comments delta; steward syncs canonical |
| Lost chest (broken) | `mc chest @mark` returns no container | Steward removes mark, spawns rebuild mission, alerts in chat |
| Capacity overflow | Worker can't deposit (chest full) | Worker chats steward; steward creates overflow build or alt-chest deposit |
| Cross-mission resource conflict | Two cards want same chest concurrently | Steward serializes via deps at card-creation time |
| Token blowout per mission | `--max-runtime` per card; per-worker turn limit | Dispatcher SIGTERMs, marks `timed_out`, retries up to `max-retries`, then auto-blocks |
| Steward overstepping (leaves tower) | Bot position drift > threshold | SOUL prompt + role goal-preset + body-side rejection of manual labor for steward profile |
| Steward bad decomposition | Human inspects via dashboard | `kanban edit`, `block`, `reassign`, or replan |
| MC server outage | All bots' `/health.connected=false` | All workers block; recovery on server restore; steward chats status |

## Custom dashboard vision (deferred implementation)

The user's idea of a custom dashboard becomes a real architectural driver, not a nice-to-have. Suggested components:

- **Map view**: marks plotted by `kind`, bot positions overlaid live, active cards drawn as edges between source/target marks (e.g., flint → quarry-east → stone_chest).
- **Inventory panel**: chest inventories with capacity bars, color-coded by holds; click a chest → audit history.
- **Mission feed**: live kanban state grouped by character; clicking a card → comments + worker log.
- **Logistics overview**: supply-chain graph (mineable resource → chest → consumer), with throughput rates.
- **Chat console**: send `@steward` queries from the dashboard, see responses inline.
- **Action proposals**: steward's planner output (proposed missions) before they're dispatched, with approve/reject buttons.

This is a separate web app reading from the kanban DB + marks file + bot state APIs. Not part of Hermes's built-in dashboard. Defer implementation; specify the feed APIs in Phase 2 so the dashboard can be built later without architecture changes.

## Refactor plan (branch-scope changes)

These all live on `experiment/hermes-agents` (no backwards-compat needed):

### Action layer (high priority — bottlenecked Phase 1)
- Fix or replace `mc collect` (silent zero-mined failures from 1.1, 1.3, 1.4)
- New `mc place_facing` and `mc dig_facing` for relative ops avoiding "no solid neighbor" issues
- `mc observe_lean` returning only agent-relevant fields (token diet — observation payloads were 90% of message bytes in 1.1)
- `/api-spec` route on bot HTTP server (OpenAPI listing of `/action/*`)
- Anti-revisit memory in pathfinder (1.1's bot-stuck-in-hole problem)

### Marks system (new functionality)
- Canonical marks catalog at `data/marks/canonical.yaml`
- Steward-side library to read/write canonical, compute distances
- Bot-side `POST /marks/replace` and `POST /marks/diff` endpoints
- Auto-sync hook in dispatcher: pre-dispatch marks push to assignee's bot
- Chat-IPC handler in steward worker (parses `@steward` mentions)

### Chest inventory tracking
- New schema field `inventory` on chest marks
- Worker-side comment template for deposit/withdraw deltas
- Steward-side parser to extract deltas from comments → update canonical
- `mc chest @mark` already exists; steward audit task uses it

### Logistics planner (steward skill)
- New skill `~/.hermes/skills/landfolk/steward-logistics/SKILL.md` — planner playbook
- Mission templates as YAML at `data/mission-templates/*.yaml`
- Steward worker reads templates + canonical state → spawns cards

### Profile + dispatcher hardening
- `bin/mc` symlink-resolution fix (already done in 1.4)
- Per-profile `terminal.env_passthrough: [MC_API_URL, MC_USERNAME]` (already done in 1.4)
- Bootstrap script `scripts/setup-landfolk-profiles.sh` that creates all 5 profiles correctly
- `landfolk-bodies-only.sh` to launch the 5 Mineflayer bodies (replaces today's `landfolk-control.sh`)

### Custom metric registration (future)
- Goal engine in `bot/lib/goals/engine.js` to accept arbitrary metrics with `evaluate_fn` expression. Lower priority — retargeting existing metrics covers 90% of cases.

## Migration sequence

Each step is a self-contained PR-shaped change on the branch. Order optimized for parallel-eligible work and early validation.

### Sprint 1 — foundations (1–2 sessions)
1. Fix `mc collect` semantics + add `mined_count` field
2. Implement `mc observe_lean`
3. Add `/api-spec` endpoint
4. `bin/mc` already fixed; commit `setup-landfolk-profiles.sh`

### Sprint 2 — marks system (2–3 sessions)
5. Define canonical marks YAML schema + reader/writer library
6. `POST /marks/replace` + `POST /marks/diff` on bot HTTP server
7. Steward-side library: distance computation, mark CRUD, chat-IPC parser
8. Dispatcher hook to push marks pre-spawn
9. Validation experiment: hand-curated catalog with 3 marks; flint reads `@quarry-east`, mines, deposits at `@stone_chest`

### Sprint 3 — chest inventory + logistics (3–4 sessions)
10. `inventory` schema field on chest marks
11. Worker comment template + steward parser for deltas
12. Mission templates YAML + steward spawn logic
13. Logistics planner cron task + first 3 templates (`supply`, `withdraw`, `rebalance`)
14. Validation experiment: `@stone_chest` overflows → steward spawns rebalance card → mason executes

### Sprint 4 — full team operation (1 long session, then live runs)
15. Five profiles created, five bot bodies running, steward at tower
16. Initial scout missions to populate marks
17. First end-to-end: human posts "we need food" → barley-and-gatherer chain executes
18. Iterate based on observed failures

### Sprint 5+ — dashboard and polish
19. Custom dashboard (separate web app)
20. Anti-revisit pathfinder memory
21. Custom metric registration in goal engine

## Open questions / risks

- **`worker_context` size budget** — pre-injected parent comments are great but could bloat at scale. Need to cap or summarize at N parents deep.
- **Steward as single-point-of-orchestration** — if the steward profile breaks, the team loses planning. Plan: low-cadence backup of canonical YAML; steward worker is restart-tolerant by design.
- **Chat parsing brittleness** — `@steward` mentions parsed by worker LLM. May need a structured chat protocol (`/cmd_arg` style) or rely on the LLM's natural-language tolerance.
- **Token budget at scale** — five profiles × dozens of missions/day × deepseek-v4-flash. Phase 2 should set a hard rail (e.g., $5/day initial); steward can deprioritize missions when approaching.
- **Mineflayer body resource cost** — five bots in one Paper server, each with pathfinding + observation. Server-side load needs monitoring; may need to throttle observation polling.
- **Marks YAML race condition** — concurrent steward workers updating the file. Need a lock file or atomic write pattern (already common solution: write to .tmp, rename).
- **Mission-template debugging UX** — when a card body comes from a template, errors at runtime point at the template, not the planner that picked it. Logs need template-id traceability.

## Success criteria for Phase 2 completion

A 24-hour live run where:
- All 5 character bodies stay connected ≥95% of the time.
- Human posts ≥3 coarse intents → all complete via kanban chains without manual orchestration.
- Steward maintains `last_verified` on all marks within their `expires_after_h` budgets.
- Chest inventories in catalog stay within ±5% of ground-truth (verified by spot audit).
- Token spend stays under $5/day.
- At least one logistics planner intervention (rebalance / overflow / scout) fires unprompted and resolves successfully.
- Dashboard map view shows the live team at a glance (if Sprint 5 completed).

If we hit those, Phase 2 is shippable as the new normal for the Landfolk world.

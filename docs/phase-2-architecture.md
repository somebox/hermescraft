# Phase 2 Architecture — Hermes-driven Autonomous Minecraft Settlement

> **Status:** architecture draft, post-Phase-1 (validated through Experiments 1.1–1.4).
> **Branch:** `experiment/hermes-agents`. Refactor-scope changes only — no backwards-compat constraint.

## Context

Phase 1 ran four experiments and validated three things and disproved two. **Validated:** `/goal` works as a bounded mission primitive; Hermes Kanban is a real distributed task queue with atomic claims, dependencies, and per-task workers; comments-as-IPC plus auto-injected `worker_context` make cross-card data sharing trivial. **Disproved:** long-lived `/goal` sessions in tmux per character (sessions exit after a few minutes); custom-metric goal-preset injection (unknown metrics get urgency=0).

Phase 1 also surfaced a deeper truth: **the bottleneck is the action layer, not the agent reasoning** (`mc collect` silent failures, observation token bloat, pathfinding traps, missing helpers like `place_facing`). Phase 2 takes that seriously — instead of "build the architecture, then run it," Phase 2 is structured as a **co-evolution loop** where each capability level produces both a passing simulation run *and* tooling improvements driven by what the agents struggled with.

## Phase 2 as a co-evolution loop

Phase 2 is **not** "implement the settlement, then play it." It's a continuous loop that improves both gameplay coordination and the underlying tooling at the same time:

```
   ┌────────────────────────────────────────────────────────┐
   │ 1. Pick a capability level (L0…L8 below)               │
   │ 2. Steward composes a capability_test mission          │
   │ 3. Worker runs the test                                │
   │ 4. Outcome:                                            │
   │    a. PASS → mark capability green, advance level      │
   │    b. FAIL with diagnosable cause →                    │
   │       steward creates a `bug_report` card,             │
   │       assigned to `human`, NOT auto-dispatched.        │
   │       Worker's failed test card depends_on the bug.    │
   │ 5. Human pulls bug card, fixes with Claude Code,       │
   │    commits, marks card done with commit SHA.           │
   │ 6. Steward re-runs the original test on next tick      │
   │    → either PASS (advance) or new bug surfaced.        │
   └────────────────────────────────────────────────────────┘
```

The kanban board does double duty: it's the gameplay coordination spine *and* the development backlog. Cards assigned to a character profile flow through the dispatcher; cards assigned to `human` sit ready in the board waiting for me to pull them. Same primitives, two consumer types.

**Capability levels** (in order; later levels depend on earlier passing):

| Level | Theme | Example test missions |
|-------|-------|-----------------------|
| L0 | Foundations & connectivity | `mc connect` health, all 5 bots online, marks API CRUD |
| L1 | Movement | `mc goto`, `goto_near`, `follow`, `look_at`, `go_mark` round-trip |
| L2 | Inventory & equip | `mc inventory`, `equip`, `unequip`, item drops, hand-state |
| L3 | Basic gather + craft | `mc dig` reliably, planks/sticks/wooden tools, crafting table use |
| L4 | Mining | Stone/coal/iron with appropriate pickaxe; cave navigation; lava awareness |
| L5 | Build | `mc place`, `place_facing`, simple structures, foundation handling |
| L6 | Farming & livestock | Plant/harvest wheat, breed animals, food prep |
| L7 | Combat & survival | Engage hostile mobs, flee threshold logic, regen mgmt |
| L8 | Full logistics | Multi-bot supply chain, chest rebalancing, treasury dispense |

Each level is a **kanban epic** — a parent card with child capability_test cards (one per atomic capability). The steward holds a "capability matrix" derived from card outcomes; only marks a level green when all its children pass cleanly twice in a row.

This document formalizes the architecture; the migration sequence (later) walks the levels in order.

## The story in one paragraph

A human posts a coarse intent ("we need more stone"). The **steward** — a Hermes profile that orchestrates the team — enriches it into a structured spec, locates relevant places via the **marks catalog** it curates, and decomposes it into character-assigned kanban cards with explicit coordinates and acceptance predicates. The steward also has a Mineflayer body that **roams the base** — wandering between marks, peeking into chests, observing the team, occasionally chatting — but the body is a diegetic anchor, not a load-bearing component: if it dies it just respawns and keeps going, and the orchestration role continues uninterrupted whether the body is online or not. The **kanban dispatcher** spawns a short-lived worker per card, scoped to one character profile and one Mineflayer body. Workers read their brief plus parents' comments (auto-injected by `worker_context`), use the `mc` CLI to act in-game, optionally fan out via `delegate_task` for transient sub-work, post a comment summarizing what they did, and exit. Dependent cards auto-promote and the chain proceeds. The steward simultaneously runs the team's logistics: tracks chest contents, computes distances and supply-chain efficiency, issues rebalancing missions when chests overflow or sit far from where they're needed. The **kanban board + marks catalog + chest inventory** are the entire coordination protocol.

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

The full architecture supports five characters, but Phase 2 starts with **two bot bodies** and grows the cast as capability levels are validated. The other roles still exist conceptually; they just aren't instantiated yet.

### Phase 2 starting scope (Sprint 0)

| Assignee | Body | Function | Model | Status |
|----------|------|----------|-------|--------|
| `gatherer` | port 3001 — mobile | Wood, food, plants, scouting | DeepSeek V4 Flash | **Active from start** |
| `flint` | port 3002 — mobile | Mining (stone, ore, deep ops) | DeepSeek V4 Flash | **Active from start** |
| `human` | (none — pulls from board manually) | Code fixes, skill rewrites, schema changes | Claude Code | **Active from start** |
| `steward` | (initially: human role; later: roaming bot) | Specify, plan logistics, ATC chat, marks curation | (n/a yet) | **Deferred — human plays this role until L7+** |

The two-bot starting set was picked because Flint is the most-tested character through Phase 1 (1.1, 1.3, 1.4) and Gatherer rounds out the workload split (mining vs. surface gathering — covers L3–L4 capability tests).

### Deferred roles (added when capability levels justify them)

| Role | Activated when | Why deferred |
|------|---------------|--------------|
| `mason` (port 3003) | After L5 (build) capability passes with Gatherer placing as backup | Building can be tested via Gatherer first; Mason is a specialist |
| `barley` (port 3004) | After L6 (farm) capability passes | Farming is later in capability progression |
| `steward` profile + body (port 3005) | After L7 (combat/survival) and ≥30 marks accumulated | At low scale, human-as-steward is fine; steward profile pays off when there's enough work to coordinate |
| Custom dashboard | After L8 starts | UI shouldn't drive architecture; built once the data model is stable |

### The `human` assignee — first-class kanban concept

Cards assigned to `human` are **never picked up by the dispatcher**. They sit in `ready` until I pull them, fix the issue using Claude Code (or another coding agent) on the `experiment/hermes-agents` branch, commit, mark the card done with a commit SHA, and a re-verification card automatically spawns (via the `verify_fix` template) on the next tick. The dispatcher's worker spawn logic must be patched to **skip tasks assigned to `human`** — see Refactor section.

Until the steward profile exists, **I also play the steward role**: writing capability_test cards, triaging worker failures into bug_reports, scheduling re-runs. As we build out capability levels, more of this gets automated; the steward profile is the destination state, not the starting state.

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
  # tower:                              # ASPIRATIONAL — built by team in a later mission
  #   coords: [0, 90, 0]
  #   kind: structure
  #   parent_mark: base
  #   notes: "steward's post (planned); treasury chest adjacent"
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
    parent_mark: base    # initially at base; moves to @tower once it exists
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

The steward draws from a small library of mission templates. Each has a body shape, default assignee, default skills, and a success predicate. Templates split into three categories: **gameplay** (workers), **infrastructure / dev** (human), and **steward-only** (orchestration).

### Gameplay templates (auto-dispatched)

| Template | Body shape | Success predicate |
|----------|-----------|-------------------|
| `supply` | "Mine N <item> near @poi, deposit in @chest" | `@chest.inventory[<item>] increased by ≥ N` |
| `withdraw` | "Take N <item> from @chest, deliver to @loc" | `@chest.inventory[<item>] decreased by N` and worker holds N |
| `rebalance` | "Move N <item> from @chest_A to @chest_B" | A decreased, B increased by same |
| `scout` | "Explore N blocks around @origin in <direction>, mark POIs" | ≥1 new mark created with `discovered_by` set |
| `verify_mark` | "Visit @mark, confirm coords + state" | `last_verified` updated |
| `build` | "Construct <pattern> at @site using N <block>" | Block count at @site matches pattern |
| `audit` | "Walk to @chest, count contents, comment" | `last_audit` updated; comment present |
| `capability_test` | "Exercise <capability> per spec; report PASS/FAIL with diagnosis" | Steward judges from worker's comment + observable world state |

### Dev / infrastructure templates (assigned to `human`, not auto-dispatched)

| Template | Body shape | Done criteria |
|----------|-----------|---------------|
| `bug_report` | "Capability X failed: <reproduction>, expected <Y>, got <Z>. Diagnosis: <root_cause>. Suggested fix: <area>." | Human marks done with commit SHA + branch name |
| `feature_request` | "Capability X requires new <tool/skill/endpoint> because <gap>. Spec: <details>. Used by missions: <list>." | Human marks done with commit SHA |
| `skill_revision` | "Skill <name> caused agent to <misbehavior>. Specifically: <quote>. Suggested rewrite: <details>." | Human marks done; skill diff in commit |
| `verify_fix` | (steward-only, parent of bug_report) "Re-run <test_card_id> to verify fix from <bug_card_id>." | Test passes; both bug + verify cards close |

### Steward-only templates (cron-driven)

| Template | Body shape | Success predicate |
|----------|-----------|-------------------|
| `respond_chat` | "Read chat for `@steward` mentions, respond, update marks" | Comment per response posted |
| `treasury_dispense` | "Worker requested N diamonds; verify and place in @recipient_chest" | Recipient_chest gained N diamonds |
| `triage_failures` | "Scan recent FAIL capability_test outcomes; for each diagnosable, create bug_report assigned to human" | Bug cards created or noted as already-tracked |
| `verify_human_done` | "For each card with completed parent bug_report, re-run the dependent test" | Test passes (close chain) or new bug_report created |

Templates make steward decomposition tractable — instead of writing prose every time, it picks a template and fills slots.

## The steward's body — separate from the role

The steward **role** (orchestration, marks, logistics, triage) lives entirely in kanban + canonical files + cron-spawned Hermes workers. The steward **body** is an in-world Mineflayer instance that gives the agent a presence in the simulation. **They're decoupled** — the role works whether the body is online or not.

### What the body does (when activated)

A steward worker is spawned periodically (or on demand) via:
- `respond_chat` (every 2 min) — read chat for `@steward` mentions, reply, update marks
- `audit_chests` (every 30 min) — walk to each chest mark, call `mc chest @mark`, sync canonical
- `inspect_base` (every 10 min, low cost) — walk a short loop between marks, observe the team, comment on anything notable in chat
- `logistics_planner` (every 5 min, wake-gated) — runs offline against canonical state; doesn't necessarily move the body
- `treasury_dispense` — on demand, when a worker requests a rare item via chat
- One-off missions — verifying a mark, scouting near base, etc.

When a worker is active, the body roams the base — wandering between marks, peeking into chests, watching others work. Between worker invocations the body just stands wherever it last was. A `steward-role.json` goal-preset keeps it loosely near `@base` via the `stay_near_mark` metric (~30 block leash).

### What the body does NOT do

- **Manual labor.** No mining, fighting, building, farming. The SOUL prompt forbids it; optionally the bot HTTP server rejects `dig`/`fight`/`craft` for the steward profile.
- **Mission claims.** The steward never claims gameplay tasks (supply, build, rebalance, etc.) — only steward-only templates.
- **Critical-path work.** Nothing the team needs to function depends on the body being alive.

### Death & disconnect handling

If the body dies: it respawns at default spawn, the steward agent posts a brief comment in chat ("respawned, headed back"), the agent keeps working through cron-driven workers as usual. **No drama, no critical-path block.** The kanban board does not pause for steward death.

If the body disconnects (server hiccup, network blip): cron tasks that *need* the body (audit, dispense, inspect) detect `/health.connected=false` and either skip the tick or use server-side fallbacks (e.g., `mc chest @mark` → PaperMCP equivalent if available). Headless cron tasks (logistics planner, triage) continue uninterrupted because they don't need the body at all.

### Tower as aspirational future state

The "steward's tower" is a goal, not a starting condition. Once the team is consistently efficient and there's enough material accumulated, **the team can build it as one of its kanban missions** — a 3-card chain like:

```
Card A (gatherer): scout flat ground near @base, mark as @tower-site
Card B (flint):    supply 64 cobblestone to @tower-site
Card C (mason):    build steward-tower pattern at @tower-site
```

Until then, the steward roams. When the tower exists, the steward's `inspect_base` mission can include "climb the tower for a wide-angle observation" as one of its variants. Tower-as-feature, not tower-as-requirement.

### Why have a body at all?

Mostly diegetic, but with real benefits:
- **Workers see "Steward: ..." in chat** — gives the team a face. Coordination via in-game chat feels natural.
- **Direct observation** — body can confirm marks visually without rcon round-trips.
- **Treasury dispensing** — handing items to workers via chest interaction is more tangible than `/give` commands.
- **Vibes** — watching a steward NPC wander the base is what makes this a settlement and not a job queue.

If the body proves problematic (resource cost on the Paper server, frequent death, weird behavior), we can run the steward headless without losing functionality. **The body is the experiment**; the role is the architecture.

## Issue management (full table)

| Failure mode | Detection | Response |
|--------------|-----------|----------|
| Capability test FAIL with diagnosable cause | Worker's `kanban_complete` reports FAIL | Steward `triage_failures` cron creates `bug_report` for human; failed test card depends_on the bug |
| Capability test FAIL with no diagnosis | Worker can't pinpoint cause | Steward creates `bug_report` with "needs investigation" body; human-only |
| Same bug seen N times | Bug-report idempotency_key match | Steward increments hit counter as comment, doesn't dup |
| Human marks fix done | Commit SHA in bug card's done summary | `verify_human_done` cron picks up next tick, reruns the dependent test |
| Worker crash mid-task | Claim TTL expires | Reclaim → respawn next dispatcher tick (validated 1.4) |
| Mission infeasible (tools missing) | Worker recognizes via `mc` errors | `kanban_block` with reason; steward decides if it's a `bug_report` or just replans |
| Hallucinated child cards | `kanban_complete.created_cards` rejected | Worker retries without phantom IDs |
| Bot body crashes | `/health.connected=false` | Supervisor restarts body; current worker blocks; steward reissues affected card |
| Stale mark coordinates | Worker's `mc dig @mark` returns wrong block | Worker chats steward; steward verifies + updates; mission retried |
| Chest contents drift from catalog | Worker's `mc chest @mark` count differs from `inventory` | Worker comments delta; steward syncs canonical |
| Lost chest (broken) | `mc chest @mark` returns no container | Steward removes mark, spawns rebuild mission, alerts in chat |
| Capacity overflow | Worker can't deposit (chest full) | Worker chats steward; steward creates overflow build or alt-chest deposit |
| Cross-mission resource conflict | Two cards want same chest concurrently | Steward serializes via deps at card-creation time |
| Token blowout per mission | `--max-runtime` per card; per-worker turn limit | Dispatcher SIGTERMs, marks `timed_out`, retries up to `max-retries`, then auto-blocks |
| Steward body death | Mineflayer death event | Body respawns at default spawn; agent posts respawn comment in chat; cron tasks continue uninterrupted (role is body-independent) |
| Steward body disconnect | `/health.connected=false` for steward body only | Body-dependent cron tasks skip the tick; headless tasks (planner, triage) continue. Body reconnects automatically. |
| Steward attempting manual labor | `mc dig`/`mc fight`/`mc craft` from steward profile | SOUL prompt forbids it; optional body-side rejection of those actions for steward profile |
| Steward bad decomposition | Human inspects via dashboard | `kanban edit`, `block`, `reassign`, or replan |
| Skill prompt confuses agent | Worker comments confusion in card | Steward creates `skill_revision` for human |
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
- Bootstrap script `scripts/setup-landfolk-profiles.sh` — initially creates 2 profiles (gatherer + flint); flag-driven so we can grow the cast as capabilities pass
- `scripts/landfolk-bodies-only.sh` — initially launches 2 Mineflayer bodies (gatherer + flint); same flag-driven scaling
- Dispatcher patch: skip tasks assigned to `human` (no auto-spawn for those)
- `verify_fix` template implementation as a steward (or human-as-steward) cron task

### Custom metric registration (future)
- Goal engine in `bot/lib/goals/engine.js` to accept arbitrary metrics with `evaluate_fn` expression. Lower priority — retargeting existing metrics covers 90% of cases.

## Migration sequence (capability-driven)

The sequence walks the capability levels (L0–L8) with **two bots** (gatherer + flint). Each level becomes one or more capability_test cards. Bug reports surface naturally; humans fix them; tests re-run; the level advances. New roles, marks, logistics — they get added when a capability level demands them, not preemptively.

Each "sprint" is one or two work sessions. Parallel work where dependencies allow.

### Sprint 0 — Bootstrap (1 session)
**Goal: gatherer + flint bot bodies running; dispatcher healthy; first capability_test card runs end-to-end.**

1. `scripts/setup-landfolk-profiles.sh` creating two profiles (`gatherer` and `flint`) with proper `MC_API_URL`, `MC_USERNAME`, `terminal.env_passthrough`
2. `scripts/landfolk-bodies-only.sh` launching the two Mineflayer bodies (replaces today's `landfolk-control.sh`)
3. Dispatcher patch: skip tasks assigned to `human`
4. Smoke-test capability_test card: "L0.1 — gatherer reports `mc status` successfully"
5. Confirm `verify_fix` template works end-to-end with one synthetic bug

**Exits with:** baseline that mirrors 1.4 but for two characters and with the human-as-steward + `human` assignee in the loop.

### Sprint 1 — L0 + L1 capabilities (foundations + movement) (1–2 sessions)
**Goal: green light on connectivity and movement primitives for both bots.**

Capability tests:
- L0.1–0.4 — connectivity (status, health, inventory, marks API CRUD)
- L1.1–1.5 — movement (`goto`, `goto_near`, `follow`, `look_at`, `go_mark`)

Expected bug surface (each becomes a `bug_report` to me):
- 1.1's "stuck in hole at Y=62" pathfinder issue → anti-revisit memory or termination
- Repeated `goto` failing without progress → make `goto` exit with mined-style structured failure
- `mc nearby` token bloat → introduce `mc observe_lean`

### Sprint 2 — L2 + L3 (inventory + basic gather/craft) (1–2 sessions)
**Goal: agents can use inventory ops and basic crafting reliably.**

Capability tests:
- L2.1–2.4 — `mc inventory`, `equip`, `unequip`, item drops
- L3.1–3.5 — `mc dig` reliability, oak log → planks → sticks → wooden tools, crafting table interaction

Expected bug surface:
- `mc collect` silent failure (1.1, 1.3, 1.4) → either deprecate it or fix the return contract
- Crafting table proximity check rules — agent uncertainty
- `mc craft` semantics under inventory shortage (already a bug suspect)

### Sprint 3 — L4 (mining) (1–2 sessions)
**Goal: flint can mine stone/coal/iron with appropriate tools, navigate caves, recover from lava.**

Capability tests:
- L4.1–4.5 — surface stone, coal vein, iron ore, cave navigation, lava avoidance

Expected bug surface:
- Cave pathfinding regressions
- Tool durability handling under sustained mining
- Underground orientation (which way is up?)

### Sprint 4 — L5 (build) (1 session)
**Goal: gatherer (or flint) can place blocks reliably, including the "no solid neighbor" foundation case Mason solved in 1.4.**

Capability tests:
- L5.1–5.4 — single block place, place_facing variants, simple wall, foundation handling

Expected new functionality (likely `feature_request` cards):
- `mc place_facing` — direction-relative placement
- `mc place_against` — explicit "place against this face"

### Sprint 5 — Marks system minimum (1–2 sessions)
**Goal: introduce marks now that we have proven gameplay capabilities. Two bots reading from a curated catalog drives the first 2-bot coordination.**

1. Canonical marks YAML schema + reader/writer library
2. `POST /marks/replace` and `POST /marks/diff` endpoints
3. Hand-curated initial catalog (3–5 marks: `@base`, `@stone_chest`, `@food_chest`, `@quarry-east`)
4. Dispatcher hook to push marks pre-spawn
5. First 2-bot coordination test: gatherer mines logs at `@oak-NE`, deposits at `@food_chest` (placeholder); flint mines stone at `@quarry-east`, deposits at `@stone_chest`. Two parallel cards, no dependencies.

**Exits with:** marks system stable for two bots; co-evolution loop validated; bugs in marks API surface as `bug_report` cards.

### Sprint 6 — L6 (farming) + chest inventory tracking (2 sessions)
**Goal: gatherer can plant/harvest; chest inventories tracked.**

Capability tests:
- L6.1–6.4 — plant wheat, harvest at maturity, breed animals, food prep at furnace

Plus:
- `inventory` schema field on chest marks
- Worker comment template for deposit/withdraw deltas
- Audit cron task

### Sprint 7 — L7 (combat / survival) (1–2 sessions)
**Goal: agents engage hostile mobs sensibly, manage health, flee when outmatched.**

Capability tests:
- L7.1–7.4 — engage zombie at full HP with sword, flee from creeper at low HP, regen waiting, equip sword vs unarmed combat

Likely new functionality:
- `mc engage` / `mc disengage` semantics
- Threat-aware pathfinding

### Sprint 8 — Steward profile + first logistics (2 sessions)
**Goal: replace human-as-steward with a Hermes profile. Add the first logistics planner cron task.**

1. Steward profile created with custom `steward-role.json` goal-preset and SOUL prompt
2. Mason added (port 3003) so the steward has someone to assign to (besides gatherer/flint)
3. Steward worker auto-runs `respond_chat`, `audit_chests`, `triage_failures`, and (basic) `logistics_planner` cron tasks
4. First end-to-end un-prompted intervention: `@stone_chest` fills → steward spawns rebalance or build-overflow card → mason or flint executes

### Sprint 9 — L8 (full logistics) and cast expansion (2 sessions)
**Goal: full multi-bot supply chain operational; barley joins; treasury operational.**

1. Barley (port 3004) joins; first farm operation
2. Treasury chest near base (relocated to @tower if/when built); first `treasury_dispense` mission
3. Mark expiry / verification cycles running
4. Full L8 capability tests: gatherer→deposit→withdraw→consume chains across multiple chests

### Sprint 10+ — Dashboard and polish
1. Custom dashboard (separate web app), reading from kanban DB + marks YAML + bot APIs
2. Anti-revisit pathfinder memory
3. Custom metric registration in goal engine
4. Whatever else the bug pile has surfaced

## Open questions / risks

- **`worker_context` size budget** — pre-injected parent comments are great but could bloat at scale. Need to cap or summarize at N parents deep.
- **Steward as single-point-of-orchestration** — if the steward profile breaks, the team loses planning. Plan: low-cadence backup of canonical YAML; steward worker is restart-tolerant by design.
- **Chat parsing brittleness** — `@steward` mentions parsed by worker LLM. May need a structured chat protocol (`/cmd_arg` style) or rely on the LLM's natural-language tolerance.
- **Token budget at scale** — five profiles × dozens of missions/day × deepseek-v4-flash. Phase 2 should set a hard rail (e.g., $5/day initial); steward can deprioritize missions when approaching.
- **Mineflayer body resource cost** — five bots in one Paper server, each with pathfinding + observation. Server-side load needs monitoring; may need to throttle observation polling.
- **Marks YAML race condition** — concurrent steward workers updating the file. Need a lock file or atomic write pattern (already common solution: write to .tmp, rename).
- **Mission-template debugging UX** — when a card body comes from a template, errors at runtime point at the template, not the planner that picked it. Logs need template-id traceability.

## Success criteria — capability-driven, not single-shot

Because Phase 2 is a co-evolution loop, "completion" isn't one big run — it's a green capability matrix. Each level is "passing" when its capability_test cards complete cleanly twice in a row with no new bug_reports.

### Per-sprint exit gates

| Sprint | Exit gate |
|--------|-----------|
| 0 | Two bots online; one synthetic capability_test runs end-to-end with the human-as-steward + `human` assignee loop |
| 1 | L0 + L1 green for both bots; ≤2 open bugs |
| 2 | L2 + L3 green; basic crafting reliable |
| 3 | L4 green for flint; cave nav not blocking |
| 4 | L5 green; foundation handling encoded as a primitive |
| 5 | Marks system live; 2-bot parallel mission with mark refs runs |
| 6 | L6 green; chest inventory tracking accurate to ±5% |
| 7 | L7 green; agents survive a night |
| 8 | Steward profile online; first un-prompted logistics intervention fires and completes |
| 9 | Full team (4 bots) coordinating on a 24h run; treasury operational |

### Phase-2 "shippable" definition

A 24-hour live run with the **expanded cast** (gatherer, flint, mason, barley, steward) where:
- All 4 character bodies + steward stay connected ≥95% of the time.
- Human posts ≥3 coarse intents (e.g., "we need food", "build a watchtower at @perimeter-N", "rebalance the iron chests") → all complete via kanban chains without manual orchestration.
- Steward maintains `last_verified` on all marks within their `expires_after_h` budgets.
- Chest inventories in catalog stay within ±5% of ground-truth (verified by spot audit).
- Token spend stays under $5/day.
- At least one logistics planner intervention (rebalance / overflow / scout) fires unprompted and resolves successfully.
- Capability matrix shows L0–L8 all green.

If we hit those, Phase 2 is shippable as the new normal for the Landfolk world.

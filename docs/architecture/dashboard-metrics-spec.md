# Dashboard spec: colony & fleet overview

Status: **design exploration** (2026-06-06). Operator **command center** for the landfolk fleet: **colony** (buildings, farms, stock, burn), **productivity** (cards, time, throughput), **agents & handoffs** (profile effectiveness, desk vs in-world, lane latency), **intelligence** (data gathered, recall, compaction), **strategy** (plans, epics, goals, budgets), **hotspots** (bind deferrals, blocks, serial pressure), and **LLM spend** — with drill-down to kanban/lanes when something is wrong.

Related: [`target.md`](target.md) (agents vs bots), [`hermes-agents.md`](hermes-agents.md) (profiles), [`epic-lifecycle.md`](epic-lifecycle.md) (handoff, `card_kind`), [`board-dynamics.md`](board-dynamics.md) (mutex, dispatcher), [`example-wheat-farm-walkthrough.md`](example-wheat-farm-walkthrough.md) (latency overhead), [`workspaces.md`](workspaces.md), [`data-api.md`](data-api.md), [`impact.md`](impact.md).

**Wireframes:** interactive region-level mockups — open [`dashboard-wireframes.html`](dashboard-wireframes.html) in a browser (sidebar switches screens; in-page links mirror drill-downs).

**Today:** [`dashboard/`](../../dashboard/) is **world-first** (map, FPV, kanban by status, per-player detail) plus header **OpenRouter** balance/usage from [`dashboard/lib/openrouter.js`](../../dashboard/lib/openrouter.js). Goals appear on agent select. Assignee often equals legacy bot name — not yet **agent profile** effectiveness.

**Target:** default view = **Colony overview** — “Are we producing enough, are agents and handoffs healthy, where is time going (desk vs `mc`), and are bots idle or stuck?”

---

## Mental model

Layer stack (top = intent, bottom = overhead): **Strategy** → **Agents & handoff** → **Productivity** → **Hotspots** → **Colony** → **Intelligence** → **LLM economics**. Visual: [`dashboard-wireframes.html#model`](dashboard-wireframes.html#model).

**Agent** = Hermes profile on `assignee` (`navigator`, `miner`, `planner`, …). **Bot** = body on `metadata.bot` (`pip`, `mox`, …). Dashboard productivity must **never collapse** assignee into bot name — one bot lane runs many agent phases serially ([`target.md`](target.md)).

**Desk work** = cards with `metadata.card_kind` ∈ `plan` · `research` · `review` · `clarify` (and bot-less `epic` setup) — no `metadata.bot`, no `mc`. **In-world** = `card_kind=execute` (and maint/urgent with bot set) — spawn inject + `mc` ([`epic-lifecycle.md`](epic-lifecycle.md) § Card modes).

**Handoff** = structured metadata on `kanban_complete` (`exit_pos`, `work_at_mark`, `inv_summary`, …). Effectiveness = next card starts without `needs_nav` / `world_state_mismatch` / missing handoff ([`example-wheat-farm-walkthrough.md`](example-wheat-farm-walkthrough.md) § Handoff chain).

**Colony** = durable world + designed assets. **Burn rate** = items and attention (food, fuel, tools, repair, **inference dollars**). **Production** = items and progress added (crops, ore, built blocks, completed epics, recall/playbook knowledge).

---

## Metric catalog (overview-worthy)

### Colony & economy (unchanged core)

| Domain | Metric | Source (today → target) |
|--------|--------|-------------------------|
| **Stock** | Key items by chest/mark rollup | chest snapshots → `production/generated/stockpiles.json` |
| **Stock** | Deficits vs goals | `data/goals-*.json`, goals engine |
| **Production** | Harvest/plant/smelt **deltas** per 24h | Card `inv_delta` on complete; compaction |
| **Consumption / burn** | Food drain, LLM $/day | `/status`, OpenRouter (fleet payload) |
| **Strategy** | Active epics, budgets, goal presets | kanban epic, workspace ingest |

### Agents & effectiveness (by `assignee` profile)

| Domain | Metric | Source |
|--------|--------|--------|
| **Activity** | Cards completed / 24h **by assignee** (not bot) | Kanban `task_runs`, `assignee` |
| **Activity** | Running workers **by assignee** + optional `metadata.bot` | `GET …/kanban/workers/active` |
| **Effectiveness** | **Success rate** per profile: `done` vs `blocked`/`archived` without recovery | Kanban status + block reasons |
| **Effectiveness** | **$/card** and **median LLM turns/card** by assignee | OpenRouter attribution + worker logs |
| **Effectiveness** | **Pilot deltas** vs baseline: turns, tokens at complete, spawn→first-`mc` | Instrumentation ([`target.md`](target.md) success metrics) |
| **Scope** | **Median wall time** per card by assignee | `started_at` → `completed_at` |
| **Scope** | **In-world wall time** (execute only) vs **desk wall time** | Filter `metadata.card_kind` |

| Profile tier | What “good” looks like on overview |
|--------------|-----------------------------------|
| **Execution** (`navigator`, `miner`, `builder`, `crafter`, `farmer`, `soldier`) | High completion rate; low `needs_nav` / `OUT_OF_RANGE` blocks; spawn→first-`mc` stable |
| **Coordination** (`planner`, `overseer`) | Few clarify loops per epic; time-to-first-execute-child after plan card |
| **Dispatcher** (script or profile) | Low defer count; rebind latency when bot `down` |

### Desk vs in-world effort

| Domain | Metric | Source |
|--------|--------|--------|
| **Split** | **Card-hours (or count) 24h**: desk vs execute vs maint | `card_kind` + title tags `[MAINT]` |
| **Split** | **LLM $** desk vs execute (when attributed) | Session/run id → profile + kind |
| **Split** | **Epic timeline**: plan/research/review wall vs execute wall | Children of epic id, group by kind |
| **Quality** | Desk cards per epic (lower is better once DSL mature) | Epic child counts by `card_kind` |

Rule: show **both** absolute hours and **% of fleet attention** so operators see whether the fleet is “thinking” vs “acting”.

### Handoff & phase transitions

| Domain | Metric | Source |
|--------|--------|--------|
| **Completeness** | % completes with `exit_pos` (and `work_at_mark` when `work_at` set) | Complete metadata / handoff JSON |
| **Friction** | **`needs_nav:*`** blocks per 24h; time from block → nav leg done → unblock | Block reason prefix; leg cards `auto_leg=true` |
| **Auto-legs** | Nav legs **inserted** per 24h; median **leg duration** | Kanban create from hook; `assignee=navigator`, metadata |
| **Gap time** | **Complete → next claim** on same `metadata.bot` (mutex gap) | Adjacent task_runs per bot lane |
| **Mismatch** | `world_state_mismatch:*` → repair chain length | Block + repair children ([`board-dynamics.md`](board-dynamics.md)) |
| **Epic chain** | Assignee **sequence** on one bot (sankey or strip) | Epic members ordered by `depends-on` + timestamps |

### Bot bodies: latency & idle

| Domain | Metric | Source |
|--------|--------|--------|
| **Utilization** | % wall time **busy** (running card) per `metadata.bot` | Fleet-state + active workers |
| **Idle** | % wall time **up but idle** (no running card, not `down`) | Fleet snapshot tick ([`data-api.md`](data-api.md) `fleet-state`) |
| **Latency** | **p50/p90 spawn→first-`mc`** per assignee | Worker instrumentation |
| **Latency** | **p50 gap** between card complete and next claim on lane | Per-bot task_run deltas |
| **Latency** | **Dispatcher tick lag**: time ready card waits with `metadata.bot` set but not running | Ready + bound vs `running` timestamps |
| **Down** | Bot `down` duration / 24h; cards **parked** `mutex_park:<bot>` | Roster health, gate-check |

**Serial bottleneck:** each bot is one mutex — overview should show **lane pressure** (ready queue depth per bot) not just “fleet 3/4 online”.

### Hotspots & bottlenecks

Surface **actionable** congestion — ranked list on overview when any threshold fires.

| Hotspot | Signal | Typical cause |
|---------|--------|----------------|
| **Bind defer** | Dispatcher comment / `dispatch-log` “defer” without `metadata.bot` | All bots `busy` or `down`; intent backlog (`needs_bot`) |
| **Parked mutex** | Ready cards with `mutex_park:<bot>` | Second card ready while first runs — normal; **deep queue** is hotspot |
| **Blocked queue** | Count by **reason prefix** (`needs_nav`, `world_state_mismatch`, `dead_mid_card`) | Handoff, preflight, death recovery |
| **Maint preempt** | `[MAINT]` inserts / 24h per bot | Thresholds firing often — food/tools/HP |
| **URGENT** | Preempt count; time non-urgent card lost | Combat / operator interrupt |
| **Epic stall** | Epic open; no execute child `running`; oldest ready child age | Planner/dispatcher/review gate |
| **LLM loop** | Turns/card >> p90 for assignee | Bundle or model issue |
| **Desk pile-up** | Many `plan`/`clarify` ready, zero execute progress | Planning loop |

| Domain | Metric | Source |
|--------|--------|--------|
| **Hotspots** | Top **3 active** hotspot types (24h) with deep link | Rollup job + dispatch-log |
| **Hotspots** | **Intent queue depth** (`needs_bot` ready cards) | Kanban filter |
| **Hotspots** | **Rebind events** / 24h | WS + dispatch-log |

### Intelligence & LLM (retained)

| Domain | Metric | Source |
|--------|--------|--------|
| **Intelligence** | Recall events / 24h, worksites, compaction freshness | Host recall, `*/generated/` |
| **LLM** | OpenRouter balance, $/day, $/card, **by assignee** | Fleet API + attribution |

Only surface metrics that **change decisions** on the overview; detail lives in sub-views.

---

## Information architecture

Nav tree and drill-down paths: [`dashboard-wireframes.html#ia`](dashboard-wireframes.html#ia). Default route **Colony overview**; **World / Map** stays a legacy alternate mode.

**Primary drill-down paths**

- Hotspot row → **Operations** (filtered lane / block reason).
- Agent profile tile → **Agent detail** (cards, handoffs, $, turns).
- Epic strip → **Strategy** epic view + dependency DAG ([`board-dynamics.md`](board-dynamics.md)).

---

## UI wireframes (HTML)

Region-level layouts live in **[`dashboard-wireframes.html`](dashboard-wireframes.html)** — sidebar or hash (`#overview`, `#agents`, …). In-page links mirror drill-downs. The HTML is **component/region** level: dashed chrome, labeled blocks, a few example values, italic placeholders — not production layout.

| Screen | Hash | Regions (summary) | Data |
|--------|------|-------------------|------|
| Colony overview | `#overview` | header, hotspot strip, assets, effort mix, strategy snapshot, agent effectiveness, bot lanes, handoff summary | kanban, fleet-state, handoff metadata |
| Agents | `#agents` | execution + coordination profiles, desk vs in-world | `assignee`, `card_kind`, workers API, OpenRouter |
| Handoffs | `#handoffs` | epic phase strip, completeness, friction, auto-legs, lane gaps, recent handoffs | complete JSON, deps, `auto_leg` ([`epic-lifecycle.md`](epic-lifecycle.md)) |
| Hotspots | `#hotspots` | active now, 24h rank, block histogram | dispatch-log, fleet-state, kanban |
| Productivity | `#productivity` | throughput, time/overhead, utilization, lane depth, compact swimlanes | task_runs, fleet-state |
| Economy | `#economy` | burn, stock by anchor, production log | chest snapshots, goals, inv_delta |
| Strategy | `#strategy` | epics, plans, goals, budgets | kanban epic, workspace ingest |
| Intelligence | `#intelligence` | recall, worksites, compaction, freshness | [`data-api.md`](data-api.md), `*/generated/` |
| LLM costs | `#llm` | OpenRouter headline, trend, attribution, model mix | fleet payload → per-assignee target |
| Operations | `#operations` | swimlanes, WS pulse, card drawer, map alt | debug / legacy dashboard |
| Mental model | `#model` | layer stack (reference) | — |
| Info architecture | `#ia` | nav tree + drill-down paths | — |

**Overview rule:** headline numbers from existing stores; show **—** when missing. **LLM today:** aggregate OpenRouter on fleet payload; **target:** session/run attribution for **$/epic** and **$/assignee**.

---

## Colony assets registry (concept)

Unchanged — logical index linking marks ↔ epics ↔ playbooks. Wheat walkthrough: [`example-wheat-farm-walkthrough.md`](example-wheat-farm-walkthrough.md).

---

## Data plumbing (summary)

| Layer | Role in dashboard |
|-------|-------------------|
| Bot HTTP | Live vitals, inv, positions for idle/busy |
| Kanban + events | Assignee, `card_kind`, `metadata.bot`, handoff on complete, block reasons |
| Hermes workers API | Active worker assignee + card id |
| Host API | Fleet-state, recall, dispatch log ([`data-api.md`](data-api.md)) |
| Git workspace ingest | Plans, budgets, goals, playbooks |
| Git workspace generated | Stockpiles, worksites, trends, colony-overview |
| OpenRouter API | LLM burn |
| Pilot instrumentation | spawn→first-`mc`, turn/token at complete |

**Colony rollup** job refreshes `operations/generated/colony-overview.json` and enriches **`hourly.jsonl`** with agent and hotspot fields.

**Key derivations (no new agents required for MVP):**

1. **Desk vs execute** — SQL/filter on `metadata.card_kind` and `[MAINT]` title prefix.
2. **Lane gap** — sort `task_runs` by `metadata.bot`, `completed_at`; delta to next `started_at` same bot.
3. **Handoff completeness** — parse complete payload for `exit_pos` / required keys per assignee (bundle contract).
4. **Hotspot rank** — threshold rules on queue depth, gap p90, intent `needs_bot` count, epic stale ready child.

---

## Trends (simple implementation)

Extend tier-1 **`operations/generated/trends/hourly.jsonl`**:

```json
{
  "ts_hour": "2026-06-06T12:00:00Z",
  "cards_completed": 4,
  "cards_completed_by_assignee": { "navigator": 1, "builder": 2, "planner": 1 },
  "cards_by_kind": { "execute": 3, "desk": 1, "maint": 0 },
  "handoff_exit_pos_rate": 1.0,
  "auto_legs_inserted": 1,
  "needs_nav_blocks": 0,
  "bind_defers": 0,
  "bot_busy_fraction": { "mox": 0.78, "pip": 0.45, "zee": 0.91 },
  "lane_gap_p50_sec": { "mox": 68, "zee": 120 },
  "intent_queue_depth": 2,
  "llm_usage_usd_cumulative_day": 2.40,
  "stock_totals": { "wheat": 64, "iron": 18 }
}
```

Tiers 0–2 unchanged ([`data-api.md`](data-api.md) optional `GET …/operations/metrics/rollup`).

---

## Implementation phases

| Phase | Deliverable |
|-------|-------------|
| **1** | Colony home + stock + OpenRouter + goals rollup |
| **2** | Epic progress + productivity by **assignee** (not legacy assignee=bot only) |
| **3** | Economy: inv_delta production log |
| **4** | **Agents** sub-view: desk vs execute split from `card_kind` |
| **5** | **Bot lanes**: busy/idle from fleet-state; ready queue depth |
| **6** | **Handoffs**: exit_pos rate, needs_nav blocks, leg count (when metadata exists) |
| **7** | **Hotspots** strip + sub-view (dispatch-log + thresholds) |
| **8** | LLM attribution by profile + kind |
| **9** | Pilot metrics: spawn→first-`mc`, turns/card on home strip |
| **10** | Operations swimlanes + epic phase strip (DAG collapse) |

Keep **World/Map** as alternate route.

---

## Open questions

1. **Handoff schema enforcement** — which keys are required per assignee in complete metadata ([`impact.md`](impact.md)).
2. **Spawn→first-`mc`** — log in worker vs infer from first `mc` HTTP proxy (if added).
3. **Legacy assignee=bot** — dashboard dual labels until migration ([`impact.md`](impact.md)).
4. **Hotspot thresholds** — operator-tunable vs fixed p90 per fleet size.
5. **LLM attribution** — Hermes billing hooks vs estimate from card count × average.
6. **Single rollup file vs live compose** — overview latency vs freshness.

---

## Related

- [`dashboard-wireframes.html`](dashboard-wireframes.html) — clickable screen mockups
- [`example-wheat-farm-walkthrough.md`](example-wheat-farm-walkthrough.md) — desk vs execute timeline, handoff JSON, latency table
- [`hermes-agents.md`](hermes-agents.md) — profile matrix and coordination agents
- [`board-dynamics.md`](board-dynamics.md) — mutex, intent queue, dispatch log
- [`dashboard/server.js`](../../dashboard/server.js) — `/api/fleet` today
- [`impact.md`](impact.md) — migration touchpoints

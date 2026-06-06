# Dashboard spec: colony & fleet overview

Status: **design exploration** (2026-06-05). Operator **command center** for the landfolk fleet: **colony** (buildings, farms, stock, burn), **productivity** (cards, time, throughput), **intelligence** (data gathered, recall, compaction), **strategy** (plans, epics, goals, budgets), and **LLM spend** — with drill-down to kanban/lanes when something is wrong.

Related: [`workspaces.md`](workspaces.md) (production/, infra/, operations/), [`data-api.md`](data-api.md), [`epic-lifecycle.md`](epic-lifecycle.md), [`example-wheat-farm-walkthrough.md`](example-wheat-farm-walkthrough.md), [`impact.md`](impact.md).

**Today:** [`dashboard/`](../../dashboard/) is **world-first** (map, FPV, kanban by status, per-player detail) plus header **OpenRouter** balance/usage from [`dashboard/lib/openrouter.js`](../../dashboard/lib/openrouter.js). Goals appear on agent select. Not a colony balance sheet.

**Target:** default view = **Colony overview** — “Are we producing enough, spending too much (items + LLM), executing the plan, and learning from the world?”

---

## Mental model

```
┌─────────────────────────────────────────────────────────────────┐
│  STRATEGY          epics, ingest plans/budgets, goals presets    │
│  (intent)          workspace: infra/, production/ingest/       │
├─────────────────────────────────────────────────────────────────┤
│  PRODUCTIVITY      kanban throughput, time/card, blocks, bots   │
│  (execution)       assignee phases, dispatcher, maint           │
├─────────────────────────────────────────────────────────────────┤
│  COLONY            structures, farms, chests, regions, marks    │
│  (assets)          stockpiles, consumption/burn, capacity       │
├─────────────────────────────────────────────────────────────────┤
│  INTELLIGENCE      recall stream, worksites, POIs, playbooks     │
│  (data gathered)   compaction cadence, epic judgments            │
├─────────────────────────────────────────────────────────────────┤
│  LLM ECONOMICS     OpenRouter $/day, $/card, $/epic, by profile  │
│  (overhead)        tokens/turn (pilot), model mix                │
└─────────────────────────────────────────────────────────────────┘
```

**Colony** = durable world + designed assets (not “one bot’s inventory” alone). **Burn rate** = items and attention consumed to stay alive and on-plan (food, fuel, tools, repair, **and** inference dollars). **Production** = items and progress added (crops, ore, built blocks, completed epics, new recall/playbook knowledge).

---

## Metric catalog (overview-worthy)

| Domain | Metric | Source (today → target) |
|--------|--------|-------------------------|
| **Stock** | Key items by chest/mark rollup (wheat, iron, stone, food) | `chest-snapshots-*.json` → `production/generated/stockpiles.json` + live bot inv |
| **Stock** | Deficits vs goals (`food_score`, gaps) | `data/goals-*.json`, goals engine ([`bot/lib/goals/engine.js`](../../bot/lib/goals/engine.js)) |
| **Production** | Harvest/plant/smelt **deltas** per 24h | Card `inv_delta` on complete; compaction |
| **Production** | Farm **capacity** (grid, crop type, stage) | Playbook + handoff + optional block survey |
| **Consumption / burn** | Food drain (fleet aggregate / per bot) | `/status`, goal time-in-deficit |
| **Consumption / burn** | Fuel, tool durability trend | Card metadata, maint card rate |
| **Consumption / burn** | **LLM $/day, $/month** | OpenRouter credits API (already in `/api/fleet`) |
| **Consumption / burn** | **$/completed card**, **$/epic** (derived) | Kanban completes × allocate usage (needs attribution) |
| **Productivity** | Cards completed / 24h, by assignee | Kanban `task_runs`, completed_at |
| **Productivity** | **Median wall time per card** (by assignee tag) | `started_at` → `completed_at` |
| **Productivity** | **Spawn overhead** (spawn → first `mc`) | Pilot instrumentation |
| **Productivity** | Block rate, repair inserts, URGENT count | Kanban events + dispatcher log |
| **Productivity** | Bot utilization (% time `busy` on mutex) | Fleet-state + running cards |
| **Strategy** | Active **epics**, execute done/total | `scripts/kanban epic` |
| **Strategy** | Open **budgets** vs spent (build missions) | `production/ingest/budgets/*.yaml` + inv deltas |
| **Strategy** | Goal preset satisfaction rollup | `production/ingest/goals/presets/` |
| **Strategy** | Planned structures (not yet built) | `infra/ingest/plans/` |
| **Intelligence** | Recall events / 24h (by subject+type) | Host `recall/events` |
| **Intelligence** | **Worksites / POI** cluster count | `geo/generated/worksites.json`, hints API |
| **Intelligence** | Playbook / plan **last updated** | Git ingest mtime or workspace index |
| **Intelligence** | Post-mortems closed this week | `operations/ingest/post-mortems/` |
| **Colony map-lite** | Anchors: base, farms, mines, chests | Marks + `metadata.places` on epics |

Only surface metrics that **change decisions** on the overview; detail lives in sub-views.

---

## Information architecture

```
Colony overview (default)
├── Economy      stock, production vs consumption, burn, deficits
├── Productivity time/card, throughput, utilization, blocks
├── Strategy     epics, plans, budgets, goals
├── Intelligence recall volume, compaction, catalog freshness
├── LLM costs    OpenRouter + (future) per-profile attribution
└── Operations*  bot lanes, activity, card drawer (*when debugging)

World / Map      legacy spatial mode (establish, debug nav)
```

---

## Wireframe: Colony overview (home)

Single screen: **health strip** + four quadrants + **burn/production headline**.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Landfolk Colony          world ▾   MC day 1243    LLM today $2.40 / mo $68 │
│  OpenRouter bal $42   ·   fleet 3/4 online   ·   1 epic blocked              │
├───────────────────────────────┬──────────────────────────────────────────────┤
│  COLONY ASSETS                │  FLOW (24h)                                  │
│  Base +3 structures           │  Produced  + wheat 48  iron 16  planks 120 │
│  Farms: 1 active (field_s)    │  Consumed  − food 32   coal 8    LLM $2.40  │
│  Stockpiles (rolled up)       │  Net food  +16 ✓   iron +8 ✓   burn stable  │
│   wheat ████████░░  chest_food│                                              │
│   iron  ████░░░░░░  chest_iron│  Deficits: none critical                     │
│  [Economy detail →]           │  [Productivity detail →]                     │
├───────────────────────────────┼──────────────────────────────────────────────┤
│  STRATEGY                     │  INTELLIGENCE                                │
│  Epics open: 2                │  Recall events 24h: 84                       │
│   [FARM] wheat 3/4 ████░      │   resource 62 · blocked 4 · note 18          │
│   [MINE] iron   1/5 ██░░░      │  Worksites indexed: 12 · POIs: 8             │
│  Plans in flight: road-bluff  │  Playbooks touched: 2 (wheat, nav)           │
│  Goals: food ok · iron low    │  Last compact: 6h ago                        │
│  [Strategy detail →]          │  [Intelligence detail →]                     │
├───────────────────────────────┴──────────────────────────────────────────────┤
│  PRODUCTIVITY SNAPSHOT     cards done 24h: 14   median phase: 4m  blocks: 2  │
│  $/card (est): $0.17       mox busy 78%   zee idle                     │
│  [Operations: lanes & activity →]                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Headline numbers** should be computable from existing + target stores; show **—** when data missing (honest gaps).

---

## Wireframe: Economy sub-view

Colony **balance sheet** — not a chest UI dump.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Colony    Economy     period: [24h ▾] [7d] [since genesis]                │
├──────────────────────────────────────────────────────────────────────────────┤
│  BURN RATE (colony)                                                          │
│   Food equivalent / day     48 units    ↑ vs 7d avg                          │
│   Smelt fuel (coal/char)    12 / day                                         │
│   Tool replacements         3 maint cards / 7d                               │
│   LLM inference             $2.40 / day   $0.17 / card completed             │
├──────────────────────────────────────────────────────────────────────────────┤
│  STOCK BY ANCHOR          target (goal)    now      trend                      │
│   chest_food              food_score ok    wheat 64  ↑                       │
│   chest_iron              iron ≥ 32        iron 18   ↓ deficit               │
│   field_south (farm)      9×9 wheat plan     growing  —                        │
├──────────────────────────────────────────────────────────────────────────────┤
│  PRODUCTION LOG (compacted)   inv_delta sums from card completes + deposits    │
│  [table: time, epic, assignee, item, +/- qty]                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Data:** chest snapshots, goals, kanban complete metadata, OpenRouter daily usage, optional `production/generated/deficits.jsonl`.

---

## Wireframe: Productivity sub-view

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Colony    Productivity                                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│  THROUGHPUT        completed: 14/24h   running: 1   blocked: 1   URGENT: 0 │
│  TIME PER TASK       p50 wall clock by assignee:                              │
│                      navigator 3m │ builder 12m │ farmer 8m │ crafter 2m     │
│  OVERHEAD (pilot)    p50 spawn→first-mc: 22s   p50 LLM turns/card: 8         │
│  BOT UTILIZATION     mox ████████░░ 78%   zee ██░░░░░░ 20%             │
├──────────────────────────────────────────────────────────────────────────────┤
│  BOT LANES (compact)   Mox ▶ farmer t_x003  │  Zee idle               │
│  [Expand operations view →]                                                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Data:** kanban DB `task_runs`, Hermes workers API, future worker-reported turn counts.

---

## Wireframe: Strategy sub-view

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Colony    Strategy                                                        │
├──────────────────────────────────────────────────────────────────────────────┤
│  EPICS (open)              PLANS (ingest)           GOALS (rollup)           │
│  t_e001 FARM wheat 3/4     road-bluff-v4.yaml       food ████████ ok         │
│  t_e002 MINE iron  1/5     guard-tower (draft)      iron ████░░░░ gap 14     │
│  BUDGETS                   PRESETS                                        │
│  road-bluff: stone 80%     establish-phase-2 ✓ 3/5                           │
│  spent vs planned from     next: winter-stock (not started)                  │
│  production/ingest/budgets                                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Data:** epic scan, workspace file index (or git log), goals JSON, budget YAML vs compaction.

---

## Wireframe: Intelligence sub-view

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Colony    Intelligence — data gathered                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│  RECALL (live stream)     last 24h: 84 events   top subjects: iron_ore, wheat│
│  HINTS / WORKSITES        12 clusters · last new: mine_nw (2d ago)           │
│  COMPACTION               geo worksites · stockpiles · goal-metrics (cadence)│
│  KNOWLEDGE ARTIFACTS      playbooks 2 · post-mortems 1 this week · judgments │
│  FRESHNESS                stockpiles.json 6h · worksites.json 2d             │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Data:** [`data-api.md`](data-api.md) recall + hints; `*/generated/`; epic-judgments log.

---

## Wireframe: LLM economics sub-view

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Colony    LLM costs                                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│  OpenRouter    balance $42.00   limit —   usage today $2.40   month $68.00    │
│  TREND         [sparkline 30d daily usage from usage_daily_usd]               │
│  ATTRIBUTION (target)    by assignee profile / by card_kind                    │
│    planner desk     $0.40/24h   │  navigator execute  $0.90                   │
│    farmer execute   $0.55       │  overseer review    $0.12                   │
│  EFFICIENCY      $/card vs median turns — flag outliers (repair loops)       │
├──────────────────────────────────────────────────────────────────────────────┤
│  Model mix (from agent-models / profile config)   mimo 60% · flash 30% …     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Today:** aggregate credits in fleet payload. **Target:** correlate Hermes session/run ids with OpenRouter usage (plugin or log scrape) for **$/epic** and **$/assignee**.

---

## Colony assets registry (concept)

Logical index the overview queries (materialized JSON or host API):

| Asset type | Examples | Primary keys |
|------------|----------|--------------|
| **Structure** | base, tower, road segment | mark / region / plan id |
| **Farm** | field_south | mark, playbook, epic link |
| **Stockpile** | chest_food, chest_iron | mark, snapshot |
| **Worksite** | mine_nw | recall cluster / generated worksite |
| **Plan** | road-bluff-v4 | infra ingest path + budget |

Wheat walkthrough: after epic, **Colony assets** gains **Farm field_south** (9×9), **Stockpile chest_food** delta, **Playbook** revision — visible on overview without opening kanban.

---

## Data plumbing (summary)

| Layer | Role in dashboard |
|-------|-------------------|
| Bot HTTP | Live vitals, inv, chest scans |
| Kanban + events | Productivity, attribution window, epic progress |
| Host API | Fleet-state, recall tail, hints, dispatch log |
| Git workspace ingest | Plans, budgets, goals, playbooks (index + freshness) |
| Git workspace generated | Stockpiles, worksites, deficits, goal-metrics log, **hourly trends**, colony-overview snapshot |
| OpenRouter API | LLM burn (existing) |
| Card handoff / inv_delta | Production log lines |

New **colony rollup** job (dispatcher or `[COMPACT] ops` card): refresh overview JSON every N minutes — optional cache `operations/generated/colony-overview.json` ([`workspaces.md`](workspaces.md)).

---

## Trends (simple implementation)

Trends = **compare now vs past buckets** without a separate time-series database. Use three tiers; stop when good enough.

| Tier | What | Writer | Reader |
|------|------|--------|--------|
| **0 — Live delta** | “vs 24h ago” from two queries | none extra | Dashboard compares `since=` tails (recall, kanban completes) |
| **1 — Append JSONL** | One row per hour per fleet | Dashboard server **or** dispatcher tick (idempotent hour key) | Dashboard tail last 24–168 lines for sparklines |
| **2 — Host API** | Same buckets exposed read-only | Optional mirror of tier 1 | `GET …/operations/metrics/rollup` ([`data-api.md`](data-api.md)) |

**Canonical file (tier 1):** `operations/generated/trends/hourly.jsonl` — one JSON object per line:

```json
{
  "ts_hour": "2026-06-05T12:00:00Z",
  "cards_completed": 4,
  "cards_blocked": 1,
  "recall_events": 22,
  "llm_usage_usd_cumulative_day": 2.40,
  "stock_totals": { "wheat": 64, "iron": 18 },
  "goals_satisfied": { "food_score": true, "iron_score": false }
}
```

**How to fill it (no new agents):**

1. On each dashboard poll (or once per clock hour), compute counters from **sources we already have**: kanban DB `completed_at`, recall `GET events?since=`, `/api/fleet` openrouter + chest snapshots, goals files.
2. If `ts_hour` for this hour exists, **PATCH replace** that line (rewrite file or SQLite sidecar — lean: rewrite last line only in memory, flush hourly).
3. **Do not** store per-card time series in the API; derive productivity trends from kanban on read or in the hourly bucket.

**Existing series that already trend:**

- `production/generated/deficits.jsonl` — deficit episodes  
- `production/generated/goal-metrics-log.jsonl` — goal samples (compaction)  
- `operations/generated/dispatch-log.jsonl` — dispatch/leg inserts  
- OpenRouter `usage_daily_usd` / `usage_monthly_usd` on fleet payload  

**UI:** sparkline = last N hourly buckets; “↑ vs 7d avg” = mean of JSONL field / current.

Avoid: Prometheus, separate metrics DB, or pushing trends into recall events.

---

## Implementation phases

| Phase | Deliverable |
|-------|-------------|
| **1** | Colony home layout + OpenRouter + goals rollup + stock from chest snapshots |
| **2** | Epic progress + productivity (median time/card from kanban DB) |
| **3** | Economy: inv_delta production log from complete metadata |
| **4** | Intelligence: recall counts + generated file freshness |
| **5** | LLM attribution (profile/card) + burn rate line on home |
| **6** | Colony assets index linking marks ↔ epics ↔ playbooks |
| **7** | Operations drill-down (lanes, activity) linked from productivity strip |

Keep **World/Map** as alternate route; do not block colony view on map tiles.

---

## Open questions

1. **Single rollup file vs live compose** — overview latency vs freshness.
2. **LLM attribution** — Hermes billing hooks vs estimate from card count × average.
3. **Colony burn without double-count** — bot food vs chest food vs farm output semantics.
4. **Historical retention** — how long to keep 24h/7d rollups for sparklines.
5. **Operator targets** — who sets goal presets and budget “planned” numbers (overseer vs operator).

---

## Related

- [`example-wheat-farm-walkthrough.md`](example-wheat-farm-walkthrough.md) — what should appear in assets + productivity after one epic
- [`dashboard/server.js`](../../dashboard/server.js) — `/api/fleet` (openrouter block)
- [`impact.md`](impact.md) — dashboard evolution note

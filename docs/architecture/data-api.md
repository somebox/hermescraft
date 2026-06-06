# Host data API (recall + operations)

Status: **design exploration** (2026-06-05, revised for stream-first recall). Companion to [`workspaces.md`](workspaces.md). Defines the host-side API between bot HTTP listeners and Hermes agent workers.

**Primary job:** let the fleet **report** observations in a small, regular shape (`subject` + `type` + place), and **recall** them when a card needs them (e.g. `iron_ore` / `resource` while exploring → later “mine iron” card gets nearby hits).

Audited / designed content stays in the git workspace ([`workspaces.md`](workspaces.md)). Compaction cards bridge live recall data into git snapshots.

Related: [`../specs/world/designated-regions.md`](../specs/world/designated-regions.md) — region enforcement stays on the bot side (`data/regions-<world>.json` + `/regions`); the host API does not replace that.

---

## Why it exists

| Class of data | Git workspace | Host API |
|---|---|---|
| Plans, blueprints, runbooks, skill bundles | ✓ | |
| Compacted catalogs (worksites, stockpiles, POI summaries) | ✓ (generated/) | |
| **Episodic recall** (subject/type/at place reports) | archive after compaction | ✓ **primary store** |
| Live fleet state, dispatch/intent logs, capacity | | ✓ |
| Committed marks, chest caches, regions (today) | partial | mirror optional; bots stay authoritative |

The API avoids making git a contention point for high-frequency cross-bot writes. **Recall does not require a spatial entity model on the write path.**

---

## Architecture

```
Mineflayer bots (one process per bot)
    │  position, inventory, marks, scene, observe
    ▼
Bot HTTP APIs (ports 3001–3005)
    │  /health /status /observe /marks /regions /goals …
    ▼
HOST DATA API (one fleet process — landfolk plugin)
    │  POST /api/workspace/recall/events     append-only recall stream
    │  GET  /api/workspace/recall/events       tail / filter by subject, type
    │  GET  /api/workspace/recall/near         task-time lookup
    │  GET  /api/workspace/recall/hints        optional clustered index
    │  GET|PUT /api/workspace/operations/...   fleet, dispatch, intent (appendix)
    ▼
Hermes tools (landfolk plugin)
    │  workspace(action="recall.report", payload={ subject, type, where, … })
    │  workspace(action="recall.near", subject="iron_ore", type="resource", …)
    ▼
Agent workers (@planner, @dispatcher, @miner, …)
```

Bot HTTP APIs stay as today. The host API **aggregates fleet views** and **persists recall**; it does not replace per-bot marks, chest snapshots, or region enforcement.

---

## Recall stream (MVP schema)

One append-only event. **`subject`** = what the event is *about*; **`type`** = what happened (closed enum). Agents think in pairs, not open tags + verbs.

### Fields

| Field | Required | Meaning |
|---|---|---|
| `ts` | yes (server may set) | ISO time; `since=` ordering |
| `who` | yes | `{ "agent": "<profile>", "bot": "<name> or null" }` |
| `where` | yes | `{ "world", "x", "y", "z" }` (floored ints) — always set for spatial recall |
| `subject` | yes | **About what** — see table below |
| `type` | yes | **What happened** — one of: `resource`, `blocked`, `damage`, `depleted`, `note` |
| `qty` | no | Count or estimate when relevant |
| `card_id` | no | Kanban task id when report happens during a card |
| `detail` | no | One short line (≤120 chars) — only for `note` or extra context; not a JSON bag |

**Dropped for MVP:** `refs`, `meta`, free-form `kind`. Marks and regions go in **`subject`**; trace goes in **`card_id`**.

### Subject (by type)

| `type` | `subject` means | Examples |
|---|---|---|
| `resource` | Block id, item id, or mob id | `iron_ore`, `cow`, `wheat` |
| `blocked` | What is blocked (often `path`) | `path`, `door`, `gate` |
| `damage` | Mark or region **name** (no colons required) | `base`, `hut1`, `road_bluff` |
| `depleted` | Same as resource or mark | `iron_ore`, `chest_iron` |
| `note` | Short label | `scout`, `anomaly` |

Mark names align with `:mark:` DSL but **store without colons** (`base` not `:base:`) so queries and tool args stay uniform.

### Type (closed enum)

| `type` | Use when |
|---|---|
| `resource` | Seen something useful to mine/gather/farm later |
| `blocked` | Navigation failed or route unusable at/near `where` |
| `damage` | Structure or marked site wrong, missing blocks, creeper hit |
| `depleted` | Known spot emptied (vein, chest, crop patch) |
| `note` | Anything else worth remembering without forcing a fake resource id |

### Examples

```json
{
  "subject": "iron_ore",
  "type": "resource",
  "qty": 1,
  "where": { "world": "world", "x": 22, "y": 98, "z": 10 },
  "who": { "agent": "miner", "bot": "pip" },
  "card_id": "t_abc123"
}
```

```json
{
  "subject": "path",
  "type": "blocked",
  "where": { "world": "world", "x": 100, "y": 64, "z": -20 },
  "who": { "agent": "navigator", "bot": "mox" },
  "detail": "water_flooded"
}
```

```json
{
  "subject": "base",
  "type": "damage",
  "where": { "world": "world", "x": -456, "y": 74, "z": 596 },
  "who": { "agent": "builder", "bot": "mox" },
  "detail": "missing_fence_section_3"
}
```

### Ingest rules (server-side)

- **Dedupe:** same `who.bot` + `subject` + `type` + cell `(x,y,z)` within ~10 minutes → refresh `ts` / add `qty`.
- **Retention:** raw rows N days then archive to `data/workspace/archive/recall/<year-week>.jsonl.gz`.

Storage: SQLite recommended for `near`; contract is field names above, not storage engine.

---

## LLM-friendly design + shift-left

Goals: agents should **pick from a menu**, not invent schema; classification should happen **before** the LLM when possible.

| Technique | Who | Effect |
|---|---|---|
| **Closed `type` enum** | API + tool schema | Tool call cannot send arbitrary `kind`; validation errors are obvious |
| **Subject recipes in agent bundles** | `@navigator`, `@miner`, … | “After `find_blocks`, report `type=resource`, `subject=<block>`” — copy-paste patterns |
| **Server-side emit** | Bot HTTP hook (phase 1b) | On `mc find_blocks` / structured `nearby` hits → auto `recall.report` with `type=resource`, `subject=block.name` — agent skips write |
| **Card inject** | `@dispatcher` / `@planner` | Before spawn: `recall.near` + format **3 bullet lines** in card body (“iron_ore @ 22,98,10 — pip 2d ago”) — worker reads prose, not JSON |
| **Keyword → subject** | Planner | Card title “mine iron” → query `subject=iron_ore&type=resource` (synonym table: iron → iron_ore) — deterministic, no LLM |
| **Preset tool wrapper** | Hermes plugin | `recall.resource(subject, qty?)` / `recall.blocked(detail?)` / `recall.damage(subject)` — sets `type` for the agent |
| **Hints index** | API | Clusters `subject`+`type` near a point so planner gets one line per cluster, not 50 events |

**Lean MVP:** explicit `recall.report` with enum + presets; add auto-emit from bot actions after dedupe is tested; always inject human-readable recall into card bodies at bind time.

---

## Recall endpoints (MVP)

```
POST   /api/workspace/recall/events
GET    /api/workspace/recall/events?subject=&type=&since=&who.bot=&limit=
GET    /api/workspace/recall/near?subject=&type=&x=&y=&z=&world=&radius=&limit=
GET    /api/workspace/recall/match?q=&limit=          # optional: map card text → subject/type
GET    /api/workspace/recall/hints?subject=&type=&near=…
```

Query **`type`** is optional on read (broader search). On **write**, both `subject` and `type` are required.

### Task-time recall (iron example)

1. **Explore:** `recall.resource("iron_ore")` or server auto-emit after `find_blocks`.
2. **New card “mine iron”:** planner/dispatcher runs `recall.near?subject=iron_ore&type=resource&…`.
3. **Worker wake:** card body lists top hits in plain language (injected at bind).
4. **Commit (optional):** compaction → mark or `geo/generated/worksites.json`.

---

## Hints (optional projection, not authored)

The API may cluster rows with the same `subject` + `type` within radius R → `{ centroid, last_ts, count }`. Exposed as `GET …/recall/hints`.

This replaces day-one “create `type=worksite, kind=ore_vein` entity” for mining tasks. Full spatial catalog (appendix) comes later if hints + marks are not enough.

---

## Curation: `@reporter`

[`hermes-agents.md`](hermes-agents.md) defines `@reporter` as the bot-less curation agent. Role under this model:

- Tail `recall/events` (or hints) on a schedule.
- Write **git** artifacts (`geo/generated/worksites.json`, digests, post-mortems) — not mandatory entity CRUD.
- Suggest fleet marks or `[COMPACT]` cards when clusters stabilize.

MVP can fold this into `@overseer` or domain agents; the **recall stream runs regardless.**

Initial curation example: recurring `subject=cow` + `type=resource` near base → `generated/` farm hints for `@planner`.

---

## Relationship to today’s persistence

| Today | Role vs recall |
|---|---|
| `locations-*.json`, `locations-base.json` | **Committed names** — fleet agreement; reconciler owns base |
| `chest-snapshots-*.json` | Container cache on bot; not the recall stream |
| `personal-pois-*.json` | Named landmarks; POI name can be `subject` on a `note` or `resource` report |
| `nav-*.jsonl` in `/tmp/hermescraft` | Action telemetry; different purpose (playbook/card tracing) |
| Kanban DB | Tasks; optional `card_id` on recall rows |

**Stream = episodic memory. Marks = committed coordinates.** Do not re-implement `locations-base.json` inside recall; compaction may *produce* marks or git snapshots when the operator wants them.

---

## Operations endpoints (second concern)

Not spatial recall — fleet coordination. Same host process, separate paths:

```
GET|PUT  /api/workspace/operations/fleet-state
GET|PUT  /api/workspace/operations/capacity-forecast
GET|POST /api/workspace/operations/intent-log?since=
GET|POST /api/workspace/operations/dispatch-log?since=
GET|POST /api/workspace/operations/epic-judgments?since=
GET      /api/workspace/operations/metrics/rollup?window=24h|7d   # optional; reads generated trends
GET      /api/workspace/operations/colony-overview               # optional; latest snapshot JSON
```

**Dashboard (Layer 1)** reads the host API when live, and **`operations/generated/`** for trends and colony rollup — see [`dashboard-metrics-spec.md`](dashboard-metrics-spec.md). Agents do not depend on the dashboard.

Compaction control (`/compaction/...`) deferred until a domain needs watermarks.

---

## Metrics & trends (colony dashboard)

Dashboard UI, metric catalog, wireframes, and trend **tiers** (live delta vs hourly JSONL): [`dashboard-metrics-spec.md`](dashboard-metrics-spec.md).

Host API may expose optional `GET …/operations/metrics/rollup` and `colony-overview` — same files under `operations/generated/` as source of truth ([`workspaces.md`](workspaces.md)). Recall DB does not store time-series metrics.

---

## Auth

Plugin tool handlers run inside Hermes; the runtime knows the calling profile.

- **Agent → API:** permission map in `plugins/landfolk/landfolk/data_api/permissions.yaml` (no per-spawn tokens).
- **External (dashboard):** localhost + optional dev token in dispatcher `.env`.

---

## Aggregation from bot HTTP (Phase A)

Lightweight poll (~30–60s), read-only at first:

```
For each bot in fleet:
  GET /health, /status  → operations/fleet-state slice
  (optional) GET /marks → dashboard only; do NOT require entity upsert
```

Marks/regions/POIs remain on bot APIs until compaction explicitly mirrors them to git. Recall is **worker-written**, not scraped from `/observe`.

---

## Implementation phases

**Phase A — Recall read/write**

- API skeleton + SQLite (or JSONL + index).
- `POST/GET recall/events`, `GET recall/near`.
- Hermes tool: `recall.report`, `recall.near`.
- `@planner` / dispatcher inject recall bullets into card bodies when keywords match subjects.

**Phase B — Operations**

- `@dispatcher` writes fleet-state / capacity.
- Intent and dispatch append-only logs.

**Phase B2 — Dashboard trends (optional)**

- Hourly append to `operations/generated/trends/hourly.jsonl` (dashboard or dispatcher).
- Optional `GET …/operations/metrics/rollup` + `colony-overview` snapshot.

**Phase C — Compaction + hints**

- `recall/hints` clustering.
- `[COMPACT] geo` cards: stream → `geo/generated/worksites.json` + archive.
- Optional mirror of bot marks into git audit files (not a unified entity API).

Stop after any phase if it is enough.

---

## Open questions

1. **SQLite vs JSONL** — SQLite simplifies `near`; JSONL is easier to inspect. Lean: SQLite with nightly JSONL export for archives.
2. **Auto-report hook** — bot server emits `type=resource` from structured scans; agent uses presets for blocked/damage only at first.
3. **World shard** — one DB per world vs column on every row. Lean: `where.world` column, single DB for landfolk fleet.
4. **Match endpoint** — simple token split on card title vs embedding search. Lean: tokens only at MVP.

---

## Appendix: spatial catalog (phase 2+, optional)

If hints + marks + git snapshots are insufficient, introduce a **materialized catalog** — curated entities compiled from recall + compaction, not the agent write path.

Each catalog row (future): `id` (`:mine_nw:`), `type` (`worksite` | `stockpile` | `place` | …), `kind` (`ore_vein` | `chest` | …), point geometry, `visibility`, `properties` JSON validated per `(type, kind)`.

Endpoints such as `GET /entities` and promotion/overlap rules belong here — **after** recall is shipping. Geometry aligns with [`designated-regions.md`](../specs/world/designated-regions.md) (`rect` / column hints); bot region resolver stays authoritative for dig/place.

Do not block MVP recall on this appendix.

---

## Related docs

- [`components.md`](components.md) — runtime map (dashboard, dispatcher tick, bot HTTP, plugins)
- [`workspaces.md`](workspaces.md) — git layout, ingest vs generated, compaction, trends files
- [`dashboard-metrics-spec.md`](dashboard-metrics-spec.md) — colony overview UI + trend tiers
- [`target.md`](target.md) — where the host API sits in “what we build”
- [`hermes-agents.md`](hermes-agents.md) — `@reporter`, `@planner`, `@dispatcher`
- [`../specs/world/marks-sign-anchored.md`](../specs/world/marks-sign-anchored.md) — committed placemarks vs recall

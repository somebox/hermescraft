# Bots and in-game control (`mc`, HTTP, marks)

Status: **design exploration** (2026-06-05). **Minecraft bodies** and how agents act in-world: bot registry, Mineflayer HTTP, the **`mc` CLI**, marks, and host hooks (mutex, spawn env). Hermes profiles, skills, and planner DSL: [`hermes-agents.md`](hermes-agents.md). Card flow: [`target.md`](target.md).

Operator cheat sheet: [`../../AGENTS.md`](../../AGENTS.md). Runtime map: [`components.md`](components.md). Verb registry: [`../reference/mc-cheatsheet.md`](../reference/mc-cheatsheet.md) (generated from [`bot/cli/registry.mjs`](../../bot/cli/registry.mjs)).

---

## Bot registry (bodies, not profiles)

| | **Bot** | **Agent** (Hermes) |
|---|---|---|
| What | Named **player** in the world | Job expertise on a card |
| Config | `data/bots/<name>.yaml` — `api_port`, `username` | `~/.hermes/profiles/<agent>/` |
| On card | `metadata.bot` | `assignee` |
| Mutex | **One running card per bot** (gate-check on `metadata.bot`) | Same agent may run on different bots over time |

Canonical player names and migration mapping — **§ Target fleet roster** below. **`assignee` is not the bot name** — today’s board often uses legacy bot names as assignee ([`impact.md`](impact.md) migration).

**Persona (later):** voice/disposition per bot, separate from agent SOUL — TBD in registry and/or `reference/souls/bots/`. Agents stay interchangeable; personas do not.

**Fleet today:** [`data/agent-registry.json`](../../data/agent-registry.json) still lists legacy names (Flint, Mason, …). Target: `data/bots/<id>.yaml` per roster below.

---

## Target fleet roster

**Player bodies** — registry ids and in-game usernames. Not job titles; **`assignee`** carries expertise ([`hermes-agents.md`](hermes-agents.md)).

Naming rules: short (3–4 letters), easy to say; playful; no profession/crop/tool words; neutral coinages.

| Registry id | MC username | Typical use in docs | Replaces (today → target) |
|---|---|---|---|
| `pip` | Pip | Default pilot (`@navigator pip to :mark:`) | Flint |
| `mox` | Mox | Single-bot epic chains ([`example-wheat-farm-walkthrough.md`](example-wheat-farm-walkthrough.md)) | Mason |
| `zee` | Zee | Second lane | Gatherer |
| `bix` | Bix | Third lane | Barley |
| `glim` | Glim | Optional chat anchor (not `@overseer`) | Steward player |

`data/bots/<id>.yaml` — `{ api_port, username }`. **`glim`** only if we keep a dedicated in-world voice; orchestration stays bot-less.

```
@navigator pip to :base_anchor:
metadata.bot: mox   # epic default — rotating assignee on one body
```

---

## Control surface: agent → `mc` → bot HTTP

```
Hermes worker (agent profile)
    │  terminal: mc <verb> …
    ▼
bot/cli  →  HTTP  http://127.0.0.1:<api_port>/api/…
    ▼
Mineflayer process (scripts/landfolk supervises)
```

- **Discovery:** [`data/agent-registry.json`](../../data/agent-registry.json) / [`scripts/roster.py`](../../scripts/roster.py) today; target **`data/bots/*.yaml`** + dispatcher fleet snapshot ([`data-api.md`](data-api.md)).
- **Spawn binding:** when `metadata.bot` is set, host injects `MC_API_URL` and `MC_USERNAME` before worker start ([`impact.md`](impact.md) § F). Worker does not read the repo `bot/` tree.
- **Workspace scripts:** `data/workspace/<domain>/scripts/` may shell out to `mc` under OWNERS ([`workspaces.md`](workspaces.md)) — same HTTP surface, not a second protocol.

Dashboard and operators also poll bot HTTP (read-only); agents use **`mc`** as the blessed write path during cards.

---

## Validated today (in-game stack)

| Assumption | Evidence |
|---|---|
| Verb registry + CLI | `bot/cli/registry.mjs`, `docs/reference/mc-cheatsheet.md` |
| Per-bot listener + ports | `data/agent-models.json`, roster |
| Live state slices | `bot/lib/server/state.js` — status, observe, inv, marks, … |
| Marks + shared names | `GET /marks`, `data/locations-*.json`, [`reconcile-marks.py`](../../scripts/reconcile-marks.py) |
| Regions (enforce) | Bot regions API + `data/regions-*.json` ([`designated-regions.md`](../specs/world/designated-regions.md)) |
| Mutex / promotion | `hermes landfolk gate-check` — **extend** to `metadata.bot` ([`landfolk-plugin.md`](../specs/kanban/plugin-landfolk.md)) |

**Not validated yet:** spawn-time injection from `metadata.bot`; assignee = agent name on production cards; `:mark:` resolver when chosen bot is `down` (fallback: `locations-base.json` vs fail parse — open question below).

---

## Marks and `:mark:` notation

Placemarks tie card text to coordinates ([`sign-anchored-placemarks.md`](../specs/world/marks-sign-anchored.md)).

| Consumer | Resolution |
|---|---|
| `@planner` / parser | Validate `:id:` against live `GET /marks` (any online bot) or merged **`locations-base.json`** |
| `@navigator` worker | `mc goto`, `go_mark`, movement verbs ([`agent-navigator.md`](../../skills/agent-navigator.md)) |
| Recall (optional) | Target without a mark — [`data-api.md`](data-api.md) |

No global Hermes `/api/marks` at MVP — bot HTTP + reconciled base file.

---

## Skill bundles — in-game **Verbs**

Agent bundles ([`hermes-agents.md`](hermes-agents.md)) include a **Verbs** section: the **`mc` commands** allowed in that phase. Grammar and edge cases live in L3 **`minecraft-*`** companions, not duplicated in architecture docs.

| Agent phase | Typical `mc` families (see cheatsheet) |
|---|---|
| Navigate | `goto`, `move`, `go_mark`, `observe`, `scene`, pillar/stair helpers |
| Mine | `dig`, `collect`, `pillar_*`, inventory checks |
| Build | `place`, `fill`, blueprint-driven verbs |
| Craft / store | `craft`, `deposit`, `withdraw`, `chest_search` |
| Farm | till/plant/harvest patterns via farming skill |

**L1 opportunistic craft** (all bot-bound execution): short ladder via survival skill — torches, tools — without opening a `@crafter` card ([`hermes-agents.md`](hermes-agents.md)).

Long-running work: `bg_*` async variants where the registry exposes them.

---

## Host hooks (not `mc`, but gate in-world work)

| Hook | Role |
|---|---|
| **gate-check** | One ready card promoted per **`metadata.bot`** (target); today often per assignee |
| **post_tool_call** | Observer; pairs with gate-check |
| **pre_tool_call** (target) | Path allowlist — agents cwd `data/workspace/` ([`workspaces.md`](workspaces.md)) |

Dispatcher loop: [`components.md`](components.md) (`landfolk-dispatcher.sh` → gate-check → dispatch).

---

## MVP build (in-game / plugin)

| Piece | MVP | Defer |
|---|---|---|
| Bot registry | `data/bots/pip.yaml` `{ api_port, username: Pip }` | One-cut retire of `agent-models.json` |
| Spawn injection | Wrapper or gate-check reads registry → `MC_*` | Hermes `pre_spawn` in core |
| Mutex | Plugin keys park/claim on `metadata.bot` | Per-assignee mutex removed |
| Marks | `:id:` via one bot `/marks` or base file | Global marks service |

Hermes-side parser, profiles, bundles: [`hermes-agents.md`](hermes-agents.md).

**Pilot card:** `@navigator pip to :base_anchor:` — compare turns/time vs wide worker on nav-only work.

---

## Deliberately skip (in-game plane)

- Weighted fleet scoring — [`board-dynamics.md`](board-dynamics.md).
- Hermes profiles for bots — registry YAML only.
- Scraping `/observe` into recall — workers **`recall.report`** ([`data-api.md`](data-api.md)).

---

## Open questions

1. **Mark resolver when bot down** — read `locations-base.json` vs fail planner parse.
2. **Deferred bot in syntax** — prefer epic `metadata.bot` + inherit on children ([`epic-lifecycle.md`](epic-lifecycle.md)).

---

## Pilot checklist (in-game / plugin)

1. Extend landfolk mutex → **`metadata.bot`**  
2. Spawn wrapper: registry → **`MC_*`**  
3. One bot-bound **`@navigator`** pilot + metrics  
4. Verify roster + `mc status` / `observe` under injected env  

Hermes parser/profile steps: [`hermes-agents.md`](hermes-agents.md).

---

## Related

- [`bot-roster.md`](bot-roster.md) — target player names  
- [`hermes-agents.md`](hermes-agents.md) — profiles, skill matrix, DSL ownership  
- [`epic-lifecycle.md`](epic-lifecycle.md) — `--epic`, `--depends-on`, bot inheritance  
- [`components.md`](components.md) — bot processes, dashboard poll, dispatcher  
- [`data-api.md`](data-api.md) — recall alongside marks  

# Bots and in-game control (`mc`, HTTP, marks)

Status: **design exploration** (2026-06-05). **Minecraft bodies** and how agents act in-world: bot registry, Mineflayer HTTP, the **`mc` CLI**, marks, and host hooks (mutex, spawn env). Hermes profiles, skills, and planner DSL: [`hermes-agents.md`](hermes-agents.md). Card flow: [`target.md`](target.md). **Reflex-first interface vision:** [`embodied-control.md`](embodied-control.md).

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

**Design intent:** each `mc` call should behave like **motor control** — destination in, envelope out — not a prompt to re-derive geometry. Navigation is a **taxi** (arrive or replan); common jobs should be **macros**; block coords are **microscope** mode. Workers see a **small agent surface** (~30–40 core verbs); the full registry is for implementers. Policy: [`embodied-control.md`](embodied-control.md).

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

Agent bundles ([`hermes-agents.md`](hermes-agents.md)) include a **Verbs** section: the **`mc` commands** allowed in that phase. Grammar and edge cases live in L3 **`minecraft-*`** companions, not duplicated in architecture docs. **Interface philosophy** (prefer macros and task-shaped reads over block-level reasoning): [`embodied-control.md`](embodied-control.md).

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

## Fleet binding and supervision (normative)

This section is the **contract** for mapping kanban cards to in-game players and keeping `mc` pointed at the right HTTP listener. Enforcement details for bind/rebind live in [`board-dynamics.md`](board-dynamics.md); process supervision in [`components.md`](components.md); aggregated status schema in [`data-api.md`](data-api.md) § Fleet state record.

### Sources of truth

| Layer | Field | Meaning |
|---|---|---|
| Card | `assignee` | Hermes **agent** profile (`navigator`, `miner`, …) — expertise only |
| Card | `metadata.bot` | Registry **body** id (`pip`, `mox`, …) — target canonical store |
| Card title | `[bot:<id>]` prefix | Encoding used today on many boards; same id as `metadata.bot` when both present |
| Host | `data/bots/<id>.yaml` | `api_port`, `username` — **only** the spawn layer and operators read this at runtime |

**Resolution order** when determining which body a card uses:

1. `metadata.bot` if set on the card (target).
2. Else leading `[bot:<id>]` on the title (matches [`mutex_key.py`](../../plugins/landfolk/landfolk/orchestrator/mutex_key.py) and [`spawn-with-bot.sh`](../../scripts/colony-validation/spawn-with-bot.sh)).
3. Never treat `assignee` as the body name — legacy boards that used bot names as assignee are migration debt ([`impact.md`](impact.md)).

**Today:** Hermes tasks have no `metadata.bot` column yet. Landfolk [`mutex_key.py`](../../plugins/landfolk/landfolk/orchestrator/mutex_key.py) and [`spawn-with-bot.sh`](../../scripts/colony-validation/spawn-with-bot.sh) resolve the body from a leading **`[bot:<id>]`** title prefix, else per-assignee mutex (legacy). When storage catches up, both call sites should read `metadata.bot` first without changing gate-check or spawn semantics ([`impact.md`](impact.md) § F).

Epic-level default bot: [`epic-lifecycle.md`](epic-lifecycle.md) (inherit on child cards).

### Enforcement points (three layers)

| Layer | Mechanism | Doc |
|---|---|---|
| **Write-time bind** | `@dispatcher` sets `metadata.bot` when materializing intents | [`board-dynamics.md`](board-dynamics.md) |
| **Dispatch mutex** | landfolk **gate-check**: at most one **running** card per `metadata.bot` | [`board-dynamics.md`](board-dynamics.md), plugin hooks |
| **Worker spawn** | Host reads resolved body → registry yaml → exports `MC_API_URL`, `MC_USERNAME`, `_MC_API_URL_LOCKED` (optional), sets `HERMES_KANBAN_TASK` | [`impact.md`](impact.md) § F, [`spawn-with-bot.sh`](../../scripts/colony-validation/spawn-with-bot.sh) |

Gate-check and spawn **must use the same body-resolution function** so mutex domain and HTTP port never disagree.

### Worker runtime contract

- Agents **do not** read `data/bots/` or discover ports from card prose ([`workspaces.md`](workspaces.md) access model).
- `mc` resolves HTTP via [`bot/cli/api-url.mjs`](../../bot/cli/api-url.mjs): on kanban workers, `HERMES_KANBAN_TASK` + `MC_API_URL` beat a stale parent `_MC_API_URL_LOCKED`.
- **Genesis v2 lease path (MVP):** colony specialists mint with `HERMES_BOT_LEASE=1` and **no** `MC_API_URL` — bodies are acquired at runtime via [`mc bot checkout`](bot-lease.md) / `release`. See [`bot-lease.md`](bot-lease.md). Landfolk flint/mason remain on frozen `MC_API_URL`.
- Hermes **scrubs `MC_*` at kanban worker spawn** (parent/dispatcher exports do not stick). Injection must land **after** scrub via:
  - **Target:** spawn wrapper / plugin hook (per-card registry lookup) — [`spawn-with-bot.sh`](../../scripts/colony-validation/spawn-with-bot.sh).
  - **Validated interim (W1 wheat):** same-body `MC_API_URL` + `MC_USERNAME` in each execute-role profile `.env` ([`setup-role-profiles.sh`](../../prototypes/agent-arch/setup-role-profiles.sh)); **not** SOUL/wrapper-on-PATH. **Capstone / single-bot only** — fleet needs per-card lookup (scorecard `injection_ceiling_note` in [`w1-1780879052`](../../data/postmortems/wheat-capstone/w1-1780879052/scorecard.json)).
- Pre-live gate: [`scripts/smoke-worker-env.sh`](../../scripts/smoke-worker-env.sh) (or equivalent) asserts bot HTTP reachable with profile `.env` or spawn injection.

Optional belt-and-suspenders (not primary): spawn writes `~/.hermes/profiles/<agent>/.mc-binding.json`; `mc status` echoes `bound_bot` + task id for postmortems.

### Binding vs liveness vs supervision

| Concept | Question | Ground truth |
|---|---|---|
| **Binding** | Which card may drive which body? | Kanban + `metadata.bot` / title prefix + gate-check |
| **Liveness** | Can `mc` talk to that body now? | Bot HTTP `GET /health` or `/status` (200) |
| **Supervision** | Is the Mineflayer OS process up? | `scripts/landfolk` / `scripts/colony` `start <id>` — see [`components.md`](components.md) |

Use **HTTP** for dispatch and scorecards; supervisor PID is for **restart**, not for “bot ready to accept `mc`”.

**Observer bots** (e.g. Tester on a separate port for `mc verify`) are separate registry entries. Acceptance prep may tp an observer near the plot ([`prep-wheat-verify-observer.sh`](../../scripts/prep-wheat-verify-observer.sh)); that does not change the worker’s `MC_API_URL`.

### Reliable patterns (checklist)

1. **Encode body on the card** — `[bot:mox]` in title and/or `metadata.bot` at create; `assignee` = agent only.
2. **Resolve once at spawn** — card → body id → `data/bots/<id>.yaml` → env exports; no agent-side registry reads.
3. **One running card per `metadata.bot`** — mutex on body, not assignee.
4. **Skip down bodies at bind** — dispatcher reads fleet snapshot ([`data-api.md`](data-api.md)); rebind ready cards when body is `down`.
5. **Deploy `mc` CLI** — binding does not fix stale `~/.local/bin/mc`; symlink/regenerate from repo `bin/mc` before trials.
6. **Capstone vs fleet** — single-bot epic: shared body across four agents is OK; fleet: same agent profile on different cards must get **per-card** spawn injection, not a static body in profile `.env`.

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
- [`data-api.md`](data-api.md) — recall + § Fleet state record  
- [`board-dynamics.md`](board-dynamics.md) — bind, mutex, rebind  
- [`impact.md`](impact.md) § F — spawn pipeline  

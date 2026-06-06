# Workspaces

Status: **design exploration** (2026-06-05). Consolidates workspace layout; **two-store split** and agent access layers are summarized here — recall vs git boundary detail in [`data-api.md`](data-api.md).

The storage model rests on the corrected mapping in [`target.md`](target.md): **agents are Hermes profiles, bots are registry entries**. State and code live in three places — agent Hermes homes, a shared domain-organized workspace, and the bot registry — each with a clear ownership rule.

The shared workspace is **organized by domain** (not by agent) because work is collaborative: many agents read and write into the same domain. Ownership lives in an `OWNERS.yaml` rather than in directory structure.

---

## Five-layer access model

The architecture isolates agents from the framework source tree. Agents see workspace content, their own Hermes home, and a curated set of distributed commands. They never see `bot/`, `plugins/`, `scripts/`, `dashboard/`.

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. FRAMEWORK / SYSTEM  (source tree — humans only)              │
│    bot/  plugins/  scripts/  dashboard/                         │
│    Modified by: developers, operators                           │
│    Agent runtime access: NONE                                   │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ 2. DISTRIBUTED COMMANDS  (bin/ → installed to profile PATH)     │
│    bin/mc  bin/kanban-helpers  bin/marks  bin/workspace         │
│    Installed by: scripts/setup-landfolk-profiles.sh             │
│    Agent runtime access: execute only (read-only files)         │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ 3. PROFILE CONTENT  (deployed → ~/.hermes/profiles/<agent>/)    │
│    config.yaml  SOUL.md  skills/  profile.yaml                  │
│    Deployed from: data/workspace/reference/{skills,souls}/      │
│    Agent runtime access: Hermes-managed (read at session start) │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ 4. SHARED WORKSPACE  (data/workspace/ — the team's brain)       │
│    geo/  infra/  production/  operations/  reference/           │
│    Agent runtime access:                                        │
│      - data files: read freely; write per OWNERS.yaml           │
│      - scripts: read + execute; write via [MR] cards            │
│    Tracked in git, per-world/scenario                           │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ 5. AGENT HOME  (~/.hermes/profiles/<agent>/)                    │
│    memories/MEMORY.md  sessions/  workspace/  .env (secrets)    │
│    Agent runtime access: Hermes-mediated; secrets never read    │
└─────────────────────────────────────────────────────────────────┘

  + Bot registry (data/bots/) — read-only by spawn layer; not
    accessed by agents directly under normal operation.
```

Layers 1-3 are **build-time / deploy-time** content. Layer 1 is the source we hand-write. Layers 2-3 are derived/distributed from source (or from workspace). Layers 4-5 are **runtime mutable**.

The key isolation: **the source tree (Layer 1) is invisible to agents at runtime**. Agents have no `cwd` path into it, nothing in their PATH points to it, and (with enforcement) the file tool rejects writes there.

### What "agent runtime" means

When a worker spawns for a card, its filesystem-relevant context is:
- **cwd**: `data/workspace/` (or a worktree of it for `[MR]` cards)
- **PATH**: `~/.hermes/profiles/<agent>/bin/` + standard system paths
- **HERMES_HOME**: `~/.hermes/profiles/<agent>/`
- **File tool scope** (enforced by `pre_tool_call` hook in landfolk plugin):
  - read+write: `data/workspace/**` (gated by OWNERS), `~/.hermes/profiles/<agent>/workspace/**`, `~/.hermes/profiles/<agent>/memories/**`
  - read only: `data/bots/*.yaml`, `bin/*`, `~/.hermes/profiles/<agent>/skills/**`
  - blocked: `bot/**`, `plugins/**`, `scripts/**`, `dashboard/**`, other profiles' homes

For an MVP, cwd + the pre_tool_call hook deliver enforcement; container sandboxing (`terminal.backend: docker`) is the long-term hardening.

### What lives where

| Class | Source | Distributed to | Updated via |
|---|---|---|---|
| Framework orchestration | `bot/`, `plugins/`, `scripts/`, `dashboard/` | Not distributed to agents — runs on host | Developer commit + deploy + restart |
| Agent commands | `bin/` | `~/.hermes/profiles/<agent>/bin/` (PATH, read-only) | `setup-landfolk-profiles.sh` redeploy |
| Skill bundles | `data/workspace/reference/skills/` | `~/.hermes/profiles/<agent>/skills/` (read by Hermes) | `[MR]` on back-office → merge → redeploy |
| SOULs | `data/workspace/reference/souls/` | `~/.hermes/profiles/<agent>/SOUL.md` | Same `[MR]` flow |
| Workspace scripts | `data/workspace/<domain>/scripts/` | Read + execute in place | `[MR]` on back-office → merge → live immediately |
| Runbooks | `data/workspace/operations/ingest/runbooks/` | Read in place | `[MR]` → merge → live |

**Skills and SOULs migrate from source tree to workspace.** Today's `skills/agent-navigator.md` and `prompts/landfolk/worker.md` move into `data/workspace/reference/skills/` and `data/workspace/reference/souls/` respectively. The framework only keeps the install machinery; the expertise is workspace content versioned per world/scenario.

---

## Storage layers at runtime

Within the access model above, four layers are storage-relevant at runtime:

| Layer | Location | Owns | Lifetime | Git-backed? |
|---|---|---|---|---|
| **Agent Hermes home** | `~/.hermes/profiles/<agent>/` | Provider keys, `config.yaml`, `SOUL.md` (deployed), installed skills (deployed), Hermes-managed memory + sessions | Persistent | No (Hermes manages; secrets in `.env`) |
| **Bot HTTP APIs** | `http://localhost:<3001-3005>/api/*` (per-bot) | Live per-bot state: position, hp, inventory, marks, regions, goals, chest snapshots, observe, scene | Process-lifetime + per-bot JSON files | No (process state) |
| **Host data API** | `http://<host>:<port>/api/workspace/*` | Cross-bot **recall stream** + operational state (fleet, capacity, intent/dispatch logs) | API + DB-backed | No (DB; rebuildable from git checkpoints) |
| **Shared git workspace** | `data/workspace/` | Audited / designed content — plans, structures catalog, runbooks, skill bundles, SOULs, compacted observations, research, project log | Months to indefinite | Yes (PRs via the back-office board) |
| **Bot registry** | `data/bots/<bot>.yaml` | Mineflayer port, username, identity | Stable | Yes |

**Two-store split for live vs audited data:**

- **API (DB-backed)** owns operational, high-frequency, cross-bot state. Concurrent writers, transactional reads. Examples: **recall events** (`subject` + `type` + where + who), live fleet state, capacity forecasts, append-only intent/dispatch logs.
- **Git workspace** owns audited, designed, reviewable content. Low write rate, PR-reviewed. Examples: plans, runbooks, skill bundles, **compacted recall snapshots** (`geo/generated/worksites.json`, etc.).
- **Compaction is the bridge.** Maintenance cards read the recall stream (or API watermarks), write compacted artifacts to git. Git becomes the rebuild source if the API ever needs to rehydrate.

**Dashboard & trends:** the colony overview ([`dashboard-metrics-spec.md`](dashboard-metrics-spec.md)) reads **live** data (bot HTTP, kanban, host API, OpenRouter) and **history** from `operations/generated/trends/hourly.jsonl` plus existing JSONL logs (`deficits`, `goal-metrics`, `dispatch-log`). Prefer **hourly append JSONL** over a new metrics database — see [`data-api.md`](data-api.md) § Metrics & trends.

**Agents use the API for live recall.** JSON in git is for stable snapshots and scripts that avoid HTTP. Example live query: `GET /api/workspace/recall/near?subject=iron_ore&type=resource&…` — not a prerequisite to create a spatial entity first.

The bot HTTP APIs stay as today — they own per-bot live state (`bot/lib/server/state.js` nine slices). The host data API **persists cross-bot recall and ops state**; it does not replace bot marks, chest caches, or region enforcement. See [`data-api.md`](data-api.md) for the recall schema and endpoints.

---

## Ingest vs generated artifacts

A core principle of the git workspace: **don't mix designed input with computed output**. Each domain separates the two:

```
data/workspace/<domain>/
├── ingest/        # designed / curated / hand-written / reviewed input
└── generated/     # computed / compacted / aggregated output
```

| Class | Lives in | Updated by | Why |
|---|---|---|---|
| Plans, blueprints, recipes, runbooks, goal definitions, world-regions config, skill bundles, SOULs | `<domain>/ingest/` | Humans + `@engineer` via `[MR]` cards | Designed intent, reviewable, source of truth |
| Worksite catalog, stockpile catalog, route cache, POI catalog, compacted recall snapshots | `<domain>/generated/` | Compaction cards | Derived from **recall stream** + bot mirrors where needed |
| Colony overview snapshot, hourly trend buckets | `operations/generated/` | Dashboard rollup or `@dispatcher` / `[COMPACT] ops` | Operator metrics; not agent-authored |

The reason: when an `@engineer` opens a PR to fix a calc-materials script, the diff should not be noise from auto-generated worksite updates. When a curation card runs daily and rewrites `worksites.json`, the operator doesn't want to think about whether a human-edited rule changed. **Different cadences, different reviewers, different review intensity.**

This means **today's mixed files split** along this line as part of migration:

- `data/regions-<world>.json` (hand-curated world policy) → `operations/ingest/regions/<world>.json`
- `data/goals-<bot>.json` (designed goal definitions) → `production/ingest/goals/<bot>.json`
- `data/goal-presets/` (templates) → `production/ingest/goals/presets/`
- Compacted catalogs derived from recall → `geo/generated/worksites.json`, `production/generated/stockpiles.json`, etc.

OWNERS.yaml writes match this naming: `ingest/**` goes through human/agent review (`approve:`); `generated/**` is `compact:`-only (no direct edits).

---

## The five-domain shared workspace

```
data/workspace/
├── README.md                       # quick orientation for new readers
├── OWNERS.yaml                     # single-writer / append-rule per path
├── geo/                            # mapping, navigation, terrain knowledge
├── infra/                          # buildings, structures, blueprints
├── production/                     # inventory, materials, throughput, food supply
├── operations/                     # fleet state, dispatch, incidents, runbooks, defense
├── reference/                      # research, guides, project logs
└── archive/                        # retired/compacted content (preserved in git)
```

Five domains; each holds data, scripts, and (for some) sub-areas. Per-domain layouts:

### geo/ — spatial knowledge (places, worksites, routes, POIs)

```
geo/
├── ingest/                         # designed / curated input
│   ├── route-templates.yaml        # well-known/named-route templates the team curates
│   └── worksite-templates.yaml     # standard worksite definitions
├── generated/                      # compacted output (from recall stream + optional bot mirrors)
│   ├── worksites.json              # clustered sightings (e.g. iron_ore → worksite hints)
│   ├── routes.json                 # active route cache
│   ├── pois.json                   # team-visible POI summaries
│   ├── placemark-audit.json        # last audit of :mark: references
│   └── trail-snapshots/            # archived per-mission paths
└── scripts/
    ├── classify-worksite.py        # recall stream → generated worksites
    ├── compact-routes.py
    └── path-sim.py
```

Live recall lives in the host API (`POST/GET …/recall/*`). Snapshots in `generated/` exist so the dashboard, ad-hoc scripts, and PR-style auditing can read stable diff-able JSON.

Primary writers (git): `@navigator` (placemark-audit if hand-edited), compaction cards for `generated/`. **Reports** flow through `recall.report` on the host API (see [`data-api.md`](data-api.md)).

### infra/ — buildings, structures, plans

```
infra/
├── ingest/
│   └── plans/                      # versioned blueprints (any structure kind)
│       ├── road-bluff-v4.json
│       └── base-extension-v1.json
├── generated/
│   ├── structures.json             # catalog snapshot (kind=building/road/wall/...)
│   └── construction-log.jsonl      # compacted from API stream
└── scripts/
    ├── parse-blueprint.py
    └── verify-structure.py
```

Live build progress + recall events sit in the host API. Plans are designed input (PRs reviewed by `@engineer`). Structure catalog is computed from recall compaction where needed.

Primary writers (git): `@builder` (plans via MR), compaction cards (generated). Observations flow through the API.

### production/ — resources, flow, goals

```
production/
├── ingest/
│   ├── recipes.yaml                # known recipes (curated)
│   ├── budgets/                    # material budgets per build / mission (designed)
│   │   └── road-bluff-v4.yaml
│   └── goals/                      # goal definitions (per-bot or per-role)
│       ├── pip.json              # mirrors data/goals-<bot>.json per roster id
│       ├── mox.json
│       ├── zee.json
│       └── presets/                # template goal sets
├── generated/
│   ├── stockpiles.json             # catalog snapshot (kind=chest/barrel/hopper/...)
│   ├── deficits.jsonl              # compacted deficit events
│   └── goal-metrics-log.jsonl      # compacted metric history (live values in API)
└── scripts/
    ├── calc-materials.py
    ├── compose-budget.py
    └── stockpile-summary.py
```

Live stockpile contents + deficit tracking + goal metrics sit in the API (bot HTTP for live inv; recall for cross-bot item/location sightings). Designed recipes, budgets, goal definitions are reviewed input. Catalogs are computed.

Primary writers (git): `@crafter` (recipes via MR), `@overseer` (goal definitions, approved by operator), compaction cards (generated). Cross-bot sightings go through **recall** on the host API.

### operations/ — fleet, dispatch, defense, runbooks, regions, post-mortems

```
operations/
├── ingest/
│   ├── regions/                    # world-policy zones (source of truth; bot reloads from here)
│   │   └── world.json
│   ├── runbooks/                   # operational SOPs (any kind: defense, recovery, etc.)
│   │   ├── creeper-damage-repair.md
│   │   ├── bot-death-recovery.md
│   │   └── urgent-defense.md
│   ├── post-mortems/               # written after the fact, when an event closes
│   │   ├── 2026-06-04-creeper-section3.md
│   │   └── 2026-06-05-flint-respawn-loop.md
│   ├── threats.yaml                # threat-pattern catalog (lightweight)
│   └── loadouts.yaml               # weapon/tool loadouts per role
├── generated/
│   ├── dispatch-log.jsonl          # compacted from API stream
│   ├── intent-log.jsonl            # compacted from API stream
│   ├── epic-judgments.jsonl        # compacted from API stream
│   ├── colony-overview.json        # latest rollup for dashboard (stock, epics, burn headline)
│   └── trends/
│       └── hourly.jsonl            # one bucket per hour — sparklines (dashboard/dispatcher)
└── scripts/
    ├── score-affinity.py
    └── compose-fleet-state.py
```

Live operational state — fleet-state, capacity-forecast, real-time dispatch/intent/judgment streams — lives in the **API**, not in git. Compacted snapshots and **trend history** land in `operations/generated/` (JSON + JSONL). Regions, runbooks, threat catalogs, loadouts are reviewed input.

**Live incident tracking lives in kanban** — `[URGENT]` cards, `kanban_block` reasons, the existing alert pipeline. The `post-mortems/` folder is for **written-after-the-fact analysis**: someone (initially `@overseer`, eventually `@reporter`) writes up what happened once the event closes. PR-reviewed before merge.

Primary writers (git ingest): `@overseer` (runbooks, post-mortems via MR), operator (regions, threats, loadouts via MR). Generated content comes from compaction.

### reference/ — research, guides, project logs, agent expertise

`reference/` is mostly designed content. Almost everything is ingest; only the project log is generated.

```
reference/
├── ingest/
│   ├── skills/                     # agent skill bundles — deployed to profile skills/
│   │   ├── agent-navigator.md      # the @navigator bundle (currently in skills/)
│   │   ├── agent-miner.md          # planned
│   │   ├── minecraft-navigation.md # companion skills (currently in skills/)
│   │   ├── minecraft-mining.md
│   │   └── ...
│   ├── souls/                      # SOUL fragments — deployed to profile SOUL.md
│   │   ├── worker.md
│   │   ├── navigator.md
│   │   └── ...
│   ├── guides/                     # general guides
│   │   ├── y-level-mining-guide.md
│   │   └── blueprint-versioning.md
│   └── research/                   # findings from bot-less investigation cards
│       ├── ore-distribution.md
│       └── crafting-recipe-survey.md
├── generated/
│   └── project-log.jsonl           # what changed, when, why (high-level history; compacted from API)
└── scripts/
    └── lookup-recipe.py
```

Primary writers: `@engineer` (skills, SOULs, guides via MR with `approve: operator`), bot-less research cards (research findings). Project log is compacted from the API's operational streams.

**Why skills + SOULs live here:** they're agent expertise, versioned per world/scenario, modifiable by `@engineer` through the back-office MR flow. The framework keeps only the install machinery (`scripts/setup-landfolk-profiles.sh` reads from `reference/ingest/skills/` and `reference/ingest/souls/` at deploy).

---

## OWNERS.yaml — formalizing the writer convention

The "single-writer convention" gets explicit. The `OWNERS.yaml` file at the workspace root is the source of truth for who writes what:

```yaml
# data/workspace/OWNERS.yaml
# Tags:
#   write: <agent>      single canonical writer (ingest)
#   approve: <agent>    PR-style approval before merge (typically for ingest + scripts)
#   compact: <agent>    runs maintenance compaction (writes generated artifact from API stream)
#
# Convention: ingest/ paths use {write, approve}; generated/ paths use {compact}.
# Live operational data lives in the host API — see data-api.md.

# geo/
geo/ingest/route-templates.yaml:        {write: navigator, approve: overseer}
geo/ingest/worksite-templates.yaml:     {write: navigator, approve: overseer}
geo/generated/worksites.json:           {compact: navigator}
geo/generated/routes.json:              {compact: navigator}
geo/generated/pois.json:                {compact: navigator}
geo/generated/placemark-audit.json:     {compact: navigator}
geo/generated/trail-snapshots/:         {compact: navigator}
geo/scripts/**:                         {write: engineer, approve: overseer}

# infra/
infra/ingest/plans/:                    {write: builder, approve: engineer}
infra/generated/structures.json:        {compact: builder}
infra/generated/construction-log.jsonl: {compact: builder}
infra/scripts/**:                       {write: engineer, approve: overseer}

# production/
production/ingest/recipes.yaml:                  {write: crafter, approve: overseer}
production/ingest/budgets/:                      {write: crafter, approve: overseer}
production/ingest/goals/:                        {write: overseer, approve: operator}
production/ingest/goals/presets/:                {write: overseer, approve: operator}
production/ingest/playbooks/**:                {write: farmer, approve: overseer}
production/generated/stockpiles.json:            {compact: crafter}
production/generated/deficits.jsonl:             {compact: crafter}
production/generated/goal-metrics-log.jsonl:     {compact: overseer}
production/scripts/**:                           {write: engineer, approve: overseer}

# operations/
operations/ingest/regions/:                      {write: any, approve: operator}
operations/ingest/runbooks/:                     {write: any, approve: overseer}
operations/ingest/post-mortems/:                 {write: overseer, approve: overseer}  # written after event closes; live tracking is in kanban
operations/ingest/threats.yaml:                  {write: sentinel, approve: overseer}
operations/ingest/loadouts.yaml:                 {write: soldier, approve: overseer}
operations/generated/dispatch-log.jsonl:         {compact: dispatcher}
operations/generated/intent-log.jsonl:           {compact: planner}
operations/generated/epic-judgments.jsonl:       {compact: overseer}
operations/generated/colony-overview.json:       {compact: dispatcher}  # or dashboard host job
operations/generated/trends/hourly.jsonl:        {compact: dispatcher}  # dashboard may write same schema
operations/scripts/**:                           {write: engineer, approve: overseer}

# reference/  (mostly ingest)
reference/ingest/skills/**:             {write: engineer, approve: operator}
reference/ingest/souls/**:              {write: engineer, approve: operator}
reference/ingest/guides/:               {write: any, approve: overseer}
reference/ingest/research/:             {write: any}
reference/generated/project-log.jsonl:  {compact: overseer}
reference/scripts/**:                   {write: engineer, approve: overseer}
```

Notes:
- **`incidents/` is generated but `write: any, approve: overseer`** — agents file them (any can write), but they're PR-reviewed before merging. Closest thing to a hybrid path; pragmatic.
- **Skill bundles, SOULs, world regions, and goal definitions use `approve: operator`** because they shape agent behavior or world policy — operator review is the bar.
- **`compact:` is the only authorized writer for `generated/`** paths. Direct edits in PRs would conflict with the next compaction.

**Adding a new agent:** add their rows to OWNERS, no directory shuffling.
**Retiring an agent:** grep OWNERS for their entries, reassign or sunset.
**Confused operator:** `grep <path> OWNERS.yaml` tells you who writes there.

---

## Two boards: operations vs back-office

A kanban board is a unit of cards + dispatch + workers. We run **two**:

| Board | Cards | Workers | Cadence | Per-bot mutex |
|---|---|---|---|---|
| `landfolk-ops` (today) | `[NAV]`, `[MINE]`, `[BUILD]`, `[CRAFT]`, `[DEFENSE]`, `[SUPERVISE]`, `[MAINT]`, `[URGENT]`, … | Execution agents + `@dispatcher`, `@planner`, `@overseer`, `@sentinel` | Real-time (minutes) | Yes (landfolk plugin) |
| `landfolk-backoffice` | `[BUG]`, `[FEAT]`, `[REFACTOR]`, `[RESEARCH]`, `[DOC]`, `[MR]` (merge request) | `@engineer` primary; `@overseer` reviews; `@planner` for research planning | Async (hours-days) | No (workers run on git worktrees, parallel safe) |

The operations board is where in-game work happens. The back-office board is where **the team improves itself**: bug fixes to scripts, blueprint revisions, runbook updates, research investigations, recipe surveys, refactors. Different cadence, different reviewers, different metrics.

Hermes supports multiple boards natively via `kanban_create --board <name>`; selection is per-card. Profile configs declare which boards they participate in.

### PR-via-card workflow

The back-office board exists so code/plan/runbook changes flow through proper review. The workflow uses Hermes' git-worktree support ([ref](https://hermes-agent.nousresearch.com/docs/user-guide/git-worktrees)):

```
1. @miner observes calc-materials.py crashes on tilted blueprints
   → files a [BUG] card on landfolk-backoffice:
     title: "calc-materials.py crashes on tilted blueprint geometry"
     body: "stacktrace, repro, expected behavior"
     assignee: engineer

2. @engineer claims the [BUG] card
   → kanban_create spawns the worker in a fresh worktree
     (Hermes -w pattern: .worktrees/hermes-<hash>/, branch
     hermes/fix-calc-materials)
   → @engineer edits production/scripts/calc-materials.py
   → runs tests, commits to the branch
   → files an [MR] card on landfolk-backoffice:
     title: "MR: fix calc-materials tilted-blueprint crash"
     body: "branch: hermes/fix-calc-materials; diff summary; test output"
     assignee: overseer
   → @engineer card completes

3. @overseer claims the [MR] card
   → reviews the diff
   → if approved: merges branch to main (or comments with changes)
   → if rejected: comments requested changes; @engineer re-claims with new revision
   → on merge: original [BUG] card unblocks

4. data/workspace/production/scripts/calc-materials.py is the new version
   → next time @crafter runs calc-materials.py, the fix is live
```

Same pattern works for blueprint revisions (`infra/ingest/plans/`), runbook updates (`operations/ingest/runbooks/`), research papers (`reference/ingest/research/`). Anything OWNERS marks `approve: <agent>` flows through this.

**Operator involvement:** for high-stakes changes (production scripts, runbooks), the operator can be the approver instead of an agent. OWNERS can specify `approve: operator` for paths that should require human review.

**Verification:** kanban_create's `--workspace worktree:<path>` and `--branch <name>` flags are the natural fit. Verify on v0.15.2 that they behave per the kanban docs — if not, wrap the spawn with our spawn layer (Section F of [`impact.md`](impact.md)).

---

## How the layers compose at spawn time

For a card on the **ops board** with `assignee=miner` and `metadata.bot=pip`:

```
Hermes profile loaded:  ~/.hermes/profiles/miner/
                         ├── .env: OPENROUTER_API_KEY, ...
                         ├── config.yaml: model=deepseek-flash:exacto
                         │                env_passthrough: [MC_API_URL, MC_USERNAME]
                         ├── SOUL.md: "You are the @miner agent..."
                         └── skills/: agent-miner, minecraft-mining, ...

MC env injected:        MC_API_URL=http://localhost:3002   (from data/bots/pip.yaml)
                        MC_USERNAME=Pip

Worker spawn:           HERMES_HOME=~/.hermes/profiles/miner/
                        MC_API_URL=... MC_USERNAME=Pip
                        --skills agent-miner,minecraft-mining
                        hermes worker run

Worker reads:           data/workspace/geo/vein-database.json
                        data/workspace/geo/y-level-yields.json
                        data/workspace/infra/plans/  (to know material targets)
                        /api/marks (live mark resolution)
Worker writes:          POST /api/workspace/recall/events (primary cross-bot memory)
                        ~/.hermes/profiles/miner/memories/MEMORY.md (optional narrative)
```

For a card on the **back-office board** with `assignee=engineer` and a fix to `calc-materials.py`:

```
Hermes profile loaded:  ~/.hermes/profiles/engineer/
                         └── skills/: agent-engineer, ...

Worktree spawned:       .worktrees/hermes-<hash>/
                         (clone of data/workspace/ on branch hermes/fix-calc-materials)

No MC env injected:     bot-less card; engineer never touches Minecraft.

Worker spawn:           HERMES_HOME=~/.hermes/profiles/engineer/
                        cwd = the worktree
                        hermes worker run

Worker edits:           production/scripts/calc-materials.py
                        production/tests/test_calc_materials.py
                        commits to branch hermes/fix-calc-materials
                        files [MR] card on landfolk-backoffice
Worker writes:          ~/.hermes/profiles/engineer/memories/MEMORY.md (lessons learned)
```

The Hermes home stays sovereign; the workspace gets touched per OWNERS rules; back-office work happens in isolated worktrees with PR review.

---

## Code vs data within domains

Each domain contains **two kinds of content**:

- **Data** — JSON, YAML, JSONL the agents read and update during cards.
- **Scripts** — Python (or shell) tools the agents call: parse a blueprint, compact observations, score affinity. Always in `<domain>/scripts/`.

The split matters because **code changes go through the back-office board (`[MR]` review); data flows through normal worker writes on the ops board**. OWNERS reflects this distinction.

---

## Interaction with Hermes memory

Hermes ships its own memory primitive: `~/.hermes/profiles/<agent>/memories/MEMORY.md`. Under the corrected mapping, this is the **agent's continuous memory** — accumulated across cards (across all bots the agent has driven) via the `memory` tool. See [`hermes-v0.15-reference.md`](hermes-v0.15-reference.md#memory) for the system spec.

How memory composes with the workspace layers:

| Layer | Owner | Lifetime | Examples |
|---|---|---|---|
| Hermes `memories/MEMORY.md` | the agent (managed by Hermes) | continuous; compacted by Hermes | "@miner: vein patterns I've seen; iron exhausted at coords X." |
| Card metadata | the agent (per card) | per-card to per-mission | "this card: arrived at (276, 64, 78), inventory delta {iron:+16}" |
| Shared workspace data | the agent (per OWNERS) | indefinite | `geo/vein-database.json` aggregating all bots' observations |
| Shared workspace scripts | `@engineer` (via [MR]) | indefinite, versioned | `geo/scripts/analyze-vein.py` |

**Rule of thumb:**
- *I learned a pattern about my expertise* → Hermes memory (`MEMORY.md`).
- *This specific card produced these results* → kanban completion metadata.
- *Cross-card data my expertise compounds over time* → shared workspace under my domain.
- *Tool I use to do my job* → script under `<domain>/scripts/`; changes go through `[MR]`.

Hermes memory is sovereign — we don't write into `memories/MEMORY.md` from our workspaces. Workers append via the `memory` tool; the tool handles deduplication and compaction.

---

## Lifecycle

### Creation

Profile directories are created by the deploy script at fleet bring-up. `data/workspace/` is created during initial setup with empty domain directories + the OWNERS.yaml + README. `data/bots/<bot>.yaml` is written at bot registration (when a Mineflayer process is added to the fleet).

### Editing

Workers append to `*.jsonl` (no conflict — append-only is safe). Single-writer files use OWNERS to ensure only the owning agent writes. Code changes go through the back-office board's `[MR]` workflow.

### Compaction

`*.jsonl` files accumulate entries from many cards. A maintenance card (bot-less, runs as the agent listed in OWNERS `compact:`) reads the JSONL, dedupes/summarizes, writes a compacted structured file, archives the JSONL. Typical cadence: weekly per domain.

### Archival

Deprecated content moves to `data/workspace/archive/<original-path>`. Git history preserves the full record; the live tree stays uncluttered.

---

## Backup and sync

- **Shared workspace (`data/workspace/`)** — git is the backup. Push to remote regularly. PRs (via `[MR]` cards) give review; the data is essentially diff-reviewable too.
- **Bot registry (`data/bots/`)** — git-backed. Small, stable, infrastructural.
- **Agent Hermes homes** — no backup at the workspace level. `~/.hermes/profiles/<agent>/memories/MEMORY.md` is the most valuable per-agent file; small enough to occasionally snapshot if we want, but Hermes' own session state and provider config is operationally re-creatable.
- **Secrets** — `.env` files (provider keys) live in each agent's Hermes home and **never get committed**. Infrastructure secrets, not workspace artifacts.

---

## The per-bot marks question (resolved)

Today: marks live in `data/locations-<bot>.json` per bot, plus shared `data/locations-base.json` for fleet-wide marks. See [`../specs/world/marks-sign-anchored.md`](../specs/world/marks-sign-anchored.md) for the long-term direction (marks anchored to in-world signs).

**Where do marks live under the new model?**

Recommendation: **leave `data/locations-*.json` where they are.** They predate the agent/bot split and have established consumers (`bot/lib/runtime/locations.js`, `/api/marks`). The `geo/` domain in the shared workspace holds *derived* mark knowledge (audit results, routing cache, trail snapshots) — not the live mark definitions.

Instead:
- `@navigator` (and others) reads `/api/marks` — the bot HTTP API serves marks from the existing files. No workspace dependency on mark definitions.
- `geo/placemark-audit.json`, `geo/routing-cache.json`, `geo/trail-snapshots/` are *derived* artifacts that use marks but don't define them.
- The sign-anchored design (when it lands) replaces `data/locations-*.json` with `server/<world>/placemarks.json` and updates the HTTP API; the workspace consumers don't notice.

Marks stay as a system primitive, not workspace data.

---

## Concrete walkthrough

A `@miner` card on **`pip`** runs at `:mine_nw:`. Files touched:

**Loaded at spawn:**
- `~/.hermes/profiles/miner/SOUL.md` — the miner identity (Hermes auto-loads)
- `~/.hermes/profiles/miner/memories/MEMORY.md` — miner's continuous memory (auto-injected as frozen snapshot)
- `~/.hermes/profiles/miner/skills/agent-miner.md` — bundle body (loaded via `skill_view`)
- `data/bots/pip.yaml` — read by spawn step to inject MC env

**Read during card:**
- Bot HTTP API (`http://localhost:3002`): `/marks`, `/inventory`, `/regions`
- Host data API: `GET /api/workspace/recall/near?subject=iron_ore&type=resource&…`
- Host data API (optional): `GET /api/workspace/recall/hints?subject=iron_ore&type=resource&…`
- Git workspace: `data/workspace/infra/ingest/plans/road-bluff-v4.json` (designed content)

**Write during card (live, via host API):**
- `POST /api/workspace/recall/events` — e.g. `{ "subject": "iron_ore", "type": "resource", "qty": 8, "where": {…}, "who": {…}, "card_id": "t_…" }`; depletion uses `type=depleted`
- `POST /api/workspace/recall/events` — e.g. stock at chest: `{ "subject": "chest_iron", "type": "resource", "qty": 32, "where": {…}, "who": {…} }` (mark name without colons)
- Bot-side marks/chest snapshots unchanged (`mc mark`, deposit/withdraw) for committed coords and container cache

**Write on completion:**
- Card completion metadata (Hermes kanban) — `{inv_delta, exit_pos, marks_updated}`
- Optionally: agent `MEMORY.md` — narrative cross-bot learning (not a substitute for recall queries)

**Later (compaction card, bot-less, weekly):**
- A `[COMPACT] geo` card reads `GET /api/workspace/recall/events?since=<watermark>&subject=…&type=resource`, aggregates clusters, writes `data/workspace/geo/generated/worksites.json`, commits to the back-office branch, archives pre-watermark rows to `data/workspace/archive/recall/<year-week>.jsonl.gz`.

**Later (back-office, `[BUG]` discovered):**
- @miner observes `analyze-vein.py` misclassifies a yield → files `[BUG]` on `landfolk-backoffice`
- @engineer claims, spawns in worktree, fixes `geo/scripts/analyze-vein.py`, files `[MR]`
- @overseer reviews diff, approves, merges
- Next maintenance card uses the new analyze-vein.py

---

## Current state → target mapping

The current implementation is overwhelmingly **per-bot JSON files + bot HTTP API + ctx slices**. The target **adds** a host recall store and ops endpoints; committed marks/chest/regions stay on bots until explicitly migrated. Git holds audited/designed content and compacted recall snapshots. Concretely:

| Today (per-bot files, bot APIs, ctx) | Target |
|---|---|
| `data/locations-<bot>.json`, `data/locations-base.json` | **Stay on bot HTTP** for committed marks; reconciler keeps base; compaction may audit → `geo/generated/placemark-audit.json` |
| `data/chest-snapshots-<bot>.json` | Per-bot files stay; fleet rollup scripts / optional git `production/generated/stockpiles.json` from compaction |
| `data/personal-pois-*.json` | Bot APIs stay; recall can use POI name as `subject`; compaction → `geo/generated/pois.json` |
| `data/goals-<bot>.json` | Definitions → git ingest; live metrics still from bot; optional recall when goals reference resource `subject` tokens |
| `data/regions-<world>.json` | Git ingest + bot reload; enforcement on bot, not host entity mirror |
| `data/reminders-<bot>.json` | Bot-local; no host API requirement |
| `/tmp/hermescraft/nav-<bot>.jsonl` | Playbook/card action telemetry; separate from **recall** stream |
| (new) cross-bot “saw iron here” | **`POST /api/workspace/recall/events`** — primary new persistence |
| `scripts/reconcile-marks.py`, `scripts/reconcile-pois.py` | Keep until recall + compaction cover fleet mark/POI workflows; logic may move incrementally |
| `data/agent-models.json`, `data/agent-registry.json` | → `data/bots/<bot>.yaml` + per-agent profile configs |
| `~/.hermes/kanban/boards/landfolk-ops/kanban.db` | Stays (Hermes owns); plus `landfolk-backoffice` for code/plan PRs |

**Migration order (sketch):**
1. Host API skeleton + `recall` append/query + Hermes `recall.report` / `recall.near`.
2. `@planner` / `@dispatcher` inject recall hits into cards when task text maps to `subject` + `type` (keyword table).
3. Migrate `@dispatcher` fleet-state writes to `/operations/*`.
4. Compaction cards: recall → `geo/generated/*.json` + archive.
5. Optional phase 2: spatial catalog in API if hints + marks are insufficient.

---

## Open questions

1. **OWNERS.yaml enforcement** — pure convention (documentation), or wire it into the back-office MR review as a lint check (PR rejected if non-owner writes to a `write:` path)? Lean: convention for MVP, lint when `@engineer` ships.
2. **Back-office board name** — `landfolk-backoffice`, `landfolk-dev`, `landfolk-meta`? Whatever, pick one.
3. **Worker → branch convention** — auto-generated (`hermes/<hash>`) per Hermes `-w`, or named (`fix/calc-materials-tilt`) per card metadata? Named is more readable; auto is simpler. Probably named for `[BUG]`/`[FEAT]` cards, auto for ad-hoc.
4. **Merge mechanics** — `@overseer` runs `git merge` directly when approving, or does `@engineer` rebase and the operator triggers merge? Lean: `@overseer` merges for low-risk; operator approves for `runbooks/`, `infra/plans/`, and `operator-approval` flagged paths.
5. **Migration of per-bot memory** — today's `~/.hermes/profiles/flint/memories/MEMORY.md` holds bot-specific notes. Under the new model, that content distributes across agent memories (per role) or gets dropped if it was scoped to "things flint knows that nobody else needs." Plan for this when retiring today's bot profiles.
6. **Bot-specific transient state** — when a bot needs file-backed transient state ("currently mining at Y=44"), does it go in `data/bots/<bot>/` or in card metadata? Lean: card metadata for everything that crosses cards; `data/bots/<bot>/` only for things that need a stable filesystem location (rare).
7. **Cross-domain artifacts** — when something doesn't fit one of the five domains, that's a signal a domain is missing or needs splitting. Don't force-fit; add a domain.
8. **Marks under sign-anchored** — when sign-anchored placemarks land, the workspace consumers don't notice. The decision above pre-validates this.

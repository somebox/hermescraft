# Steward MVP — Hermes kanban orchestrator (headless)

Headless `steward` Hermes profile on board **`landfolk-ops`**: surveys base state, decomposes coarse intents into finite ops cards, and routes work to `flint`, `gatherer`, and `mason`. Phase 2 regression stays on the **`default`** board.

## Topology (local Hermes, remote Minecraft)

Three different “Hermes” and two network hops are easy to conflate:

| Layer | Where it runs | What it talks to |
|-------|----------------|------------------|
| **Paper / gameplay world** | `ubuntu-host` **192.168.1.202:25565** | (authoritative world) |
| **Mineflayer bot body** | Your laptop `127.0.0.1:<API_PORT>` (e.g. 3001 for Steve) | Minecraft protocol → **192.168.1.202:25565** |
| **Steve agent** (`run-steve.sh`) | Laptop foreground Hermes; sessions in `~/.hermes-landfolk-steve/` | `mc` → **localhost:3001** → bot → LAN server |
| **Kanban + steward workers** | Laptop `~/.hermes/` (profiles, `kanban/boards/landfolk-ops/`) | Same pattern: `MC_API_URL=http://localhost:<port>` must point at a **local** bot that is connected to **192.168.1.202** |
| **Container Hermes** (optional) | `ubuntu-host:8642` | Non-Minecraft work; **not** the Steve / landfolk-ops path |

So: **Hermes and kanban are always local.** The **server is always remote** (unless you run Paper on the laptop). `MC_HOST` / `MC_PORT` on the bot process select the world; `MC_API_URL` on Hermes profiles selects which local HTTP bot API to drive.

**Steve-only testing:** one body on `:3001` (`scripts/run-steve.sh`, default `MC_HOST=192.168.1.202`). Kanban workers assigned to `flint` / `mason` only work if their profile `.env` uses that same `MC_API_URL` (or you run separate bot processes on 3002, 3003, each with `MC_USERNAME` matching the in-game name). Do not run a long-lived Steve agent and a kanban worker against the same port at the same time unless you accept them fighting for the body.

**Multi-bot (intended cast):** `data/agent-models.json` maps Gatherer→3001, Flint→3002, Mason→3003, each bot launched with `MC_HOST` pointing at **192.168.1.202**. Kanban dispatch then spawns `hermes -p flint` etc. with matching `MC_API_URL`.

## Solo Flint ops (testing mode)

Use this when only **one** Mineflayer body is up (Flint on **`:3002`**) and you want kanban to drive the world without running Gatherer/Mason bots or the long-lived Landfolk agent on the same port.

Hermes kanban does **not** check who is online in Minecraft. Auto-decompose routes from **profile descriptions** only. If gatherer/mason still read like active workers, the gateway will spawn `hermes -p gatherer` / `hermes -p mason` against dead `MC_API_URL` ports. Solo mode fixes routing and process ownership.

### One-time / after re-bootstrap

```bash
scripts/setup-landfolk-profiles.sh --solo-flint
```

That sets decomposer-facing descriptions so in-world work should land on **`flint`** only (see script for exact strings). Confirm Flint worker env:

```bash
grep MC_ ~/.hermes/profiles/flint/.env
# expect MC_API_URL=http://localhost:3002 and MC_USERNAME=Flint
grep MC_ ~/.hermes/profiles/steward/.env
# solo-flint: steward read-only mc uses the same body (3002), not 3001
curl -s http://127.0.0.1:3002/health | python3 -m json.tool
```

`scripts/setup-landfolk-profiles.sh --solo-flint` sets steward `MC_API_URL` to `:3002` when the flag is used (or patches an existing `MC_API_URL` line).

### Body vs agent (do not fight for `:3002`)

| Process | Purpose | Session / logs |
|---------|---------|----------------|
| **Bot** (node, `:3002`) | Mineflayer body connected to **192.168.1.202:25565** | `/tmp/hermescraft/bot-flint.log` (via `landfolk-control`) |
| **Landfolk agent** (`landfolk-control.sh start --profiles flint`) | Continuous goals, `~/.hermes-landfolk-flint/` | `scripts/watch-agent.py --agent flint` |
| **Kanban worker** (`hermes -p flint`, dispatcher-spawned) | One task on `landfolk-ops`, `~/.hermes/profiles/flint/` | `hermes kanban --board landfolk-ops log <task_id>` or `scripts/watch-agent.py --profile flint` |

For kanban testing: keep the **bot running**, stop the **Landfolk agent + watchdog** so only the kanban worker uses `mc` on that port.

Tail the active Flint worker:

```bash
scripts/watch-agent.py --profile flint --tail 30    # kanban one-shot workers (solo ops)
scripts/watch-agent.py --agent flint --auto --tail 30   # pick landfolk vs kanban by newest session
```

`--agent flint` alone follows **Landfolk** sessions in `~/.hermes-landfolk-flint/` — not the kanban worker during solo ops.

```bash
# Example: stop agent/watchdog only (bot pid file under /tmp/hermescraft/landfolk-control/)
for kind in watchdog agent; do
  pf="/tmp/hermescraft/landfolk-control/${kind}-flint.pid"
  [ -f "$pf" ] && kill "$(cat "$pf")" 2>/dev/null; rm -f "$pf"
done
./scripts/landfolk-control.sh status --profiles flint
# expect [bot] RUNNING, [agent] STOPPED
```

Do **not** run `./scripts/landfolk-control.sh start --profiles flint` while kanban workers are active unless you intend to pause ops and return to continuous Landfolk mode.

#### Bot-only restart (when you need to reload bot code mid-experiment)

`landfolk-control.sh start --profiles flint` always launches **bot + agent + watchdog** — there is no `--bot-only` flag yet. Doing a full restart to pick up new bot code (e.g. after a patch to `bot/lib/actions/...`) will silently re-enable the continuous agent and let it fight the kanban worker on `:3002`. The lock state desyncs: gateway sees a running worker that's actually dead, the held claim stays valid until lease expiry, no new dispatch tick spawns a fresh worker.

The recipe that worked 2026-05-24:

```bash
# 1. Reclaim any actively-locked tasks so they're free to re-dispatch.
hermes kanban --board landfolk-ops reclaim <task_id> --reason "restart bot for fix"

# 2. Full landfolk stop (kills bot + agent + watchdog).
./scripts/landfolk-control.sh stop --profiles flint

# 3. Full landfolk start — brings everything back.
./scripts/landfolk-control.sh start --profiles flint

# 4. IMMEDIATELY tear down the agent + watchdog the start re-spawned,
#    leaving only the freshly-restarted bot.
for kind in watchdog agent; do
  pf="/tmp/hermescraft/landfolk-control/${kind}-flint.pid"
  [ -f "$pf" ] && kill "$(cat "$pf")" 2>/dev/null; rm -f "$pf"
done
./scripts/landfolk-control.sh status --profiles flint   # expect [bot] RUNNING, [agent] STOPPED, [watchdog] STOPPED

# 5. Force a dispatch tick so the gateway picks up the freed task on the patched bot.
hermes kanban --board landfolk-ops dispatch
```

If you skip step 4 the worker WILL spawn but it'll race the continuous landfolk agent for the bot — both will try to drive `mc move`, lock contention shows up as "no apparent progress" on the kanban card with no error logs to explain it.

### Gateway, triage, and dispatch

| Action | What runs |
|--------|-----------|
| `hermes gateway start` | Periodic **decompose** (triage → child graph) + **dispatch** (spawn ready tasks) |
| Dashboard **Nudge dispatcher** | One **dispatch** pass only — does **not** decompose triage by itself |
| `hermes kanban --board landfolk-ops decompose <id>` | Manual fan-out when gateway is off or you do not want to wait |

Typical loop:

```bash
hermes gateway start
hermes kanban --board landfolk-ops list
# triage epic → wait for auto_decompose, or:
hermes kanban --board landfolk-ops decompose <task_id>
hermes kanban --board landfolk-ops dispatch --dry-run
```

Hermes dashboard (kanban UI): **http://127.0.0.1:9119**. HermesCraft command center: **http://127.0.0.1:3000** — different apps.

### One body, many cards (serialize work)

Decompose often creates **parallel** children (survey + craft at once). With one Flint body, dispatch must not spawn multiple `hermes -p flint` workers on the same `MC_API_URL`.

After decompose, either:

1. **Parent links** so only one child is `ready` at a time (`hermes kanban link <parent_id> <child_id>` — child waits until parent is `done`), or  
2. **Single ready card** — create one `[SUPPLY]` / `[EPIC]` card already assigned to `flint` with a full YAML body (no fan-out).

Fix wrong assignees on an existing graph:

```bash
hermes kanban --board landfolk-ops reassign <task_id> flint --reclaim --reason "solo-flint"
hermes kanban --board landfolk-ops link <parent_id> <child_id>
hermes kanban --board landfolk-ops dispatch
```

### Resume testing checklist

1. Bot healthy: `curl -s http://127.0.0.1:3002/health` → `"connected": true`.  
2. Landfolk **agent** stopped (see above); gateway running if you want auto-decompose.  
3. Board state: `hermes kanban --board landfolk-ops list` — at most one `running` flint task.  
4. Tail worker: `hermes kanban --board landfolk-ops log <task_id>`.  
5. After completions: `python3 scripts/ledger-update.py --dry-run` (when cards include ledger metadata).

**In-flight example (2026-05-23):** wheat-farm epic decomposed to survey → craft → prep → harvest, all on `flint`, chained with `link`. Parent epic `t_1fdfd13b` stays `todo` on **steward** until children finish.

### Where Minecraft-specific decomposition rules live

Worker SOULs (`flint`, `mason`, `gatherer`) stay slim — they follow whatever's in the card body. The Minecraft-specific decomposition smarts (pre-mining checklists, supply-precursor creation, descent-method hints) live in two places:

- **`profiles/steward/skills/gaming/minecraft-steward-survey/SKILL.md`** — orchestrator-mode section covers craft/build prerequisites and safer-mining card YAML schemas. The steward consults this when decomposing.
- **`~/.hermes/skills/gaming/minecraft-mining/SKILL.md`** — on-demand worker playbook. Steward references it in supply-card `action_sequence` via `skill_view minecraft-mining`, so workers only pay the token cost on cards that need it.

Postmortem driving these splits: [reports/expedition/2026-05-24-flint-iron-mining-deep-shaft.md](../../../reports/expedition/2026-05-24-flint-iron-mining-deep-shaft.md).

### Future: steward gets its own bot body

Today the steward is headless — it surveys via `MC_API_URL=:3002` (Flint's body) in read-only mode, which works for `mc logistics` / `mc chest_search` / `mc nearby` but means the steward can't be in two places at once and can't chat in-game.

A natural extension is **steward on its own port** (e.g. `:3000` for Steward, `:3002` Flint, `:3003` Mason, `:3001` Gatherer). The benefits would be:

- **Real observation before fan-out** — the steward can `mc nearby` / `mc scene` near the actual work site before deciding whether a precursor `[SUPPLY]` is needed. Today it has to guess from `mc chest_search`.
- **In-game presence** — steward can chat `<Steward> assigning iron mining to Flint` so re44 sees what the orchestrator decided without checking the dashboard.
- **Per-card location anchoring** — survey cards can use the steward bot's position as the survey origin, instead of inferring from Flint's last-known pos.

Open questions before shipping:
- Bot username conflict: `Steward` isn't on the whitelist; need rcon `whitelist add Steward` and an entry in `data/agent-models.json`.
- Read-only enforcement: the steward's profile must NOT have `mc dig`/`mc place`/etc. in its allowed verb list. The existing `minecraft-steward-survey` skill lists read-only verbs but doesn't restrict the underlying body API. Need either a `mc_readonly_mode` flag on the bot or a profile-level allowlist enforcement.
- Cost: an idle bot body still consumes a Mineflayer connection slot on the Paper server (`max-players` is 10; currently using 4 — Flint, Steve, re44, Tester).

### Switch back to multi-bot cast

Re-run setup **without** `--solo-flint`, start bots on 3001/3002/3003 (`./scripts/landfolk-control.sh start --profiles flint,gatherer,mason`), align each profile `.env` `MC_API_URL` / `MC_USERNAME` with `data/agent-models.json`, and avoid overlapping Landfolk agents with kanban workers on the same port.

## Bootstrap

```bash
scripts/setup-landfolk-profiles.sh          # flint, gatherer, mason, steward + ops board + kanban config hints
scripts/setup-landfolk-profiles.sh --solo-flint   # decomposer routes in-world work to flint only (see above)
scripts/setup-landfolk-profiles.sh --dry-run
hermes gateway start                        # dispatcher picks up ready tasks
```

After bootstrap, verify:

```bash
hermes kanban boards list
hermes -p steward skills list | grep -E 'kanban-orchestrator|minecraft-steward-survey'
hermes profile list
```

## Boards

| Board | Purpose |
|-------|---------|
| `default` | Phase 2 capability/behavior tests, bug cards |
| `landfolk-ops` | In-world ops: supply, store, patrol, region (schema), epic |

Workers only see tasks on the board pinned in `HERMES_KANBAN_BOARD` at spawn time.

## Hermes kanban config

Add or merge into `~/.hermes/config.yaml`:

```yaml
kanban:
  orchestrator_profile: steward
  default_assignee: steward
  auto_decompose: true
  auto_decompose_per_tick: 3
```

Profile descriptions (used by the decomposer) are set by the setup script via `hermes profile describe`.

## Ops card catalog

Title prefixes are strict so humans and scripts can filter the board.

| Type | Title prefix | Default assignee | Dispatchable |
|------|-------------|------------------|--------------|
| `survey` | `[SURVEY]` | `steward` | yes |
| `supply` | `[SUPPLY]` | `flint` or `gatherer` (by item) | yes |
| `store` | `[STORE]` | `mason` | yes |
| `patrol` | `[PATROL]` | `flint` or `gatherer` | yes |
| `region` | `[REGION]` | `steward` or `human` | yes / no for human |
| `epic` | `[EPIC]` | `steward` | yes (decompose parent) |
| `region` | `[REGION]` | `flint` (worker) | yes |

Epic bodies for region work live under [`data/ops/`](../../data/ops/) (`epic-base1-body.yaml`, `epic-wheat1-body.yaml`). Create with:

```bash
hermes kanban --board landfolk-ops create "[EPIC] protect base as :base1:" \
  --triage --assignee steward --body "$(cat data/ops/epic-base1-body.yaml)"
hermes kanban --board landfolk-ops decompose <task_id>
```

Solo Flint: link region children into the existing wheat chain (`craft → base create → base verify → prep → harvest → :wheat1: marker → verify`).

### Card body schemas

Every ops card body is YAML in the task description (Hermes `body` / `--body`).

**Common fields**

```yaml
kind: survey | supply | store | patrol | region | epic
board: landfolk-ops
world: world                    # production; never landfolk-test for ops
strict: true | false            # true = no off-spec "improvements" (see experiment 1.4)
```

**`survey`**

```yaml
kind: survey
interval: hourly
floors:
  cobblestone: { target_min: 128, chest_mark: base_chest }
  food_score: { target_min: 48 }
regions_to_check: []            # future: :base: ids when regions ship
ledger_snapshot_task_id: null   # optional pointer for ledger-update.py
```

**`supply`**

```yaml
kind: supply
item: cobblestone
count: 64
source_site: ":base1:/mine_entrance"   # region site ref; falls back to coords
source_coords: [368, 57, -590]         # literal coords drive action_sequence
deadline_tick: null
assignee_rationale: "miner item"
success_predicate:
  - { kind: inventory_contains, item: cobblestone, count: ">=64" }
action_sequence:
  - mc goto_near 368 57 -590 4
  - mc collect stone 64
evidence_required:
  - inventory_delta in kanban_complete.metadata
```

**`store`**

```yaml
kind: store
item: cobblestone
count: 64
chest_mark: base_chest          # name in data/marks/canonical.yaml (informational)
chest_coords: [365, 65, -593]   # literal coords drive action_sequence
depends_on_supply: true         # dispatcher parent link to [SUPPLY] card
success_predicate:
  - { kind: chest_contains, chest_coords: [365, 65, -593], item: cobblestone, count: ">=64" }
action_sequence:
  - mc goto_near 365 65 -593 3
  - mc deposit cobblestone 64
evidence_required:
  - chest_state in kanban_complete.metadata
```

**`construct`** (build inside a protect region — requires worksite grant)

```yaml
kind: construct
worksite: hut3                    # bare id; worker runs mc task_context set hut3
anchor: [370, 65, -608]
materials_site: ":base1:/chest"   # region site ref; coords below drive actions
materials_coords: [365, 65, -593]
success_predicate:
  - { kind: region_contains_structure, worksite: hut3, note: "floor layer placed" }
action_sequence:
  - mc task_context set hut3
  - mc goto_near 370 65 -608 3
  - mc place_fill cobblestone 368 64 -610 372 64 -606
evidence_required:
  - observed_state.skipped_region == 0
```

**`patrol`**

```yaml
kind: patrol
sector_bounds: { x: [0, 48], y: [60, 80], z: [0, 48] }
until: dawn | tick:29000 | manual_unblock
engage_policy: reactive_only    # MVP: rely on reactive layer; no mc engage required
max_runtime: 15m
```

**`region`** (see [designated-regions.md](../../features/designated-regions.md); ops cards use `mc region create` / site refs)

```yaml
kind: region
action: create | remove | audit
region_id: ":mine2:"
profile: mine | protect | base
geometry: { r: 24, y: "64..80" }
intent: resource
```

**`epic`**

```yaml
kind: epic
intent: "stockpile 64 cobble in base_chest"
acceptance:
  - base_chest cobblestone count increases by 64
decompose_hint:
  - supply cobblestone x64 → flint
  - store cobblestone x64 → base_chest → mason (parent: supply)
```

### Worker `kanban_complete` metadata (ops)

```yaml
result: PASS | FAIL
summary: "one-line"
metadata:
  kind: supply | store | survey
  inventory_delta: { cobblestone: 64 }
  chest_state:
    chest_mark: base_chest
    chest_coords: [365, 65, -593]
    item: cobblestone
    count_after: 448
    delta: +64
  ledger_hint: {}               # optional; folded by scripts/ledger-update.py
```

See [protocols.md](../phase-2/protocols.md) §10 for chest accounting conventions.

## Logistics ledger

File: [`data/ops/logistics-ledger.yaml`](../../data/ops/logistics-ledger.yaml)

Updated by [`scripts/ledger-update.py`](../../scripts/ledger-update.py) from completed ops-board tasks (not written directly by the steward profile — orchestrator has no file tool).

```yaml
last_updated: null
chests: {}
floors: {}
processed_run_ids: []           # idempotency for poller
```

Run manually or from cron after worker completions:

```bash
python3 scripts/ledger-update.py
python3 scripts/ledger-update.py --dry-run
```

## Hourly survey (cron)

Enable on the host that runs `hermes gateway`:

```bash
hermes cron add steward-survey-hourly \
  'hermes kanban --board landfolk-ops create "[SURVEY] hourly" --assignee steward --triage --max-runtime 5m --idempotency-key "survey-$(date -u +%Y-%m-%dT%H:00)"'
```

Disable: remove the cron entry via `hermes cron list` / `hermes cron rm <id>`.

The survey worker reads floors from the card body and `data/ops/logistics-ledger.yaml` (via `kanban_comment` / parent metadata after ledger-update). When all floors are met, complete with `summary="no action needed"`.

## Smoke test (MVP acceptance)

**Multi-bot path:** bot bodies for flint and mason on production `world`. Card bodies drive `action_sequence` from literal coords; mark names in [`data/marks/canonical.yaml`](../../data/marks/canonical.yaml) (e.g. `base_chest`, `mine_entrance`) are documentation only — there is no runtime sync, so workers fall back to coords if a private mark hasn't been set. Region site refs (`:base1:/chest`) are preferred when the protect region is set up.

1. `hermes kanban --board landfolk-ops create "stockpile 64 cobble in base_chest" --triage --assignee steward`
2. Wait for decompose (or `hermes kanban decompose <id>`) → `[SUPPLY]` + `[STORE]` children.
3. `hermes kanban dispatch` or gateway tick → flint then mason workers.
4. `python3 scripts/ledger-update.py`
5. Confirm `data/ops/logistics-ledger.yaml` reflects chest counts.

**Solo Flint path:** `--solo-flint` setup, Flint bot on `:3002`, Landfolk agent stopped, gateway on. Same triage epic or a single `ready` card assigned to `flint` with supply/store YAML in the body. Use `link` to serialize multi-step epics; see [Solo Flint ops](#solo-flint-ops-testing-mode).

Record outcomes in [`docs/archive/experiments/phase-3-steward-mvp.md`](../../archive/experiments/phase-3-steward-mvp.md).

## Out of scope (MVP)

- Steward Mineflayer body and in-game `[STEWARD]` chat (see G21 orchestrator).
- Automated region creation (`mc region create`).
- `/goal` standing goals on steward (cron + survey instead).
- Logistics rule engine (appendix A4).

## References

- [Phase 2 protocols §11](../phase-2/protocols.md) — human-as-steward (this automates ops half)
- [Phase 2 appendix A1/A4](../phase-2/appendix.md)
- [Experiment 1.4](../../archive/experiments/1.4-kanban-minecraft.md)
- [Hermes Kanban overview](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)
- [Kanban worker lanes](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes)

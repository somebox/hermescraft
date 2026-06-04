# Establish operator runbook

Single checklist for **proc-lab establishment runs** with the landfolk fleet. Covers two missions on the same bootstrap pipeline:

- **`establishment.explore`** (default) — fleet patrols, Steward picks a base, Mason builds a 9×9 cobble pad. Process grade: `scripts/establish-check.py`.
- **`establishment.mapping`** — fleet ranges a 64-block arena, names landmarks with in-world signs, drops POIs at internal nav waypoints. Steward judges coverage. Process grade: `scripts/establish-mapping-check.py`.

`VARIANT=establishment.<terrain>` is the single source of truth — `MISSION` is derived from the suffix (`explore` or `mapping`) and threaded through `establish-scenario.sh` → `establish-rcon-prep.py` → `establish-seed-cards.py`. Don't set `MISSION=` directly; the override path is gone (it used to allow `MISSION=mapping VARIANT=establishment.explore` mismatches).

**Related:** [procedural-testing-model.md](../features/procedural-testing-model.md), [procedural-bench-ops.md](procedural-bench-ops.md), [architecture-audit.md](../../data/postmortems/establish-2026-06-03-phase10/architecture-audit.md), `prompts/landfolk/establish-epic.md`, `skills/minecraft-mapping.md`.

**Do not mix** `scripts/genesis.sh` (campaign world + genesis kanban) with this proc-lab loop unless you intend to.

---

## One command (recommended)

From repo root (uses Homebrew `bash`/`python` when needed):

```bash
# Full path: tests + deploy + cleanup + bootstrap + verify (explore mission, default)
scripts/establish-run.sh --min-credits-usd 5

# Fresh proc-lab disc + clean log dir
RUN_ID=phase12 scripts/establish-run.sh --fresh-disc 1001 --archive-logs

# Re-bootstrap only (code already deployed, tests green)
scripts/establish-run.sh --skip-preflight

# Mapping mission instead (signs + POIs + dusk lighting, 64-block arena)
VARIANT=establishment.mapping scripts/establish-run.sh --fresh-disc 1001 --archive-logs
```

| Step | Script (if run piecemeal) |
|------|---------------------------|
| Preflight | `scripts/establish-preflight.sh [--min-credits-usd N]` (tests + deploy; **no** live diagnostics by default) |
| Stop + kill orphans | `scripts/establish-fleet-cleanup.sh` (also stops the dashboard if it was auto-started) |
| Bootstrap | `scripts/establish-scenario.sh` (bash 5+, gateway + kanban dispatch) |
| Launch gate | `scripts/establish-launch-verify.sh` |
| Dashboard | Auto-started by `establish-run.sh` after launch-verify (skip with `--no-dashboard` or `SKIP_DASHBOARD=1`). Manual: `./start-dashboard.sh --world proc-lab`. PID at `/tmp/hermescraft/dashboard.pid`; log at `/tmp/hermescraft/dashboard.log`. |
| Stop + archive | `establish-fleet-cleanup.sh` stops dashboard then fleet and snapshots logs first; or `landfolk stop` then `scripts/snapshot-fleet-logs.sh <pm-dir>` |
| Grade | `scripts/establish-check.py` (explore) or `scripts/establish-mapping-check.py` (mapping) |

---

## 1. Script index

| Script | Role |
|--------|------|
| `scripts/establish-run.sh` | **Operator entry** — preflight → cleanup → optional fresh disc → scenario → launch verify |
| `scripts/establish-preflight.sh` | Tests, deploy, toolchain, optional OpenRouter balance; diagnostics only with `--with-diagnostics` (advisory) |
| `scripts/establish-fleet-cleanup.sh` | `landfolk stop` + `pkill landfolk:` + free bot HTTP ports |
| `scripts/establish-launch-verify.sh` | Post-bootstrap: terrain, progress `pos`, steward 403, dispatcher |
| `scripts/establish-scenario.sh` | Bootstrap (memory, map, materialize, RCON, gateway, bots, kanban, terrain verify) |
| `scripts/establish-check.py` | Post-run **process grade** for explore mission (pad cobble, explores, epic) |
| `scripts/establish-mapping-check.py` | Post-run **process grade** for mapping mission (POI count, sign count, coverage radius, quadrant coverage, `[MAP:ARENA]` epic state) |
| `scripts/reconcile-pois.py` | Merge per-bot `personal-pois-<bot>.json` into `personal-pois-shared.json` (mapping mission; tie-break by most-recent `last_seen`) |
| `scripts/establish-rcon-prep.py` | Peaceful world + starter chest + `tp_workers` (called by bootstrap). `--mission mapping` swaps chest NBT (16 signs + 64 torches + 32 coal), starter kit (4 signs + 16 torches), and lighting (dusk: `time set 13000` + `gamerule doDaylightCycle true`). |
| `scripts/establish-materialize.py` | `mapcatalog try` for chosen map JSON |
| `scripts/establish-seed-cards.py` | Kanban epic + four worker cards from map. `--mission explore` (default): `[ESTABLISH:BASE]` epic + four `[EXPLORE]` cards. `--mission mapping`: `[MAP:ARENA]` epic + four `[MAP]` quadrant cards. |
| `scripts/establish-bootstrap-verify.py` | Optional: fail bad `terrain=unknown` at muster (ports from `data/agent-models.json`) |
| `scripts/reset-proc-lab.py` | Evac bots, delete/recreate **proc-lab** MV world (clean disc) |
| `scripts/scenario-pools.sh` | `lint` / `list` / `refresh` / `map <variant>` for catalog |
| `scripts/landfolk` | `start` / `stop` / `restart` / `deploy` / `diagnostics` / `status` / `logs` |
| `scripts/landfolk-control.sh` | Low-level bot + agent loops (bootstrap calls `start`) |
| `scripts/kanban` | Board orient (`board`, `card`, …) |
| `scripts/genesis_lib.py` | `archive_run_state` + `reinit_kanban_board` (used inside bootstrap) |
| `scripts/reconcile-marks.py` | Merge fleet marks into `data/locations-base.json` |
| `scripts/snapshot-fleet-logs.sh` | Copy `/tmp/hermescraft` → postmortem dir at fleet stop |
| `scripts/patch-landfolk-compression-config.py` | Cap context + aggressive compression on Hermes `config.yaml` (deploy + each agent start) |
| `scripts/auto-stuck-check.py` | PR-S stuck detection (invoked from watchdog) |
| `scripts/fleet-status.py` | Optional one-screen fleet snapshot |
| `server.local.yaml` | Mapcatalog profile: world name, SSH/RCON, `reuse_seed`, evac list |

**Log root (default):** `LOG_DIR=/tmp/hermescraft` (see `scripts/landfolk-control.sh`).

| Log | Contents |
|-----|----------|
| `agent-<profile>.log` | Hermes reasoning + tool transcript |
| `progress-<profile>.log` | Watchdog + agent-loop JSONL (`recent`, `pos`) |
| `watchdog-<profile>.log` | Watchdog lifecycle |
| `mc-<profile>.log` | CLI audit (`FAIL_DETAIL`). **Known gap (G4):** when a bot listener is killed and restarted, this file STOPS at the pre-restart timestamp and the new session never appends. Afternoon tool failures live only in `agent-*.log`, `nav-*.jsonl`, `progress-*.log`, and `~/.hermes/profiles/<bot>/state.db` (post-WAL flush). Always snapshot before `landfolk stop` if you need the CLI audit trail. |
| `nav-<Profile>.jsonl` | Structured nav errors |
| `bot-<profile>.log` | Mineflayer connection/chat |
| `dispatcher.log` / `gateway.log` | Kanban dispatch (when gateway running) |
| `data/runtime/last-establish-map.json` | Map JSON used for last bootstrap |

---

## 2. Preconditions

| Item | Check |
|------|--------|
| Repo | On intended commit; uncommitted bot/SOUL fixes **do not** apply until deploy + bot restart |
| **Bash** | **5.0+** required. macOS default `/bin/bash` is 3.2 and crashes `establish-scenario.sh:182` (`declare -A WORKER_PORTS`) and `landfolk-control.sh stop` (`${name,,}` lowercasing). Use `/opt/homebrew/bin/bash` — invoke explicitly or put it first on PATH. Verify: `bash --version` reports `5.x`. |
| **Python** | **3.11+** required. `scripts/agent-test.py` uses PEP 604 `str \| None` syntax which fails on macOS system `/usr/bin/python3` (3.9). Use `/opt/homebrew/bin/python3` (3.11/3.12/3.14) or repo `.venv`. Verify: `python3 --version` reports `3.11+`. `pip install -e .` + PyYAML for mapcatalog. |
| `server.local.yaml` | Copy from `server.local.yaml.example`; `world.name: proc-lab` |
| Minecraft | Server reachable; RCON/SSH per profile (homelab: `ssh` + `docker exec … rcon-cli`) |
| Hermes | `hermes` on PATH (`/Users/foz/.local/bin/hermes` on this rig); keys in `$HOME/.hermes/.env` or env |
| Models | `data/agent-models.json` ports: Gatherer 3001, Flint 3002, Mason 3003, Barley 3004, Steward 3005. **Steward stays on `deepseek/deepseek-v4-flash:exacto`** — run-11 evidence: `:pro` tier produced `exit=142` (SIGPIPE) on round=1 and never reassigned EXPLORE cards. Orchestrator role doesn't need the depth bump. |

### 2.1 OpenRouter credits (before a long run)

Agents bill per token. Check **before** bootstrap so mid-run starvation does not look like agent failure.

**Key resolution order:** `OPENROUTER_API_KEY` env → `secrets.yaml` → `openrouter_api_key:`.

```bash
# Quick balance (credits endpoint)
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$(grep -E '^openrouter_api_key:' secrets.yaml 2>/dev/null | sed 's/.*: *//;s/"//g')}"
curl -s "https://openrouter.ai/api/v1/credits" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" | python3 -m json.tool

# Per-key limit / daily usage (preferred when using a named key)
curl -s "https://openrouter.ai/api/v1/key" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" | python3 -m json.tool
```

Also visible on the [dashboard](dashboard.md) header when `OPENROUTER_API_KEY` or `secrets.yaml` is configured.

**Rule of thumb:** if `limit_remaining` (or credits minus usage) is near zero, top up or switch models before starting a 60–90 minute establish replay.

### 2.2 Minecraft server

```bash
# Example homelab (adjust host/container to your install)
ssh ubuntu-host 'sudo docker exec -i minecraft rcon-cli list'
```

Server must load **proc-lab** (or your configured MV world) and accept bot accounts (Gatherer, Flint, Mason, Steward, …).

---

## 3. Hermetic gate (run before bootstrap)

Wrapped by `scripts/establish-preflight.sh` (or `establish-run.sh`). Skip with `--skip-preflight` only when you already ran preflight this session.

Default preflight runs **bot** tests (nav brief, goto_near timeout contract, scene canopy, orchestrator mc gate) and **python** unittest modules (`test_auto_stuck_check`, establish RCON/reset, orchestrator allowlist/deny hooks, kanban worker context, compression patch), then `scripts/landfolk deploy`. It does **not** run the full `npm test` suite.

---

## 4. Choose world, seed, and map

| Decision | How |
|----------|-----|
| **World** | **`proc-lab`** only for this runbook (MV scratch world). Campaign worlds (`landfolk-test`, `world`) are not deleted by mapcatalog. |
| **Variant** | `establishment.explore` (default) or `establishment.mapping`. Set with `VARIANT=…`; `MISSION` derives from the suffix and is threaded through bootstrap. Mapping uses a 64-block arena (4× explore) with biome-count / height-jitter / surface-grass gates replacing the explore stone-band gate. |
| **Seed** | Picked by catalog: `scripts/scenario-pools.sh map establishment.explore` writes JSON with `seed`, `spawn`, `muster`, `starter_chest`. |
| **Pin seed** | `TRY_SEED=<n>` on materialize paths, or `python3 scripts/reset-proc-lab.py --seed <n>` then bootstrap with matching catalog entry. |
| **Reuse loaded seed** | `AUTO_REUSE=1` (default): skip `mapcatalog try` if `data/runtime/proc-lab-state.json` matches. |
| **Force rebuild disc** | `AUTO_REUSE=0` or run `reset-proc-lab.py` first. |

Refresh catalog after changing requirements:

```bash
scripts/scenario-pools.sh lint
scripts/scenario-pools.sh refresh --only establishment.explore -s server.local.yaml
scripts/scenario-pools.sh map establishment.explore | tee /tmp/establish-map.json
```

Inspect: `seed`, `placements.spawn`, `muster`, `starter_chest`.

---

## 5. Site prep (flat spot, system chest, peaceful)

Handled inside bootstrap unless you run steps manually:

1. **Materialize** — `establish-materialize.py` / `mapcatalog try` (evac humans/bots per `server.local.yaml`, recreate proc-lab if needed).
2. **Map patch** (default) — collapse **muster** onto validated **spawn**; **starter_chest** one block east at spawn feet Y (normal placed chest, not buried).
3. **RCON `world` mode** — peaceful + starter chest via `establish-rcon-prep.py`. Branches on `--mission`:
   - **explore (default):** time set day, `doDaylightCycle false`, chest = 3 iron tools + 4 bread.
   - **mapping:** time set 13000 (dusk), `doDaylightCycle true`, chest = 3 iron tools + 16 bread + **16 oak_sign + 64 torches + 32 coal**. Mob spawning stays disabled so dusk is visual-only.
4. **TP workers** — `establish-rcon-prep.py --mode tp_workers --mission <mission>` after bots listen; re-TP if `nav_header.situation` is Underground/Pit. Mapping starter kit adds **4 oak_sign + 16 torches** so the first round of naming can start before returning to base.

Optional verification:

```bash
python3 scripts/establish-bootstrap-verify.py
# Probes 3001–3005; fails unknown terrain + large |feet_vs_local_ground| at muster
```

---

## 6. Reset runtime state

**Automated:** `establish-run.sh` runs `establish-fleet-cleanup.sh` then `establish-scenario.sh`.

| Concern | Handled by |
|---------|------------|
| Stop + orphan bot loops / ports | `establish-fleet-cleanup.sh` |
| Marks, sessions, MEMORY archive | `establish-scenario.sh` (unless `SKIP_MEM_WIPE=1`) |
| Personal POIs (`personal-pois-<bot>.json` + `personal-pois-shared.json`) | `establish-scenario.sh` per-worker wipe (Phase A6); same loop as `locations-*.json`. Shared overlay is recreated lazily on next `reconcile-pois.py`. |
| Kanban archive + reinit + seed | `establish-scenario.sh` |
| Goals, chest snapshots, kanban WAL, stash | `FULL_RUNTIME_WIPE=1` (default in `establish-run.sh`) |
| Log dir archive | `establish-run.sh --archive-logs` or manual `mv /tmp/hermescraft` |
| Fresh proc-lab disc | `establish-run.sh --fresh-disc SEED` or `reset-proc-lab.py` then `MATERIALIZE=0` |

Board slug: `HERMES_KANBAN_BOARD` (default `landfolk-ops`).

---

## 7. Deploy prompts, SOULs, skills, artifacts

Included in `establish-preflight.sh` / `establish-run.sh` (`scripts/landfolk deploy`; diagnostics skipped until fleet is up). Deploy patches `model.context_length: 250000`, `compression.threshold: 0.7` / `target_ratio: 0.3` (~75K headroom between compressions; lower values caused 40+ compresses in 11 min per worker on noisy mc-scene streams — run-12 evidence), and the aux compression model. Each `landfolk start` re-applies via `patch-landfolk-compression-config.py` on `~/.hermes-landfolk-*/config.yaml`.

**Model source of truth:** `data/agent-models.json`. Per-agent main models live under `agents.<Name>.model`; the aux compression model lives under `auxiliary.compression.{model, provider}`. Both the agent-round resolver (`scripts/resolve-agent-model.py`, re-read each round) and the compression patch (`scripts/patch-landfolk-compression-config.py`) read from this file — edit once, then run `scripts/landfolk deploy` (or just re-run the patch script per config) to propagate.

Re-run after SOUL/skill edits without a full establish:

```bash
scripts/landfolk deploy && scripts/landfolk restart all
```

---

## 8. Start fleet and verify placement

### 8.1 Bootstrap + dispatcher

`establish-scenario.sh` (re-execs bash 5 on macOS) starts gateway (embedded kanban dispatcher when `kanban.dispatch_in_gateway: true`), workers, TP, kanban, seeds cards, and runs `establish-bootstrap-verify.py` unless `SKIP_BOOTSTRAP_VERIFY=1`. Standalone `landfolk-dispatcher.sh` only when embedded dispatch is off or `FORCE_STANDALONE_DISPATCHER=1`.

Cards seed with `assignee=orchestrator-tracker` so Steward assigns patrols. Mapping-mission seed yields a single `[MAP:ARENA]` epic plus four `[MAP] <quadrant>` cards — same dispatcher-skip-lane pattern as explore's `[ESTABLISH:BASE]`. Steward identifies the mapping mission by the literal `[MAP:ARENA]` token in the epic title (not by assignee), per `prompts/landfolk/steward.md`.

### 8.1b Dashboard map (proc-lab)

- `establish-run.sh` **auto-starts the dashboard** after `establish-launch-verify.sh` (skip with `--no-dashboard` or `SKIP_DASHBOARD=1`). It writes the PID to `/tmp/hermescraft/dashboard.pid` and the log to `/tmp/hermescraft/dashboard.log`, then the cleanup script tears it down at fleet stop. If a dashboard is already running on the target port the auto-start step is a no-op (operator-started instances stay live).
- Manual: `./start-dashboard.sh --world proc-lab`. Override port with `DASHBOARD_PORT=…`, world with `DASHBOARD_WORLD=…` (env-var equivalent of the flag).
- In the Command Center world dropdown, select **proc-lab** (not `world`) while the establish fleet is in that MV world.
- **Ops** map (Command Center **Overview**): lightweight XZ view (agents, marks, personal POIs, spawn/muster/arena from `data/runtime/last-establish-map.json`) — use this when Squaremap still shows an old disc.
- **Terrain** tab: Squaremap iframe. After `reset-proc-lab` or `--fresh-disc`, stale tiles are normal until the server re-renders. On the MC host (RCON/console): `/squaremap fullrender proc-lab` (or the plugin’s world key, e.g. `minecraft_proc-lab` — match `hermesToTileWorld` in `data/agent-registry.json`). The dashboard appends `hc_rev=` from `data/runtime/proc-lab-state.json` / establish map seed so the browser reloads the iframe when the seed changes; it does not replace Squaremap’s on-disk tile cache.

### 8.2 Launch verify

```bash
scripts/establish-launch-verify.sh
scripts/landfolk diagnostics    # full report once gateway + bots are up
```

Checks: all bot ports (via `establish-bootstrap-verify.py`), progress `pos`, steward `POST /action/tunnel` → 403, steward `mc observe` CLI line, dispatcher log/process. Preflight skips diagnostics by default; run them here (or `establish-preflight.sh --with-diagnostics`).

### 8.3 Manual start (debugging)

```bash
scripts/landfolk deploy
hermes gateway run --replace    # or rely on establish-scenario
scripts/landfolk start --players steward,gatherer,flint,mason
```

Wait for health:

```bash
for p in 3001 3002 3003 3005; do
  curl -sf -m 1 "http://127.0.0.1:$p/health" && echo " :$p ok" || echo " :$p down"
done
```

### 8.4 Steward mc deny vs “observe denied” (reasoning vs gate)

`establish-launch-verify.sh` runs `BOT_URL=http://localhost:3005 node bot/cli/index.mjs observe`. Hermes terminal uses `orchestrator-deny.sh`; `mc observe` is allowed. Read-only verbs on the allowlist include `inventory`, `chest_search`, and `social` (not `mc players` — use `mc social` / `mc nearby`). Bot HTTP gate copy is minimal: `mc <verb> is denied for the orchestrator (Steward) role. See prompts/landfolk/steward.md.` (see `bot/lib/server/middleware/orchestrator-mc-allowlist.js`).

If Steward reports "observe denied" after a different verb failed, treat it as **stale reasoning** until you verify the audit trail: one forbidden field verb → 403 on that verb only; `mc observe` / `mc status` / `mc scene` should still return 200 on port 3005. Do not file a global role-gate [BUG] from the deny text alone.

**`hermes kanban reassign` semantics (post-phase-12):** reassign should atomically reclaim any active claim (SIGTERM the prior host-local worker PID, clear `claim_lock`, change `assignee` in one tx). `--reclaim` on CLI is deprecated/no-op when reclaim is built in. Steward's playbook (`prompts/landfolk/steward.md`) documents single-step reassign for PHYSICALLY_STUCK rescue.

**Dispatcher `max_spawn` (operator config, post-phase-12):** on the operator rig, set `kanban.max_spawn: 5` in `~/.hermes/config.yaml` (workers + 1 slack), up from 3. This is **not** pinned in the hermescraft repo — confirm on gateway boot: `grep 'kanban dispatcher' ~/.hermes/logs/gateway.log | tail -1`.

**Steward `exit=142`:** round wall-clock timeout (`ORCHESTRATOR_ROUND_TIMEOUT_S`, default 600s), not SIGPIPE. Raise the env var or shorten OBSERVE work. After changing `data/agent-models.json`, restart agents so each round picks up `-m` from `resolve-agent-model.py` (re-read every round).

**Dispatcher:** With `kanban.dispatch_in_gateway: true`, `establish-scenario.sh` and `scripts/landfolk start` do **not** start `landfolk-dispatcher.sh` (avoids dual-dispatcher claim races). Use `FORCE_STANDALONE_DISPATCHER=1` only when embedded dispatch is off. After changing MC routing fixes, run `scripts/setup-landfolk-profiles.sh --apply-config` and restart gateway (`scripts/landfolk restart gateway` or stop/start).

**Worker MC routing (post phase-16):** Root leak was **`BASH_ENV`** inheriting Steward's `agent-bashenv.sh` into gateway-spawned workers (terminal bash re-exported `:3005` before the first `mc`). Profile `.env` must set `MC_API_URL`, `MC_USERNAME`, and `_MC_API_URL_LOCKED` to the assignee port (`setup-landfolk-profiles.sh`). `scripts/landfolk` / dispatcher / `_default_spawn` unset MC vars **and `BASH_ENV`**. `landfolk restart gateway` scrubs too. Spawn audit: `/tmp/worker-env-debug.log` (2MB rotate; `HERMES_KANBAN_WORKER_ENV_DEBUG=0` to disable).

**Logs:** `establish-fleet-cleanup.sh` runs `snapshot-fleet-logs.sh` before stop. `mc-*.log` still truncates on bot respawn — snapshot preserves pre-restart CLI traces.

---

## 9. Monitor, pause, stop, restart

| Action | Command |
|--------|---------|
| Board | `scripts/kanban board` |
| Dashboard | `open http://127.0.0.1:3000` (auto-started by `establish-run.sh`; manual: `./start-dashboard.sh --world proc-lab`) |
| Dashboard log | `tail -F /tmp/hermescraft/dashboard.log` |
| Aggregated agent logs | `scripts/landfolk logs agents --profiles steward,flint,mason,gatherer` |
| Per-bot raw log | `scripts/landfolk logs mason --tail 50` |
| Follow | `scripts/landfolk logs flint -f` |
| Gateway / dispatcher | `scripts/landfolk logs gateway -f` ; `tail -F /tmp/hermescraft/dispatcher.log` |
| Progress / stuck | `tail -F /tmp/hermescraft/progress-*.log` ; kanban comments with `[AUTO_STUCK]` (worker line mandates `read_chat` + `reachable` before retry) |
| Nav errors | `tail -F /tmp/hermescraft/nav-Mason.jsonl` |
| Pause dispatch | Stop gateway or `landfolk stop` (keeps policy: use `--keep gateway` only if you know why) |
| Stop fleet + dashboard | `scripts/establish-fleet-cleanup.sh` (or `scripts/landfolk stop` then `kill $(cat /tmp/hermescraft/dashboard.pid)`) |
| Restart one bot | `scripts/landfolk restart mason` |
| Restart all | `scripts/landfolk restart all` or `stop` then `establish-scenario.sh` |

**Snapshot logs at fleet stop (postmortem):**

```bash
scripts/snapshot-fleet-logs.sh data/postmortems/establish-2026-06-04-phase11
# or: RUN_ID=phase11 scripts/snapshot-fleet-logs.sh
```

Steward should run `scripts/reconcile-marks.py --auto` each cycle (see `steward.wake-minimal.md`). For the **mapping mission**, Steward also runs `scripts/reconcile-pois.py --auto` when she notices new per-bot POIs that haven't reached the shared overlay — but **not every cycle by default** (the grader reads the shared file directly, and the dashboard reads per-bot files via the dedupe path in `dashboard/lib/personal-pois.js`).

**Mapping mission live checks:**

```bash
# Coverage so far (offline; doesn't hit the kanban DB)
python3 scripts/establish-mapping-check.py --skip-epic

# Per-bot POI summary
for f in data/personal-pois-*.json; do
  echo "$f"; jq 'to_entries[] | "  \(.key)  (\(.value.x),\(.value.y),\(.value.z))  sign=\(.value.sign_at|tojson)"' "$f" 2>/dev/null
done

# Dashboard overlay (after starting it with --world proc-lab)
curl -s "http://127.0.0.1:${DASHBOARD_PORT:-3000}/api/personal-pois" | jq '.pois | length'
```

Workers checking their own context use `mc pois`, `mc nearby_signs 32`, and `mc marks` — note `mc observe` strips those lists under `HERMES_NAV_BRIEF=1`.

---

## 10. Grade and rerun semantics

```bash
# Explore mission grader
scripts/establish-check.py
# Offline: scripts/establish-check.py --skip-rcon

# Mapping mission grader (use instead when VARIANT=establishment.mapping)
python3 scripts/establish-mapping-check.py
# Offline (skip the [MAP:ARENA] epic-status check):
python3 scripts/establish-mapping-check.py --skip-epic
```

**Explore checks:** `base_anchor` mark, ≥80/81 cobble on 9×9 pad, four explores done, epic done. **Does not** judge scenic quality.

**Mapping checks:** `personal-pois-shared.json` must contain ≥ 8 POIs with ≥ 4 having non-null `sign_at`, coverage_radius (max horizontal distance from muster) ≥ 40, ≥ 3 of 4 quadrants populated, and the `[MAP:ARENA]` epic must be `done`. Tune thresholds with `--poi-min / --sign-min / --coverage-min / --quadrant-min`. Quadrant axis: `-z = N`, `+x = E`; origin tie-breaks to SE. The grader reads ONLY the shared overlay — per-bot files don't count until reconciled.

| Rerun | Behavior |
|-------|----------|
| Kanban | Wiped and re-seeded every `establish-scenario.sh` |
| World seed | Stable when `AUTO_REUSE=1` and disc unchanged |
| Catalog | Re-`refresh` after editing `requirements/scenario_establish_explore.yaml` |

---

## 11. PR-1 scene gate (optional human sign-off)

Before trusting full multi-bot establish on a new scene build:

```bash
BOT_URL=http://localhost:3002 scripts/proc-lab-ops.sh agent-only
```

Run 2–3 rounds; confirm workers could pick a base from `mc scene` one-liner (biome, relief, trees). Not automated CI.

---

## 12. Known friction (record, don’t pre-fix)

| Issue | Signal |
|-------|--------|
| NAV lip / blocked move | `NAV_BLOCKED` in nav jsonl; `move:error` in progress; read `next_action_hint` (`reachable`, lip `dig`, `build_stairs`) — see [route-sculpt-navigation.md](../features/route-sculpt-navigation.md) |
| Chunk visibility | Partial sector coverage on explore cards |
| `goto_near` timeout | Message should cite **15000ms** cap (contract test); traps often dominate over timeout |
| `level_ground` / `level` column cap | Split rectangles (≤16 columns per call) |
| Dispatcher idle | Check `grep 'kanban dispatcher' ~/.hermes/logs/gateway.log`; if `dispatch_in_gateway: false`, run `scripts/landfolk-dispatcher.sh` or `FORCE_STANDALONE_DISPATCHER=1 establish-scenario.sh` |
| `mc-*.log` gap | Listener respawn freezes the file at pre-restart timestamp; afternoon failures live in `agent-*.log` / `nav-*.jsonl` / `state.db` only |
| **Bash 3.2 stop-script** | `scripts/landfolk stop` (which invokes `landfolk-control.sh stop`) uses `${name,,}` lowercasing on lines ~321/426 — fails silently on macOS default `/bin/bash`. Kills the dispatcher cleanly but leaves bot-loop + watchdog children orphaned. Workaround: `pkill -f 'landfolk:'` and `lsof -ti :3001 -i :3002 -i :3003 -i :3005 | xargs kill -9` after `landfolk stop`. |
| **Bootstrap halts at `declare -A`** | `establish-scenario.sh:182` fails on bash 3.2 (`steward: unbound variable`). Bots end up in the landfolk-test hub world, never TP'd to proc-lab. Re-run with `/opt/homebrew/bin/bash`. |
| **Steward "observe denied" hallucination** | Usually stale belief after one field-verb 403 — not a global gate failure. Live-verify `mc observe` on 3005 (§8.4 / launch verify) before trusting her summary. |
| **Worker ignores operator whisper** | Whispers do not enter the loop until `mc read_chat`; same for Steward comments vs `mc chat`. Mandated in `skills/kanban-worker.md` + `[AUTO_STUCK]` comment text. |
| **Wrong bot port / Steward deny on workers** | Bare `mc` hits :3005 while `echo $MC_API_URL` shows assignee port — leaked `_MC_API_URL_LOCKED` in terminal env. Fix: `landfolk deploy` / `setup-landfolk-profiles.sh --apply-config`, restart gateway, check `/tmp/worker-env-debug.log` after next spawn. |
| Anchor below surface | Pad-clear cards at `anchor_y < surface_y` tunnel workers into traps (run-8 Mason at (-3,68,53)). Watch for `BOT_TRAPPED` followed by `mc escape` partial pillar; recovery often loses the original anchor. |
| **Mapping: phantom worker names** | Same root cause as run-12: Steward dispatching `worker-a` / `worker-b` (`[MAP] cards` not picked up). `prompts/landfolk/steward.md` now hard-rules against it for both missions — verify by running `python3 scripts/roster.py --assignable` and grepping the board for non-roster assignees on `[MAP]` cards. |
| **Mapping: empty-evidence completion** | `[MAP]` card cards mandate literal `mc marks` / `mc pois` / `mc nearby_signs 32` output in the completion body (phase-17 rule extended). Completion bodies with `pois:` followed by nothing are rejected; re-comment with the missing-evidence callout and leave the card open. |
| **Mapping: `_MC_API_URL_LOCKED` env leak** | Same defense-in-depth as explore — `BASH_ENV` leak from Steward's `agent-bashenv.sh` would point workers' `mc` at port 3005. Verify after spawn: `tail -F /tmp/worker-env-debug.log`. |

Record card id, error code, and coordinates for postmortems.

---

## Quick path (copy-paste)

### Explore mission (default)

```bash
export PATH=/opt/homebrew/bin:$PATH
scripts/establish-run.sh --min-credits-usd 5 --archive-logs
# Dashboard auto-starts → http://127.0.0.1:3000
scripts/kanban board
scripts/landfolk logs agents --profiles steward,flint,mason -q --tail 20 --no-follow
# … run …
scripts/establish-fleet-cleanup.sh        # stops dashboard + fleet, snapshots logs
scripts/snapshot-fleet-logs.sh data/postmortems/establish-$(date +%Y-%m-%d)-phaseN
scripts/establish-check.py
```

### Mapping mission

```bash
bash scripts/establish-mapping-phase-d-prep.sh   # catalog ensure + offline grader hint
export PATH=/opt/homebrew/bin:$PATH
VARIANT=establishment.mapping scripts/establish-run.sh --min-credits-usd 5 --archive-logs
# Dashboard auto-starts → http://127.0.0.1:3000 (Ops tab shows personal POIs)
scripts/kanban board                     # confirm [MAP:ARENA] epic + 4 [MAP] cards
scripts/landfolk logs agents --profiles steward,flint,mason -q --tail 20 --no-follow

# Mid-run coverage check (offline)
python3 scripts/establish-mapping-check.py --skip-epic

# Steward chats "wrap up — coverage sufficient" → stop fleet + dashboard
scripts/establish-fleet-cleanup.sh
scripts/snapshot-fleet-logs.sh data/postmortems/establish-$(date +%Y-%m-%d)-mappingN

# Final grade (full, with kanban epic-status)
python3 scripts/reconcile-pois.py --auto
python3 scripts/establish-mapping-check.py
```

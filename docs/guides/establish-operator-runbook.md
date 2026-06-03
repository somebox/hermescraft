# Establish operator runbook

Single checklist for **exploration-first base establishment** on **proc-lab** with the landfolk fleet. Use this before and during long establish replays (run-8/11-class fixes, Phase 10 predicates).

**Outcome:** Steward decomposes `[ESTABLISH:BASE]` on kanban; workers patrol with `mc scene`; Mason builds a 9×9 cobble pad at `base_anchor`. Process grade: `scripts/establish-check.py`. Site quality: judge in-game.

**Related:** [procedural-testing-model.md](../features/procedural-testing-model.md), [procedural-bench-ops.md](procedural-bench-ops.md), [architecture-audit.md](../../data/postmortems/establish-2026-06-03-phase10/architecture-audit.md), `prompts/landfolk/establish-epic.md`.

**Do not mix** `scripts/genesis.sh` (campaign world + genesis kanban) with this proc-lab loop unless you intend to.

---

## 1. Script index

| Script | Role |
|--------|------|
| `scripts/establish-scenario.sh` | **One-shot bootstrap** (stop fleet, wipe memory, map, materialize, RCON prep, gateway, start bots, TP, kanban reset, seed cards) |
| `scripts/establish-check.py` | Post-run **process grade** (pad cobble, explores, epic) |
| `scripts/establish-rcon-prep.py` | Peaceful world + starter chest + `tp_workers` (called by bootstrap) |
| `scripts/establish-materialize.py` | `mapcatalog try` for chosen map JSON |
| `scripts/establish-seed-cards.py` | Kanban epic + four `[EXPLORE]` cards from map |
| `scripts/establish-bootstrap-verify.py` | Optional: fail bad `terrain=unknown` at muster (ports from `data/agent-models.json`) |
| `scripts/reset-proc-lab.py` | Evac bots, delete/recreate **proc-lab** MV world (clean disc) |
| `scripts/scenario-pools.sh` | `lint` / `list` / `refresh` / `map <variant>` for catalog |
| `scripts/landfolk` | `start` / `stop` / `restart` / `deploy` / `diagnostics` / `status` / `logs` |
| `scripts/landfolk-control.sh` | Low-level bot + agent loops (bootstrap calls `start`) |
| `scripts/kanban` | Board orient (`board`, `card`, …) |
| `scripts/genesis_lib.py` | `archive_run_state` + `reinit_kanban_board` (used inside bootstrap) |
| `scripts/reconcile-marks.py` | Merge fleet marks into `data/locations-base.json` |
| `scripts/snapshot-fleet-logs.sh` | Copy `/tmp/hermescraft` → postmortem dir at fleet stop |
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

Do not start a long replay until these pass (~2–5 minutes).

```bash
cd bot && HERMES_VALIDATE=1 npm test -- \
  test/runtime/nav-brief-render.test.js \
  test/cli/output.test.js \
  test/runtime/observation-status-shape.test.js \
  test/actions/goto-near-timeout-contract.test.js \
  test/scene-canopy-window.test.js \
  test/server/orchestrator-mc-gate.test.js \
  test/server/orchestrator-mc-gate-http.test.js

python3 -m unittest \
  scripts.tests.test_auto_stuck_check \
  scripts.tests.test_watchdog_progress_emit \
  scripts.tests.test_watchdog_progress_e2e \
  scripts.tests.test_wb_stash_side_effect \
  scripts.tests.test_orchestrator_allowlist_sync \
  scripts.tests.test_kanban_worker_wb_context \
  scripts.tests.test_card_body_linter \
  scripts.tests.test_kanban_retry_policy \
  scripts.tests.test_establish_rcon_prep \
  scripts.tests.test_reset_proc_lab

bash scripts/tests/test_orchestrator_deny_hook.sh
```

---

## 4. Choose world, seed, and map

| Decision | How |
|----------|-----|
| **World** | **`proc-lab`** only for this runbook (MV scratch world). Campaign worlds (`landfolk-test`, `world`) are not deleted by mapcatalog. |
| **Variant** | `establishment.explore` (registry id; override with `VARIANT=…`) |
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
3. **RCON `world` mode** — peaceful, day, starter chest fill (iron tools + bread) via `establish-rcon-prep.py`.
4. **TP workers** — `establish-rcon-prep.py --mode tp_workers` after bots listen; re-TP if `nav_header.situation` is Underground/Pit.

Optional verification:

```bash
python3 scripts/establish-bootstrap-verify.py
# Probes 3001–3005; fails unknown terrain + large |feet_vs_local_ground| at muster
```

---

## 6. Reset runtime state (order matters)

### 6.1 Stop fleet

```bash
scripts/landfolk status          # all DOWN before a clean bootstrap
scripts/landfolk stop            # optional: --players flint,mason,…

# bash 3.2 fallout (§12 known friction): the stop script kills the
# dispatcher cleanly but leaves bot-loop + watchdog children behind.
# Always follow with a hard cleanup before re-bootstrapping:
pkill -9 -f 'landfolk:' 2>/dev/null
for p in 3001 3002 3003 3005; do
  pid=$(lsof -nP -iTCP:$p -sTCP:LISTEN -t 2>/dev/null | head -1)
  [ -n "$pid" ] && kill -9 "$pid"
done
# Verify quiet:
pgrep -fl 'landfolk:' || echo "  clean"
for p in 3001 3002 3003 3005; do
  curl -s -o /dev/null -w " :$p %{http_code}\n" -m 1 "http://localhost:$p/status"
done
# Expect: all 000
```

Stray `node server.js` / Hermes tasks cause wrong env (Steward sandbox PATH broke dispatcher gate-check in past runs).

### 6.2 Logs and lockfiles (optional archive)

Bootstrap does **not** truncate old `/tmp/hermescraft` logs. For a clean audit trail:

```bash
RUN_ID=phase11-$(date +%Y%m%d)
ARCHIVE="/tmp/hermescraft-pre-$RUN_ID"
mv /tmp/hermescraft "$ARCHIVE" 2>/dev/null || true
mkdir -p /tmp/hermescraft
```

Or snapshot after the run (see §10).

Remove stale kanban DB journals if bootstrap crashed mid-flight:

```bash
rm -f ~/.hermes/kanban/boards/landfolk-ops/kanban.db-wal \
      ~/.hermes/kanban/boards/landfolk-ops/kanban.db-shm
```

### 6.3 Kanban board

`establish-scenario.sh` always:

1. `archive_run_state(<run-id>)` — copies live `kanban.db` + `data/locations-*.json` into `data/postmortems/…/archived/` (via genesis_lib layout).
2. Deletes live kanban DB + WAL/SHM.
3. `reinit_kanban_board()` — empty `landfolk-ops`.
4. `establish-seed-cards.py` — epic + four explores.

Manual equivalent:

```bash
python3 -c "
import sys; sys.path.insert(0,'scripts')
import genesis_lib as gl
rid = 'establish-manual-$(date +%Y%m%dT%H%M%S)'
gl.archive_run_state(rid)
gl.reinit_kanban_board()
print('archived as', rid)
"
```

Board slug: `HERMES_KANBAN_BOARD` (default `landfolk-ops`).

### 6.4 Marks and agent memory (bootstrap default)

Unless `SKIP_MEM_WIPE=1`:

| What | Action |
|------|--------|
| Per-bot marks | Delete `data/locations-{steward,gatherer,flint,mason}.json` |
| Shared marks | Delete `data/locations-base.json` |
| Hermes sessions | Delete `~/.hermes/profiles/<wk>/sessions/*.json` |
| MEMORY.md | Archive to `MEMORY.md.bak-<timestamp>` under profile + `~/.hermes-landfolk-<wk>/memories` |
| Stash side-effect | `rm -f ~/.hermes-landfolk-*/task-body-coord.json` |

Stale MEMORY caused wrong muster Y and cabin coords across runs (run-8 evidence).

### 6.5 Goals and chest metadata

| Artifact | Location | Reset |
|----------|----------|--------|
| Base goals thresholds | `data/base-goals.yaml` | Restored from genesis template only on **genesis** runs; establish uses existing file unless you copy template manually |
| Per-bot reactive goals | `data/goals-<profile>.json` | Remove if you need zero goal state: `rm -f data/goals-*.json` (not done by bootstrap) |
| Chest snapshots (bot server) | `data/chest-snapshots-<mc_username>.json` | `rm -f data/chest-snapshots-*.json` before bot restart |
| Regions / plans | `data/regions-world.json`, `data/ops/plans/*` | Archived with `archive_run_state`; delete live copies only if you understand downstream deps |

Restart bots after deleting chest snapshot files so in-memory caches reload.

### 6.6 Evac and rebuild world (when needed)

Use when the disc has shelters, doors, or wrong surface from prior runs:

```bash
scripts/landfolk stop
python3 scripts/reset-proc-lab.py --seed 1001   # or your catalog seed
AUTO_REUSE=1 MATERIALIZE=0 scripts/establish-scenario.sh
```

`MATERIALIZE=0` is safe after reset: disc is already the target seed; bootstrap still patches map JSON and runs RCON/kanban.

---

## 7. Deploy prompts, SOULs, skills, artifacts

**Required** after any edit to `prompts/landfolk/*.md`, `skills/*.md`, or `bot/` code that affects runtime:

```bash
scripts/landfolk deploy              # SOULs/skills → ~/.hermes/profiles/<bot>/
# includes scripts/regenerate-artifacts.sh (mc-cheatsheet, …)

scripts/landfolk diagnostics         # deploy + gateway + dispatcher + daemons smoke
```

Commit tree ≠ runtime until **deploy** and **bot processes restart**.

Confirm dispatcher Hermes binding (genesis-run-prep):

```bash
grep 'HERMES_BIN=' scripts/landfolk-dispatcher.sh
```

---

## 8. Start fleet and verify placement

### 8.1 One-shot (recommended)

```bash
# From repo root; optional env:
#   VARIANT=establishment.explore
#   WORKERS=steward,gatherer,flint,mason
#   AUTO_REUSE=1  MATERIALIZE=1
#   SKIP_MEM_WIPE=0  SKIP_MAP_PATCH=0
# Run with bash 5+ explicitly (macOS default /bin/bash is 3.2 and crashes
# at line 182's `declare -A WORKER_PORTS`):
/opt/homebrew/bin/bash scripts/establish-scenario.sh
```

Starts **hermes gateway**, then workers, waits for HTTP `/status`, TPs to muster, resets kanban, seeds cards. Cards are seeded with `assignee=orchestrator-tracker` (a non-spawnable parking lane) so Steward decides who patrols where.

### 8.1a Dispatcher start (separate process — easy to miss)

The standalone kanban dispatcher loop is **NOT** auto-started by the gateway. Without it, even after Steward reassigns cards to real workers, the cards sit `ready` forever — no spawn ticks fire.

Run-11 evidence: gateway up, bots up, Steward reading the board — but `dispatcher.log` last entry was from the prior session's stop; cards stayed `ready` until the dispatcher was launched manually.

Always launch after bootstrap (idempotent — `landfolk stop` kills any prior):

```bash
/opt/homebrew/bin/bash scripts/landfolk-dispatcher.sh > /tmp/hermescraft/dispatcher.log 2>&1 &
```

Verify it's ticking every 60s (interval is configurable):

```bash
tail -F /tmp/hermescraft/dispatcher.log
# Expect: [HH:MM:SS] dispatcher starting: board=landfolk-ops interval=60s max=3
#         [HH:MM:SS] tick: idle (no spawns / reclaims / promotions; ...)
```

A single line like `dispatcher stopping (SIGTERM)` followed by silence means the dispatcher is dead even if the gateway is alive.

### 8.2 Manual start (debugging)

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

### 8.3 Live contracts (run-11 launch gate)

**Progress `pos` (PR-S):**

```bash
tail -3 /tmp/hermescraft/progress-mason.log
# Expect "pos":{"x":…,"y":…,"z":…} — not null after 18:14-class emitter fix
```

**Steward HTTP deny (P0-5):**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' http://127.0.0.1:3005/action/tunnel
# Expect 403

curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' http://127.0.0.1:3001/action/tunnel
# Expect not 403 (worker)
```

**Terrain on CLI (PR-J):**

```bash
BOT_URL=http://localhost:3002 mc status | grep -E 'terrain='
```

**Steward read-only mc via Hermes** uses `orchestrator-deny.sh` on **terminal** — allowlisted verbs include `observe`, `status`, `scene`, `chat`, `read_chat`, `whisper`. Direct HTTP still hits bot-server gate on `/action/*` and `/task/*`.

**Endpoint shape — easy LLM misread**: `mc observe` and `mc read_chat` map to top-level `GET /observe` and `GET /chat` — **not** to `/action/<verb>`. The bot-server gate (`/action/*`) does not see them at all; they always pass. If Steward reports "mc observe is denied", she's mis-attributing a 400 "Unknown action" from `POST /action/observe` (which is correctly not a registered action). Live-verify with the CLI before believing her:

```bash
BOT_URL=http://localhost:3005 node bot/cli/index.mjs observe | head -3
# Expect: Surface at X,Y,Z — ... — terrain=<kind> (feet_vs_local_ground=<N>)
```

If that returns a real nav header, the denial is in her reasoning, not the gate.

---

## 9. Monitor, pause, stop, restart

| Action | Command |
|--------|---------|
| Board | `scripts/kanban board` |
| Aggregated agent logs | `scripts/landfolk logs agents --profiles steward,flint,mason,gatherer` |
| Per-bot raw log | `scripts/landfolk logs mason --tail 50` |
| Follow | `scripts/landfolk logs flint -f` |
| Gateway / dispatcher | `scripts/landfolk logs gateway -f` ; `tail -F /tmp/hermescraft/dispatcher.log` |
| Progress / stuck | `tail -F /tmp/hermescraft/progress-*.log` ; `grep AUTO_STUCK` on kanban comments |
| Nav errors | `tail -F /tmp/hermescraft/nav-Mason.jsonl` |
| Pause dispatch | Stop gateway or `landfolk stop` (keeps policy: use `--keep gateway` only if you know why) |
| Stop fleet | `scripts/landfolk stop` |
| Restart one bot | `scripts/landfolk restart mason` |
| Restart all | `scripts/landfolk restart all` or `stop` then `establish-scenario.sh` |

**Snapshot logs at fleet stop (postmortem):**

```bash
scripts/snapshot-fleet-logs.sh data/postmortems/establish-2026-06-04-phase11
# or: RUN_ID=phase11 scripts/snapshot-fleet-logs.sh
```

Steward should run `scripts/reconcile-marks.py --auto` each cycle (see `steward.wake-minimal.md`).

---

## 10. Grade and rerun semantics

```bash
scripts/establish-check.py
# Offline: scripts/establish-check.py --skip-rcon
```

Checks: `base_anchor` mark, ≥80/81 cobble on 9×9 pad, four explores done, epic done. **Does not** judge scenic quality.

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
| NAV lip / blocked move | `NAV_BLOCKED` in nav jsonl; `move:error` in progress |
| Chunk visibility | Partial sector coverage on explore cards |
| `goto_near` timeout | Message should cite **15000ms** cap (contract test); traps often dominate over timeout |
| `level_ground` / `level` column cap | Split rectangles (≤16 columns per call) |
| Dispatcher idle | `dispatcher.log` not updating; even if gateway is up, the standalone dispatcher loop must be launched separately (§8.1a) |
| `mc-*.log` gap | Listener respawn freezes the file at pre-restart timestamp; afternoon failures live in `agent-*.log` / `nav-*.jsonl` / `state.db` only |
| **Bash 3.2 stop-script** | `scripts/landfolk stop` (which invokes `landfolk-control.sh stop`) uses `${name,,}` lowercasing on lines ~321/426 — fails silently on macOS default `/bin/bash`. Kills the dispatcher cleanly but leaves bot-loop + watchdog children orphaned. Workaround: `pkill -f 'landfolk:'` and `lsof -ti :3001 -i :3002 -i :3003 -i :3005 | xargs kill -9` after `landfolk stop`. |
| **Bootstrap halts at `declare -A`** | `establish-scenario.sh:182` fails on bash 3.2 (`steward: unbound variable`). Bots end up in the landfolk-test hub world, never TP'd to proc-lab. Re-run with `/opt/homebrew/bin/bash`. |
| **Steward "observe denied" hallucination** | Steward calls one forbidden verb, gets the structured deny message that LISTS allowed verbs, then misreads it as "everything is denied including observe". Live-verify with `mc observe` via CLI (§8.3) before trusting her judgement. |
| Anchor below surface | Pad-clear cards at `anchor_y < surface_y` tunnel workers into traps (run-8 Mason at (-3,68,53)). Watch for `BOT_TRAPPED` followed by `mc escape` partial pillar; recovery often loses the original anchor. |

Record card id, error code, and coordinates for postmortems.

---

## Quick path (copy-paste)

```bash
# Toolchain (§2): use bash 5+ and python 3.11+ explicitly.
export PATH=/opt/homebrew/bin:$PATH    # bash 5, python 3.x
bash --version | head -1               # expect 5.x
python3 --version                      # expect 3.11+

# 0. Credits + tests + deploy
# (sections 2.1, 3, 7)

# Stop + hard cleanup (§6.1 bash 3.2 fallout)
scripts/landfolk stop
pkill -9 -f 'landfolk:' 2>/dev/null
for p in 3001 3002 3003 3005; do
  pid=$(lsof -nP -iTCP:$p -sTCP:LISTEN -t 2>/dev/null | head -1); [ -n "$pid" ] && kill -9 "$pid"
done

# Optional fresh disc
python3 scripts/reset-proc-lab.py --seed 1001

# Bootstrap with bash 5+ explicitly
/opt/homebrew/bin/bash scripts/establish-scenario.sh

# Dispatcher must be launched separately (§8.1a)
/opt/homebrew/bin/bash scripts/landfolk-dispatcher.sh > /tmp/hermescraft/dispatcher.log 2>&1 &

# Verify
scripts/kanban board
tail -F /tmp/hermescraft/dispatcher.log    # expect ticks every 60s
scripts/landfolk logs agents --profiles steward,flint,mason -q --tail 20 --no-follow

# During run: progress pos + steward 403 smoke (section 8.3)

scripts/landfolk stop
scripts/snapshot-fleet-logs.sh data/postmortems/establish-$(date +%Y-%m-%d)-phaseN
scripts/establish-check.py
```

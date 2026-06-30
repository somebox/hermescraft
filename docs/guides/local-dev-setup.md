# Local dev setup — run HermesCraft on this machine

Run the whole stack **locally** — self-hosted Paper 1.21.4 + Multiverse-Core with
native TCP rcon. This replaces the old LAN server (ssh → docker → rcon-cli). Covers the
five paths the project cares about: **context tests, arena (functional) tests, world-gen
seed-finding, genesis-v2, and open-world play**.

> **Hermes is a legacy one-off.** The agent runtime + kanban are being migrated to
> **pi-agent + [somebox/cards](https://github.com/somebox/cards)** (design-only today, see
> [`../architecture/pi-rewrite-design.md`](../architecture/pi-rewrite-design.md)).
> Install it to verify current behavior; don't build on it.

---

## TL;DR

```bash
scripts/local-install.sh         # all deps except Paper + sqlite3 (idempotent)
sudo apt-get install -y sqlite3  # one system package needing root (bot-lease registry)
server/local-setup.sh            # download Paper 1.21.4 + Multiverse, create worlds
scripts/local-up.sh              # start server + Tester bot
HERMESCRAFT_PROFILE=local pytest -m 'functional and not slow and not colony'
scripts/local-down.sh            # stop everything
```

## What runs where

```
pytest / mapcatalog / hermes ──► mc CLI / HTTP ──► bot/server.js (Mineflayer) ──┐
                                                                                 ├─► Paper 1.21.4
tests + world-gen ───────────── native TCP rcon (mcrcon :25575) ────────────────┘   + Multiverse-Core
```

- **Paper server**: `server/` (jar, worlds, `server.properties` — all gitignored; only the
  `local-*.sh` scripts are tracked). Separate from `server/start.sh` (the hardcore "The Crash"
  demo on :12345).
- **Worlds** (Multiverse-managed, so `/execute in <name>` resolves): `landfolk-test`
  (arena/genesis/open-world), `proc-lab-bootstrap` + `proc-lab` (world-gen scratch).
- **Ports**: MC `:25565`, rcon `:25575` (TCP, no ssh/docker), Tester bot HTTP `:3004`
  (viewer `:4004`).

## Toolchain

| Tool | Needed for | Auto-installed by |
|---|---|---|
| OpenJDK 21 (JRE) | Paper server | — (system) |
| Node 18+ (22 ok) | bot server, context-tuner | — (system) |
| Python 3.11+ + `uv` | tests, mapcatalog | — (system) |
| `gcc`/`make`/`git` | build cubiomes | — (system) |
| `sqlite3` CLI | bot-lease registry, genesis-v2 | **`sudo apt-get install -y sqlite3`** |
| node deps + mineflayer patches | bot | `scripts/local-install.sh` (`npm install` → patch-package) |
| `.venv` (pytest, pyyaml, mcrcon) | tests, world-gen rcon | `scripts/local-install.sh` |
| `proc_biome_scan` (cubiomes) | world-gen Pass 1 | `scripts/local-install.sh` |
| `hermes` CLI | genesis-v2, open-world | `scripts/local-install.sh` (`uv tool install hermes-agent`) |

Docker and `rcon-cli` are **not** required.

## Secrets

The OpenRouter key lives in **`secrets.yaml`** (`openrouter_api_key: sk-or-...`, gitignored).
`scripts/local-install.sh` bridges a copy into **`~/.hermes/.env`** (`OPENROUTER_API_KEY=...`)
for the `hermes` CLI and bot launch scripts. Needed for context-test grading, genesis-v2, and
open-world; **not** for arena tests or world-gen.

---

## Per-path quickstarts

### 1. Context tests — no server, no Minecraft
```bash
./context-tuner doctor                 # preflight (needs OpenRouter key in secrets.yaml)
./context-tuner scenario validate --all
./context-tuner run examples --runs 1 --no-judge --yes -q   # graded run (uses the key)
```

### 2. Arena (functional) tests — server + Tester bot
```bash
scripts/local-up.sh
HERMESCRAFT_PROFILE=local pytest -m 'functional and not slow and not colony'   # ~110 tests, ~10–15 min
# faster smoke:
HERMESCRAFT_PROFILE=local pytest -m 'functional and functional_core and not slow'
scripts/local-down.sh
```
`HERMESCRAFT_PROFILE=local` selects the `$overrides.local` block in
[`config/hermescraft.yaml`](../../config/hermescraft.yaml) (host `localhost`, world
`landfolk-test`, `rcon.mode: tcp`). The TCP transport lives in
[`tests/_lib/rcon.py`](../../tests/_lib/rcon.py).

**Baseline (Paper 1.21.4, local):** `105 passed, 5 skipped, 3 xfailed, 4 failed` (~15 min).
The 4 failures are pre-existing and unrelated to local setup (suite-order pollution, a stale
`INVALID_ARG`/`INVALID_ARGS` assertion, known-flaky mining timing, and a behavioral diagnostic
field) — each passes or is non-infra when re-run in isolation.

### 3. World-gen seed-finding — cubiomes (+ server for Pass 2)
Config: [`server.local.yaml`](../../server.local.yaml) (TCP rcon, `proc-lab` scratch world).
```bash
# offline (cubiomes only, no server):
.venv/bin/python -m mapcatalog try -r requirements/mine_plains_iron.yaml \
  -s server.local.yaml --seed 271828 --pass1-only --json

# full single seed (materializes proc-lab over rcon via Multiverse):
scripts/local-up.sh --no-bot
.venv/bin/python -m mapcatalog try -r requirements/permissive_smoke.yaml \
  -s server.local.yaml --seed 800 --json-full
```
Pass 2 destroys + recreates the `proc-lab` world per seed (a `proc-*` safety guard prevents
touching other worlds). Don't run it against a world you care about.

### 4. Genesis-v2 — Hermes + LLM (legacy stack)
```bash
scripts/genesis-v2-mint-profiles.sh                     # one-time: ~/.hermes/profiles/colony-*
MC_HOST=localhost bash scripts/genesis-v2.sh new-run --seed 800
bash scripts/genesis-v2.sh stop
```
Runs Paper + 3 bot bodies (Pip:3005, Mox:3007, Zee:3006) + `hermes gateway` + poller.
See [`genesis-v2-runbook.md`](genesis-v2-runbook.md).

Two prerequisites aren't met by a fresh local install: the **`sqlite3` CLI** (`mc bot checkout`
shells out to it) and a **`road-planner` base profile** (cloned by the mint script from the
broader landfolk/colony onboarding, not covered here). The underlying embodied loop *is*
verified locally — see § Open-world play.

### 5. Open-world play — one companion bot + Hermes
```bash
server/local-start.sh
MC_HOST=localhost MC_PORT=25565 ./start-steve.sh        # bot + hermes agent loop
```

## Dependency tiers (what each path needs)

| Path | Server | Multiverse | Hermes/LLM |
|---|:--:|:--:|:--:|
| Context tests | – | – | LLM key for grading runs only |
| Arena/functional | ✓ | world `landfolk-test` | – |
| World-gen | ✓ (or `--pass1-only`=none) | ✓ | – |
| Genesis-v2 | ✓ | ✓ | ✓ |
| Open-world play | ✓ | world `landfolk-test` | ✓ |

---

## Server components & configuration

`server/local-setup.sh` configures all of this; the table shows *what* the project depends
on server-side and *why*.

| Component | Status | Why / what breaks without it |
|---|---|---|
| **Paper 1.21.4** | required | World sim; matches `mineflayer` 4.37 + cubiomes `MC_1_21`. |
| **Multiverse-Core 5.7.x** | required | Named worlds so `/execute in <world>` resolves; `mvtp`/`mv create/delete` for tests + world-gen. Setup pins a stable `release`. |
| **Worlds** `landfolk-test`, `proc-lab-bootstrap` | required | `landfolk-test` = arena/genesis/open-world (NORMAL terrain, safe spawn platform at `0,65,0`, persisted gamerules: peaceful, no mob-spawn/daylight/weather, keepInventory, `forceload add 0 0`); `proc-lab*` = world-gen scratch (created/destroyed per seed). |
| **`spigot.yml` anti-cheat loosened** | required for bots | `moved-too-quickly-multiplier: 1000.0`, `moved-wrongly-threshold: 4.0`. Otherwise Mineflayer pathing trips Paper's anti-cheat and the bot is disconnected in cave/complex movement (the flat arena rarely hits it, so tests pass without it). Tune via `SPIGOT_*` env in `server/local-common.sh`. |
| **`bukkit.yml connection-throttle: 0`** | required for multi-bot | Default `4000` ms disconnects bot bodies on reconnect storms (genesis-v2 runs 3 bodies). **Takes effect on next server start** (read at boot, not by `reload`). |
| **`online-mode=false`** | required | Offline bots (no Mojang auth). Set in `server.properties`. |
| **Native TCP rcon** `:25575` | required | The local replacement for ssh+docker+rcon-cli. Password in `~/.config/hermescraft/local-rcon.pass`. |
| **Operator** | needed for in-game admin | In offline mode nobody is op, so `/mv`, `/tp`, `/gamemode` are denied in-game and Multiverse looks uninstalled. Setup ops **re44** by default (`OP_PLAYERS`); op others via `server/op.sh <YourName>`. **Bots don't need op** — the harness uses rcon (op-level) + the bot HTTP API. |
| **PaperMCP plugin** (`:25577`, token) | **optional** | External Paper plugin (not in this repo; `PAPERMCP_TOKEN` in repo `.env`). Enables the bot's server-side craft fallback (boat/3×3/bonemeal), `set_home`/`respawn`, and the dashboard's `mv list`/`mv where` tracking. Degrades silently without it; everything else works. |
| **squaremap** (web map) | optional | Dashboard live-map iframe only. |

## Server ops cheatsheet

```bash
server/local-setup.sh        # one-time: download + configure + worlds + anti-cheat (idempotent)
server/local-start.sh        # start (waits until rcon answers)
server/local-stop.sh         # graceful stop (saves worlds)
server/op.sh re44            # op a player for in-game /mv, /tp, /gamemode (offline mode)
server/rcon.sh "list"        # send rcon command(s) over TCP
server/rcon.sh "mv list"     # Multiverse worlds
tail -F /tmp/hermescraft/server/paper.log
```

## Teardown / reset

```bash
scripts/local-down.sh                      # stop bots + server
rm -rf server/world* server/landfolk-test server/proc-lab*   # wipe worlds (re-run local-setup.sh after)
```

## Troubleshooting

- **`/mv` does nothing in-game / "unknown command"** — you're not op (offline mode ops only
  `re44` by default). `server/op.sh <YourName>`, then re-join. Multiverse *is* installed
  (`server/rcon.sh "mv list"` proves it — rcon is op-level).
- **17 Tier-1 failures, `spawnSync sqlite3 ENOENT`** — install the `sqlite3` CLI (see toolchain).
- **`rcon.mode='tcp' not supported`** — old `tests/_lib/rcon.py`; this branch adds the TCP transport.
- **`That position is not loaded`** — the arena `forceload`s before writes; outside tests, `forceload add` first.
- **Bot won't connect** — server needs `online-mode=false` (set by `local-setup.sh`); check `server/rcon.sh "list"`.
- **Port in use** — another Paper/bot is up; `scripts/local-down.sh` or change ports in `server/local-common.sh`.
- **mapcatalog `mv confirm` flow** — needs a stable Multiverse-Core (`local-setup.sh` pins a `release`).

## Containerize later (not done yet)

Natural image boundaries: a **`paper`** image (Paper + Multiverse + worlds, rcon `:25575`,
MC `:25565` — the only stateful piece), a **`bot`** image (Node + `bot/` + mineflayer patches,
one per body, `MC_HOST=paper`), and a **`toolbox`** image (Python `.venv` + `mapcatalog` +
cubiomes + pytest, talking rcon/HTTP to the others). A `docker-compose.yml` wiring
`paper` + `bot(tester)` + `toolbox` would make `pytest -m functional` a one-command CI job;
deferred deliberately, with the rcon/world/port conventions here mapping 1:1 onto compose services.

## Files this setup adds/edits

- **New**: `scripts/local-install.sh`, `server/local-{common,setup,start,stop}.sh`, `server/rcon.sh`,
  `scripts/local-{up,down}.sh`, `server.local.yaml` (gitignored), this doc.
- **Edited**: `tests/_lib/rcon.py` (TCP transport), `config/hermescraft.yaml` (`$overrides.local`).
- **Untouched**: `server/start.sh`, all bot/`mc`/test logic.

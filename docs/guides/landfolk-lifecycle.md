# Landfolk lifecycle

How to bring the Landfolk fleet up, down, and back up cleanly. Use this guide instead of inventing ad-hoc starts.

## TL;DR

**`scripts/landfolk` is the ONE entry point.** Don't run `start-landfolk.sh` (deprecated — it races the lifecycle and tears down the running session on error), don't run `landfolk-control.sh` directly except for advanced debugging.

```bash
scripts/landfolk start       # bring up the roster (sticky in /tmp/hermescraft/active-players)
scripts/landfolk status      # see what's up — players, daemons, gateway, dispatcher, board
scripts/landfolk stop        # shut everything down (bots, daemons, gateway, dispatcher)
scripts/landfolk enable  <p> [<p> ...]  # add player(s) to roster + start (space- or comma-separated)
scripts/landfolk disable <p> [<p> ...]  # remove player(s) from roster + stop
```

## What `landfolk start` actually does

In order:

1. **Resolves the roster** — `/tmp/hermescraft/active-players`. Per-player mode is `auto` (= continuous for orchestrators like Steward, kanban for everyone else), `kanban`, or `continuous`.
2. **For each roster player**, calls `scripts/landfolk-control.sh enable --profiles <player>`. Inside that:
   - `start_bot` — spawns a backgrounded `( … ) &` subshell that runs `node server.js` in a restart loop. Subshell tagged `landfolk:bot-loop:<Name>` via `exec -a` (`ps -ax | grep landfolk:` makes it greppable).
   - `start_watchdog` — backgrounded subshell tagged `landfolk:watchdog:<Name>`. Polls `/health`, force-reconnects on disconnect, recovers stuck tasks.
   - `start_agent` (continuous mode only) — backgrounded subshell tagged `landfolk:agent-loop:<Name>`. Runs the per-round Hermes chat loop.
3. **Starts the listener daemon** — `scripts/steward-chat-listener.py` (in-game chat → kanban triage cards).
4. **Ensures the gateway is running** — `hermes gateway run --replace` (idempotent; skips if already up).
5. **Ensures the standalone dispatcher is running** — `scripts/landfolk-dispatcher.sh` (out-of-process kanban worker dispatcher; the gateway-embedded one is disabled via `kanban.dispatch_in_gateway: false` because it wedges).

After step 5, status renders.

## Subsystems at a glance

```
┌─ MC server (192.168.1.202:25565) ────────────────────────┐
│                                                          │
│ ┌─ bot-loop:Steward ─┐    ┌─ bot-loop:Flint ─┐    …      │
│ │ node server.js     │    │ node server.js   │           │
│ │   ↳ /health :3005  │    │   ↳ /health :3002│           │
│ └────────────────────┘    └──────────────────┘           │
│ ┌─ watchdog:Steward ─┐    ┌─ watchdog:Flint ─┐    …      │
│ │ poll + reconnect   │    │ poll + reconnect │           │
│ └────────────────────┘    └──────────────────┘           │
│ ┌─ agent-loop:Steward ─┐  (Flint/Mason have no agent —   │
│ │ Hermes chat loop     │   they're kanban-driven workers)│
│ └──────────────────────┘                                 │
│                                                          │
│ ┌─ steward-chat-listener.py ─┐                           │
│ │ in-game chat → kanban      │                           │
│ └────────────────────────────┘                           │
│                                                          │
│ ┌─ hermes gateway ─┐ ┌─ landfolk-dispatcher.sh ─┐        │
│ │ pid in pgrep -af │ │ kanban dispatch loop     │        │
│ │ "hermes gateway  │ │ every 60s                │        │
│ │  run"            │ │                          │        │
│ └──────────────────┘ └──────────────────────────┘        │
└──────────────────────────────────────────────────────────┘
```

## Diagnostic — process inventory

Per running bot, you'll see (substitute `<Name>`):

```text
landfolk:bot-loop:<Name>     /dev/stdin <Name> <port> ...
landfolk:watchdog:<Name>     /dev/stdin <Name> <port> /tmp/hermescraft/watchdog-<name>.log
landfolk:agent-loop:<Name>   /dev/stdin <Name> <port> ...   # continuous mode only
node server.js                                                # child of bot-loop
```

Useful one-liners:

```bash
ps -ax -o pid,command | grep -o 'landfolk:[^ ]*' | sort -u   # all role tags
pgrep -af 'landfolk:bot-loop:'                                # just bot loops
pgrep -af 'landfolk:agent-loop:'                              # continuous agents
pgrep -af 'hermes gateway run'                                # gateway pid
pgrep -af 'landfolk-dispatcher\.sh'                           # dispatcher pid
ps -ax -o pid,ppid,command | grep 'node server.js'            # ↳ ppid = bot-loop subshell pid
```

If a `node server.js` PID's parent doesn't match a `landfolk:bot-loop:` subshell, it's a foreign bot — probably from `start-landfolk.sh.deprecated`. Kill it.

## Failure modes & recovery

### Zombie node bot (alive but unresponsive)

**Symptom:** `landfolk status` shows a bot UP but `/health` doesn't respond; `lsof -iTCP:<port>` empty.

**Cause:** Bot crashed on `EADDRINUSE` (or another listen error) but didn't fully exit — see [`[BUG] bot/server.js doesn't exit on EADDRINUSE`](../../scripts/landfolk-control.sh#start_bot). The bot-loop's `node server.js` line never returns, so the restart while-loop is stuck.

**Recovery (automatic):** `scripts/landfolk start` now detects this — if pidfile loop is alive but `/health` is dead, it `pgrep -P` the loop, kills the zombie node, and lets the loop respawn cleanly.

**Recovery (manual):**

```bash
loop_pid=$(pgrep -f 'landfolk:bot-loop:Steward' | head -1)
zombie=$(pgrep -P "$loop_pid")
kill -TERM $zombie    # the bot-loop's while-loop will respawn within 5s
```

### Dispatcher stopped (no workers spawning)

**Symptom:** `landfolk status` shows `kanban dispatcher NOT running`; cards stuck in `ready`, `running=0`.

**Cause:** Manually restarted the gateway via `hermes gateway run` (or it was SIGTERM'd). The standalone dispatcher is independent — gateway restart doesn't bring it back.

**Recovery:** `scripts/landfolk start` (idempotent — only the missing dispatcher will be brought up).

### Gateway wedge (process alive, dispatcher loop silent)

**Cause:** Used to happen with `kanban.dispatch_in_gateway: true`. We disabled that — dispatcher is now out-of-process (`landfolk-dispatcher.sh`). If the gateway's *own* process wedges (no logs in `~/.hermes/logs/gateway.log` for >5 min), restart it: `scripts/landfolk start --restart-gateway`. The dispatcher keeps running independently.

### Multiple `landfolk-control.sh enable …` shells per bot

**Not a bug** — those are the three role-loop subshells (bot-loop, watchdog, agent-loop) which inherit the originating script's argv. They now self-identify via `exec -a "landfolk:<role>:<Name>"` so you can tell them apart at a glance.

### Bots disconnected right after `landfolk start` showed them up

**Suspect:** something else (legacy script, manual `node server.js`, second `landfolk start` in another terminal) is racing. Check:

```bash
ps -ax -o pid,etime,command | grep -E 'node server.js|start-landfolk' | grep -v grep
```

If you see anything from `start-landfolk.sh.deprecated`, that's the racer — it's been disabled but still kill its leftover processes. The deprecation also tells you who did it.

### "No cards available to work on" / empty roster

**Symptom:** `landfolk status` reports `no active roster` (with a "roster drift detected" warning naming live bots NOT in the roster), `no kanban workers running`, and dispatcher log shows `tick: idle` continuously.

**Sequence to diagnose:**

```bash
scripts/landfolk status                 # check roster vs. live bots
scripts/board                           # board stats — what's in ready/blocked/todo
scripts/board list --status ready       # who's the assignee on ready cards?
```

Three failure shapes to distinguish:

1. **Roster drift** — bots are running on MC but not in `/tmp/hermescraft/active-players`. The dispatcher only spawns workers for roster members. Fix: `scripts/landfolk enable flint mason steward` (accepts space- or comma-separated names).
2. **Ready card assigned to an offline bot** — typical when Steward (the orchestrator) is the assignee of a card that needs *decomposition* before workers can claim children. Fix: bring Steward up (`scripts/landfolk start --players steward` or `landfolk enable steward`). Once she splits the parent into worker cards, Mason/Flint will pick them up automatically via the plugin's gate-check.
3. **All worker cards blocked / superseded** — every Mason/Flint card has `status=blocked` from prior triage (e.g. "superseded: wrong plan, use X after cleanup"). Fix: have Steward read the blocked column and either unblock with new direction or archive the supersedees so the queue isn't cluttered.

The recurring case: `ready=1, blocked=3, running=0` with the only ready card assigned to Steward — Steward is the lever.

## Model layering (two config files, both must match)

| File | Consumer | Affects |
|------|----------|---------|
| `data/agent-models.json` | Hermescraft scripts (`resolve-agent-model.py`) | Bot-process LLM env (`AGENT_MODEL`); Steward's continuous-agent loop |
| `~/.hermes/profiles/<name>/config.yaml` `model.default` | Hermes CLI (`hermes -p <name>`) | Kanban-worker subprocess model (the LLM the dispatcher-spawned worker talks to) |

If you change one without the other, you'll see expected-vs-actual surprises (e.g. bot reports model X in `/health`, but workers run model Y). Keep them in sync. A `scripts/sync-profile-models.py` helper to enforce this is on the backlog.

## Hard rules

- **Use `scripts/landfolk` for everything.** Don't invoke `landfolk-control.sh` or `hermes gateway run` directly except for advanced debugging.
- **One operator at a time.** Don't run `scripts/landfolk start` in two terminals simultaneously — the second one may see partial state and either short-circuit or race.
- **`scripts/landfolk start` is idempotent.** Running it again won't disrupt running bots; it just brings up what's missing.
- **Stop before reconfiguring.** If you change `data/agent-models.json` or a profile's `config.yaml`, restart the affected bot. Live config reload is not implemented.

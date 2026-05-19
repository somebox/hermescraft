# Running Steve against ubuntu-host

Runbook for starting Steve as a Hermes-driven companion connected to the
dedicated Paper server on `ubuntu-host` (`192.168.1.202:25565`).

The `./start-steve.sh` flow in the README assumes a LAN single-player world
(prompts for a LAN port, opens a new terminal). For the dedicated server
use **`./scripts/run-steve.sh`** — single idempotent command, no prompts,
predictable log paths. The rest of this doc documents the moving parts;
the script does it all.

## TL;DR

```bash
./scripts/run-steve.sh                  # one-shot start (or restart) Steve
scripts/watch-steve.py --tail 20        # live structured log
scripts/watch-advise.py                 # live digest pipeline log
```

FPV viewer: <http://localhost:4001/>. Dashboard (main hermes):
<http://localhost:9119/>. Fleet dashboard: <http://localhost:3000/>
(start separately with `./start-dashboard.sh`).

## For QA test runs: use `scripts/exp.sh` instead

For structured, observable test runs (long expeditions, postmortem-ready
log capture), use the per-run logging harness in
[`docs/experiments/run-logging.md`](experiments/run-logging.md). It
launches the same agent + bot but adds:

- One dir per run at `/tmp/hermescraft/runs/<YYYYMMDD-HHMMSS-slug>/`
- `positions.jsonl` (30 s polls) + `events.jsonl` (death, low_hp,
  nav_error, midcheck) for objective post-analysis
- `current` symlink so monitoring scripts find the active run without
  hardcoding the ID
- `scripts/exp.sh watch` — single live tail of thinking + tool calls +
  positions + events (merged)

```bash
scripts/exp.sh start expedition         # create run dir, launch agent + poller
scripts/exp.sh watch                    # one-pane live view (Ctrl-C to exit)
scripts/exp.sh status                   # one-shot snapshot
scripts/exp.sh midcheck                 # write timestamped snapshot to disk
scripts/exp.sh analyze [<run-id>]       # distance / events / pace stats
scripts/exp.sh stop                     # kill agent, write summary, clear current
```

`run-steve.sh` is still the way to launch Steve for ad-hoc / chore play.
Use `exp.sh` when you want the run to produce a structured postmortem.

## Prereqs

- Hermes 0.14+ installed (`hermes --version`).
- `~/.hermes/config.yaml`, `~/.hermes/auth.json`, `~/.hermes/.env` populated.
- Paper server reachable: `nc -z -w 2 192.168.1.202 25565` returns OK.
- Port `3001` free on this machine (Steve's bot body API).
- Cwd: `/Users/foz/hermescraft`.

## First-time setup of Steve's home

Steve runs with `HERMES_HOME=~/.hermes-landfolk-steve` so his memories,
sessions, and config are isolated from the main Hermes profile.

```bash
mkdir -p ~/.hermes-landfolk-steve/{memories,sessions}
cp SOUL-landfolk.md       ~/.hermes-landfolk-steve/SOUL.md
cp ~/.hermes/config.yaml  ~/.hermes-landfolk-steve/config.yaml

# Symlink shared auth + copy env
ln -sf ~/.hermes/auth.json ~/.hermes-landfolk-steve/auth.json
ln -sf ~/.hermes/auth.lock ~/.hermes-landfolk-steve/auth.lock
cp ~/.hermes/.env          ~/.hermes-landfolk-steve/.env
```

Then raise `agent.max_turns` from the default 90 to something appropriate
for an embodied chore loop. `start-steve.sh`'s `sed` for `max_iterations`
edits a vestigial field — the real cap is `agent.max_turns`. Edit
`~/.hermes-landfolk-steve/config.yaml`, find the `agent:` block near the
top, change `max_turns: 90` to `max_turns: 300`.

## Start

```bash
./scripts/run-steve.sh
```

What it does (in order):
1. Kills any existing Steve agent + bot processes; frees ports 3001 and 4001.
2. Launches the Mineflayer bot via `scripts/run-steve-bot.sh` with
   `MC_HOST=192.168.1.202`, `VIEWER_PORT=4001`, API on `:3001`.
3. Waits up to 25 s for the bot to handshake with the MC server.
4. Launches the Hermes agent via `scripts/run-landfolk-agent.sh` with
   `MC_FORCE_REASON=1` (forces observation commands through the digest
   pipeline — see [perception-digest.md](perception-digest.md)).
5. Prints the canonical follow commands.

Env overrides (rarely needed):
- `MC_HOST` (default `192.168.1.202`), `MC_PORT` (`25565`)
- `API_PORT` (`3001`), `VIEWER_PORT` (`4001`)
- `AGENT_HOME` (`~/.hermes-landfolk-steve`), `LOG_DIR` (`/tmp/hermescraft`)
- `NO_AGENT=1` to launch just the bot body without a brain

Model + provider are resolved from `data/agent-models.json`
(`entrypoint.run_landfolk_agent`, currently `deepseek/deepseek-v4-flash`
on openrouter).

## Verify

```bash
# Bot body up + in the right world
curl -sS http://localhost:3001/health | python3 -m json.tool

# MC server-side player list (over SSH/RCON)
ssh -n ubuntu-host "sudo docker exec minecraft rcon-cli 'list'"
# expect: "Steve" present, listed once
```

## Monitor

The session JSON in `~/.hermes-landfolk-steve/sessions/session_*.json`
is the canonical agent record. Read it with the pretty-tailer (clean,
no ANSI noise, auto-switches on restart):

```bash
scripts/watch-steve.py                 # follow live
scripts/watch-steve.py --tail 20       # backfill recent history first
scripts/watch-steve.py --reasoning     # include hidden thoughts
```

For just the digest pipeline (`mc scene/map/find/nearby` + `mc advise`):

```bash
scripts/watch-advise.py                # follow new entries
scripts/watch-advise.py --last 10 --full
scripts/watch-advise.py --kind map     # filter to one command kind
```

Raw stdout (debug only — ANSI noise, line-wrap artifacts):

```bash
tail -F /tmp/hermescraft/agent-steve.log   # hermes TUI stdout
tail -F /tmp/hermescraft/bot-steve.log     # bot/server.js stdout
```

## Stop

```bash
pkill -f 'run-landfolk-agent.sh Steve'   # hermes brain
pkill -f 'MC_USERNAME=Steve'             # bot body env match
# Fallback if the node child outlived its parent env match:
lsof -ti tcp:3001 | xargs -r kill
```

Or just re-run `./scripts/run-steve.sh` — it kills and restarts in one
command.

Confirm with `ssh -n ubuntu-host "sudo docker exec minecraft rcon-cli 'list'"` —
Steve should drop from the player list.

## Gotchas

- **Wrong world.** `hermescraft/server/` ships its own local Paper server
  (used by `./hermescraft.sh`). `run-steve.sh` sets `MC_HOST=192.168.1.202`
  for you. If you call `run-steve-bot.sh` directly, pass it explicitly.
- **`agent.max_turns: 90` is too tight for embodied chore loops.**
  `~/.hermes-landfolk-steve/config.yaml` should set it to 300+. A walk
  + observe + act cycle easily exhausts 90 turns before useful output.
- **Per-response token cap interacts with `reasoning_effort`.** Even
  with `model.max_tokens: 16384`, deepseek-v4-flash at
  `reasoning_effort: medium` blows the completion budget mid-tool-call
  (`finish_reason='length'`, hermes rolls back and stalls). Set
  `agent.reasoning_effort: low` in Steve's config.
- **`env_passthrough` must include MC_FORCE_REASON + OPENROUTER_API_KEY.**
  The default `[]` blocks env vars from reaching `mc` subprocesses. Steve's
  config sets `[MC_API_URL, MC_USERNAME, MC_FORCE_REASON, OPENROUTER_API_KEY]`.
- **`start-steve.sh` sed targets are vestigial** (edits a non-firing
  `max_iterations` field). Use `run-steve.sh` instead.
- **Duplicate bots.** If a previous Steve crashed without freeing the
  port, the new bot binds a different port (or fails silently).
  `run-steve.sh` frees 3001+4001 before launching. Confirm only one
  `Steve` is in the MC server `list` output — a stale Mineflayer session
  can keep a ghost player logged in.
- **Tool-call format noise on deepseek-v4-flash.** Occasional `mc` calls
  arrive with template-language artifacts in args
  (`mc marks</｜DSML｜...>15`). The bot rejects them `[error]` and the loop
  continues; not blocking, but worth grep-ing the log if behavior looks off.
- **`[error]` tag in the TUI stdout is not always a real failure.** Hermes
  0.14 sometimes flags long-running tool calls as `[error]` cosmetically
  even when exit code is 0 and the envelope is `ok:true`. Cross-check
  with `scripts/watch-advise.py` (digest jsonl) or `scripts/watch-steve.py`
  (session JSON) which read structured sources.

# 2026-05-24 — Session handover

End-of-day notes from a multi-hour kanban experiment session covering: a Steve
companion test, a Flint/Mason kanban workflow on board `landfolk-ops`, plus
seven follow-on infrastructure improvements that shipped as a result of
issues surfaced during the run.

Quick links:
- Companion test postmortem: [2026-05-24-flint-iron-mining-deep-shaft.md](2026-05-24-flint-iron-mining-deep-shaft.md)
- Active steward proposal (now shipped): `scripts/steward-supervisor.py`
- Chat-driven steward (shipped): `scripts/steward-chat-listener.py`

## TL;DR

Started with a Steve companion test. Hit several Mineflayer 4.37 movement-anti-cheat
disconnects in cave work. Diagnosed the root cause (Paper's `moved-too-quickly`
trigger × Mineflayer pathfinder), shipped a bot-side fix (slow-mode movement
profile), and used the rest of the session to harden the kanban workflow that
exposed the problem: better docs, recovery primitives, and an active steward
supervisor that auto-reviews blocked cards.

Both bots ran the final ~2 hours with **zero anti-cheat kicks** and clean
worker handoffs.

## What's working (end of day)

- **Steve, Flint, Mason** all run in slow-movement profile (no parkour, no sprint,
  3× jump cost) — Paper's strict anti-cheat doesn't kick them mid-cave.
- **Spigot anti-cheat thresholds** are loosened to `moved-too-quickly-multiplier: 1000.0`
  and `moved-wrongly-threshold: 4.0` on `ubuntu-host:minecraft` (live via
  `spigot reload`, persisted in `/data/spigot.yml`).
- **`mc region_create`** has corrected help showing the profile→intent default
  mapping (base/farm/dock=protect, mine=resource) plus a `--intent marker`
  example for build-anchor regions.
- **`mc region_update_intent <id> <intent>`** lets the steward switch a
  region's intent in-place when the default turned out to be wrong.
- **`mc edit_sign X Y Z "text" [--back]`** wraps `bot.updateSign` — workers can
  author placemark text on signs they place (or any existing sign in reach).
- **`mc region_create`** + **`mc move`/`mc goto`/`mc bg_goto`** no longer crash
  on preflight retarget/Y-adjust (the `const { x, y, z } = c` reassignment bug
  is fixed — `let { x, y, z } = c` in both `goto.js` and `move.js`).
- **`mc craft_plan`** surfaces the user-friendly material name in missing
  entries (e.g. `cobblestone` instead of recipe-canonical `cobbled_deepslate`)
  via tag-equivalence lookup; recipe_canonical + equivalents fields are also
  in the structured output.
- **Landfolk control** has `BOT_MOVEMENT_PROFILE`, `VIEWER_PORT`, and
  `WATCHDOG_CONNECT_ONLY` env vars wired through to the bot process. Watchdog
  forces `{"force":true}` on its `/connect` retry which breaks the Mineflayer
  4.37 "session replacement already in flight" deadlock.
- **Worker SOULs (flint, gatherer, mason)** include an explicit *"use `mc <verb>`
  only, NEVER raw curl"* rule with motivated reasoning. SOUL template is in
  `scripts/setup-landfolk-profiles.sh` so re-runs preserve it.
- **`SOUL-landfolk.md`** is back to slim canonical — load specialised
  guidance via on-demand skills.
- **`~/.hermes/skills/gaming/minecraft-mining/SKILL.md`** captures the
  underground-discipline playbook (pre-mining checklist, primitive preference
  order, stuck-mining pivot, escape protocol with 6-adjacent inspect, read-
  your-own-error-envelopes pattern).
- **Steward chat listener** (`scripts/steward-chat-listener.py`) polls Flint's
  chat for `@steward <message>` from re44 and creates triage cards
  automatically.
- **Steward supervisor** (`scripts/steward-supervisor.py`) polls blocked
  kanban cards and creates `[SUPERVISE]` triage cards for the steward to
  review — capped at 2 supervisions per card to prevent loops.

## Session metrics

- **Bots brought up:** Steve (briefly), Flint, Mason, Gatherer (started
  accidentally; deactivated via profile description)
- **Anti-cheat kicks before slow-mode fix:** ~7 across multiple sessions
- **Anti-cheat kicks after slow-mode fix:** **0** across both bots over ~2 hours
- **Mineflayer reconnect deadlocks fixed manually:** 5 (workaround was
  `curl -X POST :3002/connect '{"force":true}'`). Auto-fix shipped.
- **Cards completed:** survey base, scout iron prospect, mine iron, craft
  hoe+bucket, scout hut site, supply hut materials (partial), region :hut3:
  marker placement, librarian bamboo research
- **Cards still blocked at EOD:** construct Hut 3 layers 0-1 (anchor was
  resolved but needs steward re-decompose with anchor IN body, not sibling
  comment ref)
- **Workers self-blocked with structured handoff (good behavior):** at least 3
  — these are the prompts the supervisor will pick up automatically

## Tasks shipped this session

| # | Title | Status |
|---|---|---|
| #1 | Teach landfolk agents to self-manage inventory on INVENTORY_FULL | ✓ Done |
| #2 | Make Hermes companion mode survive turn-end + bot reconnect | ✓ Done |
| #3 | Track down `Assignment to constant variable` pathfinder bug | ✓ Done |
| #4 | Kanban worker: 27-49s `hermes_tools` python re-import | ✓ Reframed (not actually slow imports — batched scouting) |
| #5 | `mc craft_plan stone_pickaxe` returns wrong ingredient | ✓ Done |
| #6 | Active steward supervisor | ✓ Done |
| #7 | Slow-mode pathfinder Movements profile | ✓ Done |
| #9 | Mineflayer reconnect deadlock | ✓ Done |
| #11 | `mc edit_sign` verb | ✓ Done |
| #12 | Region intent default + `region_update_intent` | ✓ Done |

## Tasks still open

- **#8** — Bisect F58 pathfinder arrival tolerance (0.20 → 0.25). Lower priority
  now that slow-mode mitigates the symptom.
- **#10** — Steward decompose must write resolved anchors INTO child card
  bodies (not sibling-comment refs). Caused Mason's open-ocean trip. Today's
  manual stewardship worked around it; systemic fix lives in the
  `minecraft-steward-blueprint-plan` skill or `scripts/blueprint-plan.py`.

## Procedures for next session

### Bring up the kanban test stack

```bash
cd ~/hermescraft

# Bots — slow-mode + connect-only watchdog
MC_HOST=192.168.1.202 VIEWER_PORT=4002 BOT_MOVEMENT_PROFILE=slow WATCHDOG_CONNECT_ONLY=1 \
  ./scripts/landfolk-control.sh enable --profiles flint

MC_HOST=192.168.1.202 VIEWER_PORT=4003 BOT_MOVEMENT_PROFILE=slow WATCHDOG_CONNECT_ONLY=1 \
  ./scripts/landfolk-control.sh enable --profiles mason

# Kill the continuous landfolk agent that 'enable' spawns
# (we want kanban-only mode — the watchdog stays in connect-only)
for who in flint mason; do
  pf="/tmp/hermescraft/landfolk-control/agent-${who}.pid"
  [ -f "$pf" ] && kill "$(cat "$pf")" 2>/dev/null
  rm -f "$pf"
done

# Hermes gateway (decompose + dispatch)
hermes gateway start &

# Steward chat listener (re44 can say @steward in-game)
nohup python3 scripts/steward-chat-listener.py \
  > /tmp/hermescraft/steward-listener.log 2>&1 &
disown

# Steward supervisor (auto-review blocked cards)
nohup python3 scripts/steward-supervisor.py \
  > /tmp/hermescraft/steward-supervisor.log 2>&1 &
disown
```

### Shut everything down

```bash
cd ~/hermescraft
./scripts/landfolk-control.sh stop --profiles flint,mason,gatherer
pkill -f "steward-chat-listener\|steward-supervisor"
pkill -f "hermes_cli.*gateway"  # only if you started it this session
```

### Bot-only restart (preserve chat buffer + worker state)

```bash
# Reclaim active cards first so workers exit cleanly
hermes kanban --board landfolk-ops reclaim <task_id> --reason "bot restart"

# Stop + start (keeps watchdog config consistent)
./scripts/landfolk-control.sh stop --profiles flint
MC_HOST=192.168.1.202 VIEWER_PORT=4002 BOT_MOVEMENT_PROFILE=slow WATCHDOG_CONNECT_ONLY=1 \
  ./scripts/landfolk-control.sh enable --profiles flint

# Strip the agent the start re-spawned
pf=/tmp/hermescraft/landfolk-control/agent-flint.pid
[ -f "$pf" ] && kill "$(cat "$pf")" 2>/dev/null; rm -f "$pf"
```

### Force-reconnect a wedged bot

```bash
# When health reports connected=false but the server's player list shows online,
# Mineflayer is deadlocked. Force-reconnect breaks the latch.
curl -sS -X POST http://127.0.0.1:3002/connect \
  -H "Content-Type: application/json" -d '{"force":true}'
```

The watchdog now does this automatically (every WATCHDOG_INTERVAL_S, default 8s,
with a 45s cooldown between attempts), but the manual command remains for
ad-hoc poking.

### Send work to the steward via in-game chat

With `steward-chat-listener.py` running, any chat message from re44 (or any
non-bot player) containing `@steward <message>` creates a triage card and
auto-decomposes. Try:

```
@steward please scout the area east of base for cows we can breed for leather
```

Within ~5s a triage card lands on `landfolk-ops` and the steward starts work.

### Steward review of blocked cards

With `steward-supervisor.py` running, any card that's been `blocked` for >60s
gets a `[SUPERVISE]` triage card auto-created (max 2 supervisions per block).
The steward worker decides: unblock+comment, decompose, reassign, or confirm
the block. State persists at `~/.steward-supervisor-state.json`.

### Verify spigot anti-cheat config is loose enough

```bash
ssh ubuntu-host "sudo docker exec minecraft grep -E 'moved-too-quickly|moved-wrongly' /data/spigot.yml"
# expect:
#   moved-wrongly-threshold: 4.0
#   moved-too-quickly-multiplier: 1000.0
```

If somehow reverted (e.g. minecraft container was rebuilt), re-run:
```bash
bash ~/homelab/scripts/relax-paper-movement.sh
```

## Known gotchas / open questions

- **`landfolk-control.sh enable --profiles X`** still starts the continuous
  landfolk agent even though we only want the bot + connect-only watchdog
  for kanban mode. You must strip the agent pidfile after start. Worth a
  follow-up env var: `LANDFOLK_AGENT=0` perhaps.
- **Dispatcher allowed 2 concurrent Flint workers** once when I reassigned a
  gatherer card to flint. Solo-flint mode should serialize per assignee. Not
  re-triggered after I added explicit `kanban link` between the cards.
- **Steward blueprint-plan decompose** writes "anchor in scout's comment"
  instead of materializing the coords into child bodies. Task #10 — caused
  Mason's open-ocean trip. Workaround: post a steward comment with explicit
  coords whenever a chain has scout→construct handoffs.
- **Local Paper server** on this Mac (`java` listening on `:25565`) is a
  leftover from `hermescraft/server/`. Not used by ubuntu-host workflow but
  consumes one whitelist slot if a bot ever connects to localhost by mistake.

## Files touched this session

### `hermescraft/`
- `SOUL-landfolk.md`
- `bot/cli/dispatch.mjs`
- `bot/cli/registry.mjs`
- `bot/lib/actions/interaction.js`
- `bot/lib/actions/movement/goto.js`
- `bot/lib/actions/movement/move.js`
- `bot/lib/actions/regions/create.js`
- `bot/lib/runtime/manager.js`
- `bot/lib/shared/recipe-ingredients.js`
- `bot/test/bot-manager.test.js`
- `bot/test/crafting.test.js`
- `docs/design/phase-3/steward-mvp.md`
- `docs/guides/running-steve.md`
- `reports/expedition/2026-05-24-flint-iron-mining-deep-shaft.md` (new)
- `reports/expedition/2026-05-24-session-handover.md` (this file, new)
- `scripts/landfolk-control.sh`
- `scripts/run-steve.sh`
- `scripts/setup-landfolk-profiles.sh`
- `scripts/steward-chat-listener.py` (new)
- `scripts/steward-supervisor.py` (new)

### `homelab/`
- `scripts/relax-paper-movement.sh` (new)

### Profile/skill state (~/.hermes — not tracked)
- `~/.hermes/profiles/{flint,gatherer,mason}/SOUL.md` (regenerated from
  template; preserves backups as `SOUL.md.bak-YYYYMMDD-HHMMSS`)
- `~/.hermes/profiles/steward/skills/gaming/minecraft-steward-survey/SKILL.md`
  (canonical from `skills/minecraft-steward-survey.md`)
- `~/.hermes/skills/gaming/minecraft-mining/SKILL.md` (new — underground
  discipline playbook for workers)
- `~/.hermes-landfolk-{steve,...}/SOUL.md` (slim, synced from
  `SOUL-landfolk.md`)

### Server-side (ubuntu-host)
- `/data/spigot.yml` inside the `minecraft` container — anti-cheat thresholds
  loosened (1000× / 4.0). Persists across container restarts as long as the
  data volume is preserved.

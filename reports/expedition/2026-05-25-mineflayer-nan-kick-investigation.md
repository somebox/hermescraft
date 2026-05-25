# 2026-05-25 — Mineflayer NaN-position kick investigation

Multi-hour investigation into a recurring bot-kick cascade on the landfolk
fleet. Distinct from the 2026-05-24 anti-cheat-speed work — same surface
("bots getting kicked in cave work") but a different underlying bug class.
Confirmed the trigger at the protocol level, deployed two layered fixes,
shipped diagnostic instrumentation for the residual unknowns.

## TL;DR

Two distinct kick mechanisms exist in our setup. Yesterday we addressed the
first; today we found and addressed the second.

| Kick variant | Server-log signature | Trigger | Status |
|---|---|---|---|
| Anti-cheat speed | `Player moved too quickly!` / `moved wrongly!` (WARN, sometimes kicks) | mineflayer-pathfinder block-traversal speed exceeds Paper threshold | **Mitigated 2026-05-24** via Spigot threshold loosen + slow-movement profile |
| Invalid packet | `Player lost connection: Invalid move player packet received` (INFO + kick) | mineflayer's `bot.entity.position` momentarily contains null/NaN; pathfinder sends that NaN over the wire; Paper's `containsInvalidValues` validator rejects | **Mitigated today** via watchdog NaN-detection patch |

Across today's logs: Flint hit 9 invalid-packet kicks, Mason 12, **Steward 0**
(orchestrator, no pathfinder use — differential immunity). All `Invalid move
player packet received` — none `moved too quickly`. The yesterday fix didn't
address today's bug because they're different code paths.

## Evidence

### Server-side (Paper)

`docker logs minecraft | grep -E 'Flint|Mason|moved|Invalid'` produced (excerpts):

```
[04:27:01 INFO]: Mason lost connection: Invalid move player packet received
[05:54:23 INFO]: Flint lost connection: Invalid move player packet received
[06:05:14 INFO]: Mason lost connection: Invalid move player packet received
[06:06:52 WARN]: Mason moved wrongly!                ← different code path; WARN not kick
[06:53:03 INFO]: Flint drowned
[07:56:22 INFO]: Flint lost connection: Invalid move player packet received
[07:57:23 INFO]: Flint lost connection: Invalid move player packet received
[07:58:15 INFO]: Flint lost connection: Invalid move player packet received
[07:59:39 INFO]: Flint lost connection: Invalid move player packet received
```

"Invalid move player packet received" is the verbatim message from Paper's
`ServerGamePacketListenerImpl.handleMovePlayer` when its
`containsInvalidValues(x, y, z, yRot, xRot)` check fails. The check is for
NaN or Infinity in any of those five fields; it runs BEFORE any anti-cheat
speed validation. So the client (mineflayer) sent a packet with a NaN
coordinate.

### Client-side (mineflayer / bot)

Per `bot-flint.log`, each kick is preceded by zero observable activity in
the prior ~48 seconds. The bot reconnects (server-side respawn at
authoritative position), then is kicked again within 1-2 minutes. The y
descends across the cascade (65→66→63→60→51) — indicating the bot's
`dig_area` pathfinder task survives the reconnect-respawn cycle and resumes
digging downward from each new spawn.

Earlier in the session we'd seen `[reactive] hostile=<entity>@NaN → flee_step`
log lines — the reactive distance-to-threat math returned NaN. Same NaN
source as the kick packet: `bot.entity.position.x` (or `.z`) is null while
y is real.

### Differential immunity (Steward)

Steward runs as an orchestrator: continuous agent loop, read-only mc verbs
(`mc status`, `mc nearby`, `mc chat`, `mc read_chat`), never invokes
pathfinder or collectBlock. Zero kicks across the full log range. Flint and
Mason — both kanban workers using `mc dig_area`, `mc collect`, `mc fill` —
took 9 and 12 kicks respectively. **The trigger is pathfinder-driven action
on a fresh bot, not "being connected" or "doing work."**

### The drowning anomaly

Server log shows `[06:53:03] Flint drowned`. Bot log has no corresponding
`DIED!` entry; mineflayer's death event didn't fire. This is a second bug
class — missed death events leave mineflayer's local state desynced from
server state (it thinks the bot is at the drowning location; server has it
at the respawn point). Likely contributes to NaN production at the next
pathfinder calculation, but distinct from the createBot-fresh-bot pathway.
Filed for later investigation; not addressed in this round.

### Clean reconnect is already happening (red herring eliminated)

We initially suspected mineflayer state survived the reconnect. Reading
`bot/lib/runtime/manager.js:815-852` confirmed: on `bot.on('end')`, the
manager calls `createBot()` which calls `mineflayer.createBot({...})` — a
fully fresh bot instance per reconnect. UUID stays (account-persistent),
entity ID changes (per-connection). The old instance is dropped. So the
NaN-producing state is being generated anew on each fresh bot, in the
spawn → first-pathfinder-tick sequence. This sharpens the bug class
significantly — it's not "reconnect leaks state", it's "fresh mineflayer
bot can produce NaN in its first frames of pathfinder operation."

## Causal chain

1. **Trigger**: a worker (Flint or Mason) issues `mc dig_area` / `mc collect`.
   The bot's mineflayer-pathfinder begins block-traversal navigation.
2. **NaN source** (TBD precisely — instrumentation deployed to capture): some
   event in the spawn-to-first-active-tick sequence leaves
   `bot.entity.position.x` or `.z` as null/NaN. Candidates: divide-by-zero
   in velocity calc (`dt=0` on first tick after a fresh entity), missed
   respawn packet, partial teleport handling.
3. **Bot sends a `ServerboundMovePlayerPacket`** with the NaN coordinate.
4. **Paper validates**: `containsInvalidValues` returns true.
5. **Paper kicks**: `disconnect("multiplayer.disconnect.invalid_player_movement")`
   + logs `Player lost connection: Invalid move player packet received`.
6. **Server respawns the bot** at last-validated authoritative position.
7. **Mineflayer's `bot.on('end')` fires**, reconnect logic calls
   `createBot()`, fresh mineflayer instance is created, new entity ID
   assigned.
8. **The kanban worker is still running and unaware of the kick** —
   `/health` comes back online quickly, the worker keeps issuing the same
   command, pathfinder resumes, **same NaN-producing condition recurs**.
   Loop.

## Mitigations deployed (today)

### 1. Watchdog NaN-position detection (the fix)

`scripts/landfolk-control.sh:632-666` — watchdog body now parses
`/health.position`; if `x` or `z` is null or NaN while `connected === true`,
treats it as a disconnect and triggers the existing
`POST /connect --force=true` path. That force-reconnect re-instantiates
mineflayer, clearing the corrupt position state before pathfinder can send
NaN over the wire.

Smoke-tested against 4 cases of fabricated `/health` payloads
(healthy / null position / disconnected / NaN-x): all four classify
correctly. Active on all three bots after watchdog restart at ~10:33.

### 2. POS_DIAG instrumentation (the diagnostic)

`bot/lib/runtime/manager.js:640-680` — registers handlers on mineflayer
events `login/spawn/respawn/death/kicked/end/forcedMove/move/teleport/entityMoved`.
After each event, snapshots `bot.entity.position`; if any component is
null/NaN, logs **once on transition**:

```
[POS_DIAG] event=<event-name> CORRUPT pos=<json> connected=<bool>
```

When the next NaN cascade fires, the single log line preceding the first
`CORRUPT` will name the exact mineflayer event responsible. That's the
definitive answer to "what produces the NaN." All three bots restarted
with instrumented code by ~11:27.

### 3. Watchdog heartbeat + EXIT trap (operational hardening)

Earlier in the session, Mason's watchdog (pid 82122) died silently at
08:12:22 with no log trace. The architecture had no supervisor for the
watchdog itself. Two additions:

- **Heartbeat** (`scripts/landfolk-control.sh` watchdog body): every loop
  iteration touches `$LOG_DIR/watchdog-<name>.heartbeat`. `landfolk status`
  reads the file's mtime; if older than 3× WATCHDOG_INTERVAL_S (default 24s)
  it prints `⚠ watchdog-<name> heartbeat stale` — catches both
  "process crashed" AND "process alive but wedged" cases.
- **EXIT trap**: `trap 'rc=$?; echo "watchdog EXIT rc=$rc pid=$$"' EXIT`
  inside the watchdog body. Catches every termination route except SIGKILL.
  Verified end-to-end: killing a watchdog with SIGTERM correctly produces
  `watchdog EXIT rc=0 pid=<N>` in the watchdog log.

Combined: the absence of an EXIT log + stale heartbeat = strong inference
of SIGKILL (or OOM kill).

## Status

- **All three bots run instrumented code** as of ~11:27 (verified by
  `[POS_DIAG] instrumentation armed` in each bot log).
- **All three watchdogs run the patch** (NaN-detection + heartbeat + EXIT
  trap) as of ~11:26.
- **Heartbeats are all current** (mtime within last interval).
- **No kicks since 09:59:47** (Flint's cascade self-resolved when his
  pickaxe ran out → `mc collect` refused → no pathfinder action → no NaN).
  Clean test for the patch will require the next cascade to fire naturally.

## Files modified

| File | Change |
|---|---|
| `bot/lib/runtime/manager.js:640-680` | POS_DIAG instrumentation block (new). Snapshots position on 10 mineflayer events, logs once per CORRUPT/RECOVERED transition. |
| `scripts/landfolk-control.sh:620-666` | Watchdog body heredoc. Added: EXIT trap, heartbeat file touch per iteration, NaN-position detection that demotes `connected` to false to trigger force-reconnect. |
| `scripts/landfolk` (cmd_status) | New section reads watchdog heartbeat files and warns on staleness. |

## Open questions

1. **Which specific mineflayer event corrupts position?** POS_DIAG will
   capture this on the next cascade. Most likely candidates: first
   `move`/`forcedMove` after `spawn`, or post-`respawn` math overflow.
2. **The drowning death-event miss** (server-side death, no client-side
   death event) is a separate mineflayer bug class. Worth investigating
   separately — the symptom is the same NaN but the trigger path differs.
3. **Should we file an upstream mineflayer issue?** Holding off until
   POS_DIAG names the event. With that data point, a focused upstream bug
   report becomes possible.
4. **Should the bot validate position before sending move packets?** A
   defensive workaround in `bot/lib/runtime/manager.js` that intercepts
   move packets and drops NaN ones would prevent the kick entirely. But
   it requires hooking mineflayer's packet pipeline and is more invasive
   than the watchdog catch. Defer until the watchdog catch proves
   insufficient.

## How to verify the fixes worked

1. Wait for the next dig-heavy task on Flint or Mason. Either:
   - The watchdog detects NaN within 8s and force-reconnects → cascade
     never reaches 2+ kicks; OR
   - POS_DIAG captures the corruption event without a kick chain (because
     the watchdog reset the state in time).
2. After any future cascade:

   ```bash
   grep -E '\[POS_DIAG\].*(CORRUPT|RECOVERED)' /tmp/hermescraft/bot-*.log
   grep 'position CORRUPTED while connected=true' /tmp/hermescraft/watchdog-*.log
   ```

   First grep names the trigger event; second grep counts how many times
   the watchdog auto-recovered.
3. Re-run `scripts/scan-position-corruption.py` for population correlation
   rates; expect the @NaN-proxy → kick correlation to drop substantially
   post-patch.

## Cross-references

- 2026-05-24 anti-cheat work (different bug class, same surface):
  `reports/expedition/2026-05-24-flint-iron-mining-deep-shaft.md`
- Landfolk lifecycle reference: `docs/guides/landfolk-lifecycle.md`
- Probe tooling deployed earlier:
  - `scripts/probe-bot.sh` (read-only diagnostic)
  - `scripts/scan-position-corruption.py` (historical correlation analysis)
- Worker SOULs for the affected bots:
  `prompts/landfolk/flint.md`, `prompts/landfolk/mason.md`

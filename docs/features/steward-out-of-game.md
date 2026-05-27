# Steward Out-of-Game — Webhook-Driven Orchestrator

**Status:** Proposed (2026-05-25). Not yet implemented. Awaiting approval to start Phase 1.
**Owner:** re44 + steward
**Companion docs:**
- [landfolk-plugin.md](./landfolk-plugin.md) — landfolk Hermes plugin (per-assignee kanban concurrency + future subsystems). The chat-bridge daemon proposed below is reframed as the plugin's `mc_chat_adapter/` subsystem.
- [../guides/landfolk-lifecycle.md](../guides/landfolk-lifecycle.md) — current bot/daemon lifecycle.

## Goal

Remove Steward's in-game Minecraft body. Run her as a **webhook-driven Hermes agent** that's woken by external events (worker help requests, operator messages, periodic cron ticks), reads the board, takes one action, and exits — instead of as a continuous in-game presence that has to manage hunger, mobs, NaN kicks, and a 60-second planning cadence.

## Why

Steward's body is operationally expensive and orchestrationally useless:

- **It distracts the LLM.** A zombie attack or starvation pushes board-orchestration reasoning off the critical path. Recent logs show Steward losing 40%+ of an iteration budget to flee/eat/recover sequences that produce zero board progress.
- **It contributes to kick cascades.** Her body is a pathfinder-NaN target like Flint or Mason. Despite running pathfinder-free, she still hit `Invalid move player packet` events in the 2026-05-25 investigation.
- **It costs ~250 MB RAM, one server connection slot, and three daemons** (bot-loop, watchdog, log-tail) — for a presence she uses mostly to read chat and run `mc players`.
- **It can't react quickly to worker help.** Her loop is one `hermes chat -q "Continue..."` invocation per cycle; the cycle latency is bound by `max-turns` or model speed (~60s typical). A worker mention or `help-needed:` block has to wait up to a full cycle for her to even notice.
- **`mc advise` ignored.** Audit on 2026-05-25 showed framework `hint=mc advise --reason=...` strings emitted 116 times in 2 days, called zero times. Workers are not self-rescuing; Steward needs to be the responsive layer, and her current cadence makes her unresponsive.

The body provides three things that need replacements:

| In-game capability | Out-of-game replacement |
|---|---|
| `mc chat "..."` — narrate to workers | rcon `say <Steward> ...` from her runtime |
| `mc nearby / mc scene / mc players` — situational awareness | HTTP `GET /perception` against any active bot's port |
| `mc read_chat` — hear worker narration | Chat-bridge daemon forwards `@steward`-mentions and `help-needed:` events to her webhook |

## What's being proposed

**Steward becomes an event-driven hermes profile** with three activation paths:

1. **Webhook on worker events.** A `landfolk-help` webhook subscription, registered via `hermes webhook subscribe`, fires when a worker chats `@steward` or blocks with `help-needed:` / `clarification-needed:`. The chat-bridge daemon (formerly the chat-wake daemon) does the detection and POSTs to `/webhooks/landfolk-help`. Steward gets invoked with a templated prompt — *"Worker `{bot}` posted: `{message}` on task `{task_id}`. Read the board and take ONE action."* — and runs one focused pass.
2. **Cron for periodic rituals.** A `hermes cron` job ticks every 60 s (or configurable) with a "Continue (orchestrator). Read board + scan blocked + queue-mutex pass" prompt. Replaces the current continuous loop. Skippable when she just ran (deduplication via a session-marker file or `--idempotency-key`).
3. **Operator activation.** re44 either POSTs to the webhook directly (`curl -X POST .../webhooks/landfolk-help -d '{"from":"re44","msg":"..."}'`) or continues whispering to a *worker* in-game whose chat the bridge daemon forwards to Steward.

**Steward's runtime model:**

- No continuous loop. Each activation is a fresh `hermes chat` invocation with a focused prompt, max-turns ~30, exits when she narrates and writes memory.
- No in-game body. Her port 3005 is freed; her bot-steward / watchdog-steward processes disappear from `landfolk status`.
- Her SOUL stays largely the same — board orchestration, materialization, advise mode, pass-back handling. The deltas: replace "every planning cycle" language with "per activation," replace `mc chat` outputs with `rcon say` via a helper, replace `mc nearby` with `/perception` HTTP calls against the named bot.

**What she will NOT do:** spawn subagents via `delegate_task`. Per Hermes delegation docs: *"delegate_task is **synchronous**: if the parent turn is interrupted, active children are cancelled and their work is discarded ... Not durable — delegate_task is synchronous and runs inside the parent turn."* That's the wrong tool for orchestration; Steward exits per activation and her "subordinates" are kanban workers spawned by the dispatcher, not in-turn subagents. The kanban-worker SKILL already enforces this distinction (`kanban_create` for durable cross-agent handoff, `delegate_task` reserved for in-turn reasoning subtasks).

**Chat bridge daemon** (evolution of `scripts/landfolk-chat-wake.py`):

- Renamed to `scripts/landfolk-chat-bridge.py`.
- Polls every bot's `/chat?count=20` for entries with `whisper:true` OR public `@steward` mentions OR `[STEWARD_HELP]` markers.
- For each new event: POSTs to `/webhooks/landfolk-help` with payload `{bot, from, message, task_id?, kind: whisper|mention|help-needed}`.
- Continues to file `[CHAT_REQUEST]` cards for idle non-Steward bots (existing behaviour preserved).
- Adds: tail of `hermes kanban list --status blocked --json` looking for new `help-needed:` / `clarification-needed:` blocks → fires the webhook (covers the case where the worker exited before her bridge could see the chat).

**rcon helper** for Steward → in-game chat (and any other ops-level `say`):

- `scripts/mc-say.py` (new). Thin wrapper around `mcrcon` (already installed on the host where the MC server runs — verify in Phase 0).
- Usage: `scripts/mc-say.py "Steward: t_xxx unblocked — try option 2"` or `mc-say.py --as steward "@flint advice: ..."`.
- Steward's SOUL replaces every `mc chat "..."` example with `scripts/mc-say.py "..."`.
- The bridge daemon could also offer this as a webhook (`POST /webhooks/say`) so any script can broadcast without shelling to rcon directly.

**Activation prompt template** (the value of `--prompt` on `hermes webhook subscribe`):

```
You were activated because: {kind} from {bot}.
Payload: {message}
Task: {task_id}

Read your memory, then run scripts/board-recent.py --ticks 5 + hermes kanban list --status blocked.
Take ONE action: unblock + advice comment, decompose, reassign, archive, [BUG] to re44, or defer.
Narrate via scripts/mc-say.py "<Steward> <one-line>".
Write a memory checkpoint before exiting.
```

## Architecture diagram (text)

```
                                              ┌───────────────────────────┐
                                              │  Steward (hermes -p)      │
                                              │  webhook-driven, no body  │
                                              └────────────▲──────────────┘
                                                           │ invoke
                                              ┌────────────┴──────────────┐
                                              │  steward-activate.sh      │
                                              │  flock /tmp/steward.lock  │
                                              │  appends pending else     │
                                              └────────────▲──────────────┘
                                                           │ HTTP POST
                                              POST /webhooks/landfolk-help
                                                           │
   ┌──────────────────────────────┐  events   │
   │ chat-bridge daemon           ├───────────┤
   │ polls bot /chat, tails       │           │
   │ kanban blocked, 3s debounce  │           │
   └──────────▲───────────────────┘           │
              │ poll                          │ on signal (deficit / stranded / stale)
   ┌──────────┴───────────────┐               │
   │ Flint, Mason, etc.       │   ┌───────────┴────────────────────────┐
   │ (mineflayer bots)        │   │ Detector scripts (script-only cron)│
   └──────────────────────────┘   │                                    │
              ▲                   │ ├ queue-mutex-release  (1m, acts)  │
              │ rcon say          │ ├ base-inventory-deficit (5m)      │
              │                   │ ├ stranded-cards (10m)             │
   ┌──────────┴───────────────┐   │ └ stale-blocks (4h)                │
   │ scripts/mc-say.py        │   │ no_agent=True, zero LLM cost       │
   │ invoked by Steward       │   └────────────────────────────────────┘
   └──────────────────────────┘
```

## Concrete changes (file-by-file)

| File / path | Change |
|---|---|
| `~/.hermes/profiles/steward/config.yaml` | Add webhook entry (or use `hermes webhook subscribe` CLI). No body-related changes. |
| `~/.hermes/profiles/steward/SOUL.md` (or `prompts/landfolk/steward.md` — verify which) | Rewrite "Continuous-loop responsibilities" → "Per-activation responsibilities." Replace `mc chat` → `scripts/mc-say.py`. Replace `mc nearby/scene/players` → calls to perception via HTTP. Drop "First moves on startup" steps that assume in-game body. Add explicit handling of webhook payload (`{kind}`, `{bot}`, `{message}`, `{task_id}`). |
| `scripts/landfolk-chat-wake.py` | Renamed `scripts/landfolk-chat-bridge.py`. Forward `@steward` mentions + `help-needed:` blocks to webhook in addition to filing `[CHAT_REQUEST]` cards. Implement 3-second debounce window so bursts collapse into single batched POSTs. |
| `scripts/mc-say.py` (new) | rcon wrapper for `say` commands. Reads rcon password from `secrets.yaml`. |
| `scripts/steward-activate.sh` (new) | `flock`-based wrapper. Acquires `/tmp/steward.lock`; if held, appends event payload to `/tmp/steward.pending` and returns 200. If acquired, invokes `hermes -p steward chat -q "<prompt>" --max-turns 30 --yolo`. On exit, drains pending queue and re-fires if any events buffered. |
| `scripts/landfolk/detectors/queue-mutex-release.py` (new) | Script-only cron, every 1 min. Scans blocked cards with `queue-mutex:` prefix; for each whose assignee has zero `{ready, running}`, unblocks via `hermes kanban unblock`. Auto-acting, no webhook. |
| `scripts/landfolk/detectors/base-inventory-deficit.py` (new) | Script-only cron, every 5 min. Runs `scripts/base-inventory.py --json`; on deficit, POSTs `{kind: "deficit", items: [...]}` to the webhook. |
| `scripts/landfolk/detectors/stranded-cards.py` (new) | Script-only cron, every 10 min. Finds cards with offline assignees; POSTs `{kind: "stranded", cards: [...]}`. |
| `scripts/landfolk/detectors/stale-blocks.py` (new) | Script-only cron, every 4 hr. Finds non-`queue-mutex:` blocks older than 6 h; POSTs `{kind: "stale-block", cards: [...]}`. |
| `scripts/landfolk` | Remove Steward from default bot startup (`PLAYERS_DEFAULT` etc.). Add lifecycle hooks: register the webhook subscription on `start`, install the cron on `start`, deregister both on `stop --clear-roster`. |
| `data/agent-models.json` | Port 3005 freed. Leave the `Steward` profile entry as `role: orchestrator`, drop `api_port` (or set to null) so the resolver doesn't try to bind a bot. |
| `prompts/landfolk/steward.md` | Update orientation list (no `mc status/read_chat` since she has no body), keep memory + board reads, update narration → `mc-say.py`. |
| `~/.hermes/skills/devops/kanban-worker/SKILL.md` | Update the "soft-help chat" example: workers still use `mc chat "@steward ..."` (their body is in-game); Steward sees it via the bridge daemon. No worker-side change beyond a brief explanatory note. |

## Phased migration

**Phase 0 — Confirm primitives are available (1 hr).**

- [ ] Verify rcon is enabled on the Minecraft server. (`grep enable-rcon /opt/stacks/minecraft/data/server.properties` on ubuntu-host.)
- [ ] Confirm `mcrcon` binary is on the host or installable. Document the install line if not.
- [ ] Verify `hermes webhook subscribe` works against the local gateway (run the test payload, check Steward gets invoked).
- [ ] Verify `hermes cron create` runs jobs reliably (one test tick).
- [ ] **Verify webhook delivery target supports a shell-script wrapper** (so we can put `flock` in front). If only managed platforms are supported (`--deliver telegram/discord/slack`), we need a thin self-hosted receiver. Settle on which.
- [ ] **Check Hermes' memory tool concurrency behaviour.** Run two `memory(action="add", ...)` calls in parallel against the same profile, inspect `MEMORY.md` for interleaving / clobber. Document the answer; add our own `flock` wrapper if Hermes doesn't serialize.
- [ ] **Check if `hermes chat -p steward` enforces profile-level single-flight.** Start two simultaneously, observe whether the second errors or proceeds.
- [ ] **Confirm `hermes cron create --no-agent` is the CLI flag for script-only mode** (docs use `no_agent=True` as a config attribute; verify the CLI surface). Run a smoke test that proves no LLM is invoked.
- [ ] **Confirm script-only cron error-alert delivery target.** From `cron-script-only` doc: "non-zero exit codes trigger error alert is delivered." Confirm WHERE the alert lands (Telegram/Discord/log file?) and that it's a channel re44 actually watches.

**Phase 1 — Add the bridge + detectors + helper (no Steward changes yet).**

- [ ] Build `scripts/mc-say.py`. Smoke-test from terminal that `<Steward> hello` appears in-game.
- [ ] Build `scripts/landfolk-chat-bridge.py` as the chat-wake daemon + webhook poster with 3 s debounce. Initially fires webhook only when in DRY_RUN env mode so we can inspect the payloads without invoking Steward.
- [ ] Build the four detector scripts (`queue-mutex-release.py`, `base-inventory-deficit.py`, `stranded-cards.py`, `stale-blocks.py`). Run them by hand against the live board first — confirm each correctly identifies its target conditions and produces no false positives.
- [ ] Register all four as `hermes cron create --no-agent` jobs. Watch one cycle each to verify they actually run script-only (`hermes cron status` should show zero LLM tokens consumed).
- [ ] Build `scripts/steward-activate.sh` with `flock` semantics. Smoke-test by manually firing it 5× in a 1 s burst — confirm only one Steward runs and the pending queue drains.
- [ ] Register the `landfolk-help` webhook with `--deliver-only` to start — Steward keeps her current loop, the webhook just logs. We see the events Steward would receive.

**Phase 2 — Cut Steward over.**

- [ ] Take Steward's in-game body offline (`landfolk stop --players steward`).
- [ ] Drop her continuous loop entirely; no more `hermes chat -q "Continue..."` runs.
- [ ] Switch the webhook from `--deliver-only` to real invocation routing through `scripts/steward-activate.sh`.
- [ ] Update her SOUL to per-activation language; replace `mc` outputs with `mc-say.py`; remove the orientation steps that assume an in-game body.
- [ ] Run a 30-minute soak: file fake `@steward` mentions, fake `help-needed:` blocks, observe activation latency and action quality. Verify detector scripts continue running and that one Steward at a time is invoked.

**Phase 3 — Operational polish.**

- [ ] Add deduplication: if Steward was invoked in the last 10s for the same `task_id`, the webhook returns 200 OK but doesn't re-fire. Prevents thundering-herd from a chatty worker.
- [ ] Replace `mc nearby/scene/players` in her SOUL with the HTTP-on-any-bot equivalent (`scripts/perception-probe.py <bot> <reason>`).
- [ ] Verify the operator (re44) flow: `curl -X POST .../webhooks/landfolk-help -d '{"from":"re44","msg":"check Flint"}'` works AND in-game chat `@steward` still forwards via the bridge.
- [ ] Decommission the cron once webhook + reactive flow proves sufficient (optional — keep at 5-min cadence as a safety net for things no one tells Steward about).

**Phase 4 — Cleanup.**

- [ ] Remove Steward's danger-react env vars from `scripts/landfolk-control.sh` (no body, no danger).
- [ ] Remove `mc-steward.log` / `bot-steward.log` / `watchdog-steward.log` paths from `landfolk logs`.
- [ ] Drop Steward from `scripts/scan-position-corruption.py`'s default fleet list.
- [ ] Update `docs/guides/landfolk-lifecycle.md` to reflect the new role split.

## Concurrency, scheduling, and de-duplication

Three failure modes are inherent to event-driven agents and need explicit design choices before Phase 2.

### 1. Trampling herd — bursts of webhook events

**Scenario.** Flint blocks `help-needed:` at 12:00:00. Mason blocks `help-needed:` at 12:00:02. Gatherer chats `@steward` at 12:00:03. The bridge daemon polls every 5s and posts three webhook events in quick succession. If each webhook spawns a fresh `hermes chat` process, we get three Stewards racing on the same board.

**Two-layer mitigation:**

- **Debounce at the bridge.** `landfolk-chat-bridge.py` accumulates events into a 3-second window. All events in the window collapse into ONE webhook POST with payload `events: [{...}, {...}, {...}]`. Steward sees a *batch* and handles them in one activation, prioritized by the rules in the SOUL (`help-needed:` first, then `@steward` mentions, then routine).
- **Self-deduplication in the prompt.** Steward's activation prompt — for both webhook and cron — always begins with *"Read the current board snapshot first, then act on what's actually open right now. The trigger payload is a hint, not a worklist."* If a webhook fires for `t_abc` and another Steward already unblocked `t_abc` 5 seconds ago, the second one sees `state=ready` on `kanban_show t_abc` and narrates *"already resolved by previous activation"* and exits.

**What we explicitly accept:** within the 3-second debounce window, a single event may be delayed up to 3 s before Steward sees it. Net latency stays comfortably under the old 60-second cycle.

### 2. Periodic maintenance vs reactive — detector scripts (no LLM) + webhook activation

Webhooks fire only on **observable signals from agents** — chats, blocks, comments, reassignments. Some board health properties have no agent-emitted signal: queue-mutex release candidates, stranded-card backlogs (assignee no longer assignable), base-inventory deficits, stale-block archive candidates, fleet-imbalance.

**Key Hermes finding (from `cron-script-only` docs):** cron jobs registered with `no_agent=True` run as **pure scripts — zero LLM cost, zero agent loop**. This unlocks a much cheaper architecture than firing Steward every minute.

**Two-tier design — detectors + agent:**

**Tier 1: Detector scripts** (`~/.hermes/scripts/` or symlinked from `scripts/landfolk/detectors/`). Each runs on `hermes cron create --no-agent --schedule 'every Nm'`. They are pure Python, deterministic, side-effect-light. Two flavours:

- **Auto-acting detectors** (when the action is mechanical, never needs judgment):
  - `queue-mutex-release.py` — every 1 min — for each blocked card with `queue-mutex:` prefix, if the named assignee has zero `{ready, running}`, fire `hermes kanban unblock <id>`. Pure rule, no LLM needed. Today this lives in Steward's SOUL; we lift it to a script.
- **Signal-emitting detectors** (when the action needs Steward's judgment):
  - `base-inventory-deficit.py` — every 5 min — runs `scripts/base-inventory.py --json`, posts `{kind: "deficit", items: [...]}` to `/webhooks/landfolk-help` if any category is below target_min.
  - `stranded-cards.py` — every 10 min — finds cards whose assignee isn't in `roster.py --assignable`, posts `{kind: "stranded", cards: [...]}`.
  - `stale-blocks.py` — every 4 hr — finds blocked cards older than 6 hours that aren't `queue-mutex:`, posts `{kind: "stale-block", cards: [...]}`.

Detectors that find nothing exit silently with code 0. Detectors that find something either act directly (mechanical) or POST a webhook payload (judgment-class).

**Tier 2: Webhook activation** (LLM, costs tokens). Steward is invoked only when there's something genuinely worth her judgment — worker events (`@steward`, `help-needed:`, `clarification-needed:`, pass-back) and detector signals. No periodic LLM cron at all in the steady state.

**Why this is better than the original "60s LLM cron":**

- **Cost.** Today's Steward fires ~24 cycles/hour ≈ 100 LLM calls/day burning tokens on "nothing changed since last cycle." Detector scripts cost zero; webhook activations fire only when warranted (~10–50 events/day from logs we've seen).
- **Latency.** Worker events still get sub-second activation via webhook + bridge debounce. Periodic concerns surface within their detector interval (e.g. base-inventory within 5 min of the deficit appearing).
- **Reliability.** A detector that crashes generates an error alert via `cron-script-only`'s built-in error delivery — we don't have to build our own watchdog-for-the-watchdog.
- **Clarity.** Each detector script encodes ONE rule. Easy to test, easy to disable, easy to add (e.g. "watch for chest fires near base").

**What we explicitly accept:**

- Steward NEVER runs on a clock — only when something happens. If the fleet is genuinely idle, Steward is idle and free. This is the desired behaviour.
- Detector scripts use `hermes kanban` CLI (which is profile-agnostic) for direct actions and `curl -X POST .../webhooks/landfolk-help` for signaling — they don't carry Steward's identity, so any auto-action they take shows up in the board log as `created_by: detector-<name>` rather than `created_by: steward`. This is fine — the audit trail still shows the SOURCE.

**Webhook prompt vs detector prompt** (since detectors don't have prompts, this becomes simpler than the original two-prompt design — there's just *one* Steward prompt and the trigger payload tells her why she's awake).

**Phase 0 must add:** confirm `hermes cron create --no-agent` is the right CLI surface for script-only jobs (the doc page mentions `no_agent=True` as a config attribute — verify the CLI flag mapping).

### 3. Two Stewards active at once — single-flight lock

**Scenario.** Webhook fires for Flint's help-needed at 12:00:00. Steward starts. Cron tick fires at 12:00:01. Steward #2 starts. Both:

- Read the board, see Flint's blocked card.
- Decide to comment + unblock.
- Race on `kanban_unblock t_abc` — second one gets a "already unblocked" error.
- Race on `memory(action="add", ...)` — depends on Hermes memory-tool locking.
- Both `scripts/mc-say.py "@flint advice: ..."` — chat shows two `<Steward>` lines back-to-back.

**Single-flight design** — a `flock`-based wrapper script becomes the webhook + cron target. Both `hermes webhook subscribe` and `hermes cron create` invoke `scripts/steward-activate.sh`, which:

1. Acquires `flock -n /tmp/steward.lock` (non-blocking).
2. **Lock acquired:** invokes `hermes -p steward chat -q "<prompt>" --max-turns 30 --yolo`. On exit, releases the lock AND checks for `/tmp/steward.pending` — if any events queued during her run, re-fires once more with the batched payload, then exits.
3. **Lock NOT acquired:** appends the event payload to `/tmp/steward.pending` (JSON-Lines) and returns 200 OK. The running Steward will see it on her post-exit drain.

This gives strict single-flight while never dropping an event. Net effect: there's always at most one Steward, but every triggered event is eventually seen.

**Failure modes covered:**

- **Stale lock from a crashed Steward.** The script uses `flock` with file-descriptor semantics — kernel releases the lock when the holding process dies. No PID-tracking required, no manual cleanup script.
- **Operator invokes `hermes -p steward chat` manually while one is running.** That bypasses the wrapper, so we get two Stewards. Mitigation: doc a `landfolk steward poke` helper that always goes through the wrapper, and add a SOUL hard-rule discouraging manual hermes-chat invocations.
- **Pending queue grows unbounded.** Cap `/tmp/steward.pending` at 100 entries; trim oldest on overflow. If the cap is hit, post a `[BUG]` card to re44 — that level of backpressure means something's wrong upstream.

**Phase 0 must confirm:**
- Whether `hermes webhook subscribe` supports a shell-script delivery target (so we can route through `steward-activate.sh`). If not, we run our own webhook receiver (e.g. a small Flask app behind nginx, or `hermes webhook ... --deliver telegram` and a polling task on the other end — uglier).
- Whether Hermes' memory tool serializes concurrent writes to `MEMORY.md`. If not, we add our own `flock` wrapper around the memory append.
- Whether `hermes chat -p steward` has built-in profile-level single-flight. If yes, the script's job simplifies; if no, our `flock` is the only line of defense.

## Open questions

1. **Does the operator still need an in-game way to talk to Steward?** Today re44 whispers her in-game. Tomorrow the bridge forwards `@steward` from any chat → webhook. So yes — re44 can still type `@steward` to any bot and reach her. Confirms: no operator-facing UX change.

2. **What about the existing `steward-chat-listener.py` daemon?** It currently watches Steward's *own* port for `@steward` mentions and files triage cards. With no Steward body, this daemon's source goes away. Functionality merges into `landfolk-chat-bridge.py`.

3. **Cron cadence — 60s, 5 min, or none?** With webhook activation covering reactive work, the cron's only job is the *proactive* rituals (queue-mutex release, base inventory check, quiet-bot scan). Those don't need 60s — every 5 min is probably fine. Pick a number on Phase 2 soak data.

4. **What about `mc advise` from Steward's perspective?** Today her SOUL mentions calling `mc advise` from her own body for perception-based reasoning. Without a body, she'd call it via another bot's port: `MC_API_URL=http://127.0.0.1:3002 mc advise --reason="..."` (uses Flint's perception). This is a SOUL clarification, not a code change.

5. **rcon `say` formatting.** When Steward says `<Steward> ...` via rcon, the in-game display is `[Server] <Steward> ...` — not `<Steward> ...`. Acceptable? Or hack around it by using `/tellraw` with a custom name format? Acceptable as-is is the cheap default; revisit if it confuses workers.

6. **What about `[RESCUE_REQUEST]` cards?** Steward currently uses her body to verify rescue claims (`mc players` etc.). With no body, she'd dispatch a scout card OR query `/players` HTTP on any bot's port. The latter is cheaper. SOUL update.

7. **Webhook auth.** `hermes webhook subscribe --secret <hmac>` provides HMAC validation. Pick a secret, store in `secrets.yaml`, plumb through the chat-bridge daemon. Standard.

## Out of scope

- **Bringing Steward back into the game later.** This is a one-way migration. If a future workflow needs an in-game Steward presence, file a separate proposal.
- **Replacing other bots (Flint, Mason, Gatherer) with webhook agents.** They genuinely need bodies — they mine, build, gather. Don't apply this pattern to them.
- **Moving re44 to webhook.** re44 is human; he uses Signal/Telegram/Discord and the messaging gateway already routes to him.
- **Multi-Steward orchestration.** Out of scope for this rev. If load grows, we add `steward-a` / `steward-b` later with explicit board-namespace separation.

## Risk + rollback

- **Risk: webhook activation is slower than expected.** Mitigation: keep the cron tick at 60s as a backstop. Worst case, Steward acts every 60s on stale signals (same as today).
- **Risk: chat-bridge misses events.** Mitigation: the bridge tails `hermes kanban` for `help-needed:` blocks AS WELL as polling chat — two independent paths converge on the same webhook. Both have to fail to lose an event.
- **Risk: rcon `say` looks too server-y for workers to recognize as Steward.** Mitigation: prepend `<Steward>` consistently; workers' SOUL already expects `<Steward>` chat lines. A few sessions of soak will tell us if the framing is an issue.
- **Risk: webhook + cron both fire at the same time, double-activating Steward on the same event.** Mitigation: cron prompt is "continue (idle ritual)" — distinct from webhook prompt — and Steward's first action on cron is `kanban_show` on the most-recently-blocked card. If nothing changed since her last activation, she narrates "no change" and exits.
- **Rollback:** all changes are additive (new daemon, new webhook, new cron). To revert: `landfolk stop --players steward; landfolk start --players steward; hermes webhook remove landfolk-help; hermes cron remove steward-tick`. Steward returns to her in-game body and continuous loop.

## Acceptance criteria

The migration is successful when:

- [ ] No `bot-steward.log` / `watchdog-steward.log` traffic during a 24h soak.
- [ ] `@steward <bot>: stuck on <thing>` in-game chat produces a Steward response in `<60s` (measured: chat timestamp vs `mc-say.py`-reflected response timestamp).
- [ ] `kanban_block(reason="help-needed: ...")` produces a Steward action (comment + unblock, OR reassign, OR archive) in `<5min`.
- [ ] No zombie/starvation lines in any log mentioning Steward.
- [ ] re44 can `curl -X POST .../webhooks/landfolk-help` and get a Steward response.
- [ ] Periodic rituals (queue-mutex release scan, quiet-bot check-in) still happen at least every 5 min.
- [ ] **Concurrency contract holds.** Fire 5 webhook events in a 2-second burst. Only one Steward process runs at a time (verify via `ps`); all 5 events are eventually reflected in board actions or chat narration; the `/tmp/steward.pending` queue is empty at rest.
- [ ] **Memory integrity holds.** After a 24h soak with frequent activations, `MEMORY.md` parses cleanly (`§`-delimited entries, no truncated lines, no interleaved content).
- [ ] **Manual operator invocation goes through the wrapper.** `landfolk steward poke "<reason>"` works and locks the same way webhooks do.

---

## Future iterations — Hermes plugin path

After the MVP (Phases 0-4) is stable, a **`landfolk-hermes-plugin` Python package** unlocks a deeper integration. The current design uses tools (`mc` CLI), skills (markdown), and prompts (SOUL/SKILL) as the extension surface. Plugins add a sixth surface — in-process Python with framework hooks. Six areas where plugins would let us move SOUL-taught rules into deterministic code:

### `pre_llm_call` — auto-inject and compact context

A plugin hook fires before each LLM call and returns `{"context": "..."}` to append to the user message. Concrete uses:

- **Steward activation preamble.** Auto-inject: online roster + last-known bot positions, board pulse (`{triage:3, ready:2, blocked:5}`), 5 most recent chat lines, `help-needed:` queue, last-run ritual timestamps, drained pending-events queue. Replaces the first 3-5 tool calls of each activation with a single injection. Estimated cost reduction per activation: 30-50%.
- **Worker spawn preamble.** Auto-inject: `kanban_show` body + comments + runs[] classification ("you're a retry; 3 prior same-class failures — mandatory `mc advise` tier"), bot state (pos/hp/food/inventory summary), region context, recent whispers. Workers stop burning iteration budget on rediscovery.
- **JSON compaction.** Strip pretty-printing; collapse `{position:{x:418.5,y:48.0,z:-621.2}}` to `pos=(418,48,-621)`; abbreviate `t_84bd7e30` to `#84` in display (kernel retains the hash). Recovers tokens that carry no information.

### `transform_llm_output` — guardrails on bad calls

Per Hermes docs, `post_llm_call` is observer-only; `transform_llm_output` is the rewrite/veto point. Concrete uses:

- **Anti-pattern veto: same-tool-same-args repetition.** 4× identical `mc till (a,b,c)` calls with no intervening action → veto + inject "STOP — this is the help-needed pattern. Call `mc advise` or `kanban_block`."
- **Python/bash-escape detection.** LLM emits `bash -c "for i in ..."` to batch-process Minecraft work → veto + inject the failure-escalation rule from the SKILL.
- **Hallucinated tool names.** `mc_dig_area` → fuzzy-match suggest `mc dig` + injected hint.
- **Coord-out-of-region veto.** Tool call references a coord in a forbidden region → veto with the region policy quoted back.

By the time a tool runs, it's been validated. The SOUL gets simpler; the framework gets more honest.

### `on_session_end` — deterministic memory checkpoint

Today the SKILL begs the LLM "write memory before exiting" and a large fraction of exits skip it (max-turns fires mid-thought). A plugin hook makes it deterministic:

- **Force a state-snapshot to MEMORY.md.** Read bot HTTP `/health` + `/inventory`, format the canonical schema, append. Zero LLM involvement.
- **Reconcile the kernel.** Worker exited without `kanban_complete` or `kanban_block` → auto-fire `kanban_block(reason="session-truncated: <last tool call>")` so cards don't sit in `running` forever.
- **Snapshot session log** to `~/.hermes/profiles/<bot>/sessions/last-session.json` for forensics (today we find the right file by timestamp).
- **Emit an end event** on a unified event stream so the chat-bridge knows "Flint exited" without polling.

### `on_session_finalize` / `on_session_reset` — server hygiene

Garbage-collection hooks at known boundaries. Replace watchdog's "watch for stuck state" with "guaranteed cleanup."

- **Detect leaked subprocesses** (background commands the worker spawned) → kill.
- **Free workspace locks** (any `flock` files in `$HERMES_KANBAN_WORKSPACE` not released) → release.
- **Reset bot reactive state.** Worker left the bot mid-action (digging, fleeing) → `POST /task/cancel` so next worker starts clean.
- **Verify connection.** Bot HTTP `/health` shows `connected:false` → trigger watchdog force-reconnect via existing scripts.

### Context engine plugin — Minecraft-domain compressor

The biggest engineering lift, biggest potential payoff. Replaces Hermes' default prose compressor with one that understands the domain. Without this, summarization treats `mc nearby` output and `mc dig` results as equally important; in reality they're not.

- **Keep block-changing calls verbatim** (dig, place, fill, deposit, craft) — they're ground truth of what happened.
- **Compress `mc nearby` history.** 8 successive calls → "scanned around (X,Y,Z); persistent: iron_ore@(a,b,c), chest@(d,e,f); transient: 4 zombies cleared".
- **Drop redundant `mc status` snapshots** — only the most recent matters. Same for `mc map`.
- **Never drop `runs[]` failure pattern** — the worker's only memory of why X didn't work.
- **Domain vocabulary substitution.** "stone block at coord (418, 47, -621)" → "stone @ 418,47,-621". Every saved token is more headroom for actual reasoning.
- **Attributed chat summaries.** 30 lines of in-game chat → "re44 asked about iron supply (12:14); Steward took 4 board actions; Flint reported stuck (12:18, t_abc)".

Effective context window could likely 2-3× for long sessions.

### `mc` tool wrapper — single dispatcher with smart resolution

Currently `mc` is a Node CLI invoked from the terminal tool. A plugin could register a single `mc` tool with structured args (verb + params) and handle resolution/validation/policy before forwarding to the underlying script:

- **Mark + region resolution.** `mc move_near {target: "chest_iron"}` → plugin resolves mark in bot's location file, translates to coord, calls `move_near (x,y,z)`. Agents stop having to memorize coords.
- **Region policy enforcement.** `mc dig {at: (X,Y,Z)}` → plugin checks region permissions for the bot's role; rejects before the bot HTTP gets called. Replaces ~200 lines of SOUL teaching.
- **Batched verbs that don't exist in the underlying CLI.** `mc till_area {from: (x1,z1), to: (x2,z2)}` → plugin expands into N `till` calls with abort-on-repeat-failure built in. **The 81× anti-pattern becomes structurally impossible** because the verb exists at the higher level.
- **Auto-attribution.** `mc chat "hi"` → plugin prepends `<Flint>` consistently. No more "did Flint say that or was it Server?" ambiguity.
- **Inventory pre-check.** `mc craft {item: "iron_pickaxe"}` → plugin checks inventory locally for required materials, returns `{ok: false, missing: ["iron_ingot×2"]}` *without consulting the server*. Saves round-trip; LLM can react sooner.
- **Failure-pattern hints in tool-result payload.** Wrapper sees same coord-arg fail 3× via its own request counter → returns error AND a `hint: "3rd same-coord failure — escalation tier requires mc advise"`. The hint becomes a tool result the LLM has to engage with, unlike the server-emitted hints we audited as 116-ignored-in-2-days.

### Four architecture paths for plugins (cheap → ambitious)

When we revisit this, the entry points and their tradeoffs:

- **Path B — Steward observation plugin** (smallest, recommended start). One `pre_llm_call` hook + a state-fetcher helper. Cuts activation cost 30-50%. Proves the plugin path without committing to anything bigger.
- **Path A — `landfolk-tools` plugin.** Re-home `mc-say.py` + `perception-probe.py` + `kanban-observe` as plugin tools. Bundle the kanban-worker SKILL inside the plugin (eliminate the 8-way `cp` propagation). Medium lift, durable gain.
- **Path C — `landfolk-events` plugin.** `post_tool_call` hook + an event stream file (`/tmp/landfolk-events.jsonl`). Chat-bridge daemon tails this stream instead of polling each bot's HTTP API. Decouples bridging from per-bot infrastructure.
- **Path D — `landfolk` mega-plugin.** Subcommands replace `scripts/landfolk` bash; slash commands replace `@steward` keyword routing; hooks replace several daemons; the `mc` wrapper handles all bot calls. Architecturally pristine, big lift, locks us into the plugin API for everything.

### Constraints to remember when revisiting

- **Plugins are global per profile, loaded once at startup.** Cannot enable/disable per session. A `landfolk` plugin loaded into Flint is also loaded into Steward; hooks must be defensive (`if profile_name != "steward": return None`).
- **No background daemons.** Plugins can't run their own loops — cron + webhooks still needed for periodic work and external signaling.
- **No inter-plugin messaging.** Plugins share state only via filesystem or shared services (kanban DB, bot HTTP).
- **Plugin handlers must return JSON strings, never raise.** Catch all exceptions, return error JSON.
- **`delegate_task` remains synchronous and in-turn.** Workers are still spawned by the kanban dispatcher, never as plugin-spawned subagents.

### The architectural question this surfaces (for later)

When we pick this up: **plugin-first or supplemental?**

- **Plugin-first.** Migrate the current bash/skill/SOUL architecture into a `landfolk-hermes-plugin` Python package. Single source of truth. Cleaner but locks tighter to Hermes APIs; harder to debug; less escape-hatch flexibility.
- **Supplemental.** Plugins handle observation, injection, and policy enforcement only. Bash glue (`scripts/landfolk`, detectors, chat-bridge) remains the structural spine. Looser, more debuggable, but means duplicate state (plugin's mark cache vs `scripts/marks-resolver`).

Decision deferred until Phases 0-2 of the current MVP are validated. **DO NOT attempt plugin work until the webhook + flock + detectors path is proven** — adding plugins on top of an unvalidated event-driven architecture means debugging two new things at once.

---

## Implementation hand-off note

When picking this up: start with **Phase 0** verifications. If rcon isn't enabled or `mcrcon` isn't installed, that's the first thing to address — everything else depends on Steward being able to talk in-game without a body. The cleanest implementation order is then Phase 1 (build helpers in `--deliver-only` mode, observe payloads), then Phase 2 (flip the switch). Don't skip Phase 1 — it lets you validate the activation prompt without forcing Steward into a half-built world.

---

## Updates from 2026-05-25/26 implementation work

A long debugging + doctrine-iteration session against the **current** in-game Steward proved several things that update this proposal. Cross-references to which existing sections need revision are noted inline.

### What's been resolved in the current architecture (reduces webhook scope)

Several of the original motivations for going out-of-game have been mitigated WITHOUT removing the body. These items now have working solutions on the current Steward; they're listed so a future implementer can decide whether the webhook migration is still the highest-leverage change.

| Original motivation | Resolved by | Status |
|---|---|---|
| NaN kicks affecting Steward's body | Commits `76cfbfc` (POS_GUARD outgoing-packet validator), `a32a08e` (YAW_GUARD at bot.look entry), `6577cc4` (stair_down yawByKey root cause fix), `27cb2dc` (reactive myPos NaN bail) | ✓ kick stream stopped fleet-wide |
| `mc advise ignored 116 times in 2 days` | Diagnosis split: (a) workers' restricted_bin python3 stub blocked spawn — fixed via `MC_ADVISE_PYTHON` env in `565521a`; (b) yaml import inside `tests/_lib/config.py` failed silently — fixed via lazy imports in `ea6a19b`; (c) SOUL didn't make it mandatory after `stuck_warning` — fixed via `14a459c` + skill update | ✓ tool reachable; doctrine pending bot-restart observation |
| 60-second cycle latency for worker help | Commit `14a459c` — `stuck_warning` field surfaced in `/health` + `mc status`; `de13f49` propagates through the CLI thin envelope. Workers now see a hard prod in their own status reads and the SKILL mandates escalation | ✓ in place; workers see warning at 5min stuck |
| Steward orchestrator-card double-spawn (her continuous loop + dispatcher worker spawn collision) | Commit `8eb3d23` — dispatcher's pre-flight parks orchestrator-assigned cards via `claim_lock`; observation.js suppresses `stuck_warning` for orchestrators | ✓ works on current Steward; **OBVIATED** if she goes out-of-game (no profile in dispatch path) |
| Steward distracted by hunger/mobs at base | Commit `8eb3d23` orchestrator stuck-warning suppression + Steward already stationary by SOUL rule | ✓ no longer noisy. Out-of-game still cleaner. |

**Net effect on this proposal:** the *operational* justification (kick cascades, advise unreachability) is largely gone. The remaining justification — **decoupling Steward's planning cadence from the in-game tick + her cognitive budget from her body** — is still valid, but the urgency is lower. Re-evaluate before starting Phase 0 whether the migration is worth the engineering cost given the new baseline.

### New evidence supporting the migration

These OBSERVATIONS from today reinforce parts of the original design:

1. **Per-round timeouts kill session memory.** Default `AGENT_ROUND_TIMEOUT_S=180` (now 300, commit `8e070a6`) was too tight for Steward's heavy prompt — 5 of 7 consecutive rounds failed `exit=142` (SIGALRM). Sessions were not persisted to disk because the process was SIGKILLed mid-action. Effect: Steward became **amnesiac** between rounds, starting each plan from scratch. **The webhook architecture's per-activation budget needs explicit sizing — recommend matching the bumped 300s or higher.** Add to Phase 0 verification.
2. **Decision paralysis is real and observable.** Logged trace from 02:36 showed Steward generating 4 different plans for the same issue, reversing twice (`Actually let me think differently`), spending ~80% of tokens deliberating. The 5-phase ritual (next section) was the response. The activation prompt in §"What's being proposed" needs the same treatment.
3. **Workers physically stuck ≠ work being stuck.** Mason was stuck on a pillar for 20+ minutes; Steward responded by reassigning his card to Flint (who also can't `rcon tp`). Doctrine fix (commit `4143c84`) added a `PHYSICALLY_STUCK` bot classification with rescue-class actions, distinct from BLOCKED_WAITING cards.
4. **Tool-switching circumvention of operator denies.** Steward issued a `terminal` command, operator denied it, she retried the SAME operation through `execute_code` (Python sandbox calling `from hermes_tools import terminal`). Commit `870c4e3` added a hard SOUL rule: "A deny is a deny — no routing through another tool surface." Same rule needs to be in any webhook-Steward activation prompt.
5. **Silence ≠ broken** (negative-detection trap). Commit `1b2e254` — Steward false-positive-filed an `[INFRA] dispatcher offline` card because dispatcher.log was silent for 32min; the dispatcher was actually fine, just had nothing to do. Detectors in the proposed architecture that observe **absence of signal** must distinguish "quiet because healthy" from "quiet because hung." Add positive heartbeats to detector scripts.

### Section-by-section updates needed

| Section in this doc | What needs to change |
|---|---|
| `## Why` — bullet "mc advise ignored 116 times" | Add note: the underlying tool was also broken (restricted_bin stub + yaml lazy-import) — diagnosis was not only "workers don't use it" but "workers couldn't use it." |
| `## What's being proposed` — Activation prompt template | Replace "Take ONE action" framing with the 5-phase ritual (OBSERVE → DIAGNOSE → RANK → EXECUTE → ADMIN). See `prompts/landfolk/steward.md` post-commit `4143c84` for the deployed text. Add the `PHYSICALLY_STUCK` bot classification and the "deny is a deny" rule. |
| `## Concrete changes` — `~/.hermes/profiles/steward/SOUL.md (or prompts/landfolk/steward.md — verify which)` | **Resolved.** Three separate prompt sources now identified: `prompts/landfolk/steward.md` is the continuous-loop `-q` prompt (49KB, file-loaded as of `9dbeee0`), `prompts/landfolk/steward-profile.md` is the short session-start profile SOUL (file-loaded as of `d086b8d`), and `~/.hermes/profiles/steward/SOUL.md` is the runtime artifact generated from the latter. Edit the .md files in `prompts/landfolk/`; never edit the generated `SOUL.md` directly. |
| `## Phased migration — Phase 0` | Add: (a) **Verify the prompt source for each profile before editing.** Today we spent hours editing `prompts/landfolk/steward.md` only to discover the continuous-loop prompt was hardcoded inline in `landfolk-control.sh`. The launcher trace took 30 seconds; we should have done it first. Make it a Phase 0 check for every prompt file the migration touches. (b) **Time the typical activation prompt** under `:exacto` (or whatever model variant is in use). The proposed `--max-turns 30` budget assumes a model speed that may not hold; measure first. (c) **Verify MC_ADVISE_PYTHON behaviour** if the activation prompt references `mc advise` — workers' restricted_bin pattern may carry over. |
| `## Concurrency, scheduling, and de-duplication — §1 Trampling herd` | Add: a per-activation timeout (recommended: 300s based on today's evidence) is the natural circuit breaker — if a Steward activation runs past budget, the next webhook should see no lock holder and proceed. SIGKILL on the running activation may corrupt mid-action state; design the activation to be idempotent (running `kanban_unblock` twice is safe; running `kanban_create` twice creates duplicates — gate with `--idempotency-key` per webhook event). |
| `## Concurrency, scheduling, and de-duplication — §2 Detectors` | Add a `stuck-bots.py` detector — every 1 min, poll each bot's `/health` for `stuck_warning` (commit `14a459c`); POST `{kind: "stuck-bot", bot, position, minutes}` to the webhook. This is the primary signal for the PHYSICALLY_STUCK classification the Steward SOUL now recognizes. Don't make detectors silence-based — every detector logs `tick: nothing-to-do` per cycle so a quiet detector is distinguishable from a hung one. |
| `## Acceptance criteria` | Add: **Session persistence holds under load.** Fire 5 webhook events in 2 sec; after activations drain, the most recent `~/.hermes/profiles/steward/sessions/session_*.json` should be timestamped within the burst window AND have ≥10 messages (not the empty-after-truncation pattern we saw today). |
| `## Open questions` — Q4 (`mc advise` from Steward) | **Resolved direction.** Out-of-game Steward calls `mc advise` via any bot's port AND must export `MC_ADVISE_PYTHON=/opt/homebrew/bin/python3` (or system equivalent) in its env, OR the spawn will hit the same restricted_bin python3 stub as workers do. Already wired for workers in commit `565521a` — `scripts/landfolk-control.sh` exports it into `agent-bashenv.sh`. The webhook handler's env needs the same. |
| `## Future iterations — plugin path` | The `pre_llm_call` injection idea is even more valuable now: Steward's per-activation prompt currently exceeds the response budget at `:exacto` model speed. Pre-computed context injection (board snapshot, roster, recent events) cuts the tool-call preamble that pushes activations past the SIGALRM. Keep Path B (Steward observation plugin) as the recommended entry point; today's evidence strengthens that recommendation. |

### One operational note worth flagging

The current Steward setup has **three different markdown files** that each contribute to her behavior. Today's incident was that two of them (continuous-loop prompt, profile SOUL) were actually hardcoded inline in shell scripts despite appearing to be file-driven. The migration MUST audit all prompt sources for every affected profile (Steward + Workers if their SOULs get touched). The relevant files post-fix:

```
prompts/landfolk/steward.md          ← continuous-loop -q prompt (49KB)
prompts/landfolk/steward-profile.md  ← session-start profile SOUL (2.9KB)
prompts/landfolk/worker.md           ← worker profile SOUL template (9.6KB, {{NAME}} + {{ROLE}})
skills/<name>.md                     ← skills loaded via skill_view per session
```

Webhook migration should preserve this discipline: any new activation prompt goes in `prompts/landfolk/`, not in a shell heredoc. The Phase 0 prompt-source verification step covers this.

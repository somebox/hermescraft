# Hermes v0.15 reference (for hermescraft)

Topic-grouped catalog of the Hermes primitives our architecture cites or works around. Goal: every claim in [`target.md`](target.md), [`hermes-agents.md`](hermes-agents.md), and [`board-dynamics.md`](board-dynamics.md) about Hermes can be cross-referenced to a section here with a link.

**Last verified against:** Hermes Agent v0.15.2 (date tag `v2026.5.29.2`) — 2026-06-06.
**Source site:** [hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/)

**Upgrade runbook (not duplicated here):** [`../platform/hermes-upgrade-0.15-runbook.md`](../platform/hermes-upgrade-0.15-runbook.md).

Per-topic format: official docs link, key facts, our usage. Entries are tight by design — this is a fact-source, not an essay.

---

## Kanban — `create` flags and fields

**Official docs:** [User Guide — Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)

**Key facts:**
- CLI: `hermes kanban create --title <text> --assignee <profile>` is the minimum.
- `--assignee <profile>` is **required at create time**. No null-assignee, no `assignee_class`, no skill-match dispatch routing.
- `--skill <name>` is repeatable; loads additional skills on the spawned worker (additive to built-in `kanban-worker`). Skills must already be installed on the assignee profile.
- `--idempotency-key KEY` — dedup on retry. Writing the same key twice is a no-op.
- `--max-runtime 30m|2h|1d|<seconds>` — sets `max_runtime_seconds`; worker is killed if it runs past.
- `--max-retries N` — per-task circuit-breaker.
- `--scheduled-at "YYYY-MM-DDTHH:MM:SSZ"` — delayed dispatch. Dispatcher skips ready tasks whose `scheduled_at` is in the future.
- `--workspace scratch|worktree|worktree:<path>|dir:<path>` + `--branch <name>` — workspace + branch for code work.
- `--parent <id>` (repeatable) — dependency edges. Child cannot promote until each parent is `done`.
- `--triage` — park in the triage column (specifier/decomposer takes it from there).
- `--goal` + `--goal-max-turns N` (default 20) — enable goal-mode loop for self-bounded work.
- `--tenant <name>`, `--priority N`, `--json`.

**Tool signature `kanban_create()` (worker-side):** same fields. Accepts `skills=[...]`, `parents=[...]`, `idempotency_key=...`, `scheduled_at=...`, `max_runtime_seconds=...`, `max_retries=...`, `goal_mode=...`, `workspace=...`.

**No `model_override` field.** Per-task model routing is not exposed at the card level on v0.15.

**Our usage:**
- The new architecture's `kanban_create(skills=[agent-X, minecraft-Y])` pattern (per [`hermes-agents.md`](hermes-agents.md)) maps directly to these flags.
- **Epic membership vs phase order:** prefer [`scripts/kanban`](../../scripts/kanban) `--epic` (trailer tag) and `--depends-on` (real link) over raw `--parent` for both meanings — see [`epic-lifecycle.md`](epic-lifecycle.md).
- `idempotency_key` is how Fleet Manager (`@dispatcher`) avoids dup cards on rebind. Pattern: `f"{parent_card}-{idx}"`.
- `max_runtime_seconds` per phase is how we cap @navigator (~10min) vs @miner (~30min) differently.
- No `model_override` means per-phase model routing has to come via the assignee profile's model setting or via [delegation](#delegation) for intra-phase specialization.

---

## Kanban — lifecycle, `claim_lock`, heartbeat

**Official docs:** [User Guide — Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)

**Key facts:**
- **Statuses:** `triage` → `todo` → `ready` → `running` → `done`. Plus `blocked` and `archived` orthogonal.
- **Dispatch claim:** atomic via `BEGIN IMMEDIATE` SQLite transaction. Sets `claim_lock` field with claimer identity; updates `tasks.claimed_at`; inserts a row in `task_runs` with `started_at`.
- **Claim TTL:** `kanban.dispatch_stale_timeout_seconds` (default `14400` = 4 hours). After TTL, the task returns to `ready` even if the worker is still alive.
- **Heartbeat:** workers must call `kanban_heartbeat` at least once per hour to avoid stale reclaim. "If your work may run longer than 1 hour, call `kanban_heartbeat` at least once an hour."
- **Reclaim on crash:** dispatcher polls worker PIDs; if the PID is dead but the TTL hasn't expired, a `crashed` event fires and the task returns to `ready`.
- **Atomic reassign:** `hermes kanban reassign <id> --assignee <new>` is atomic; releases the lock + (with our 2026-06-03 patch) SIGTERMs the local worker if one is running.

**Our usage:**
- This IS the lease primitive Fleet Manager uses. No need to build one.
- We heartbeat every 5-10 min (more aggressive than the 1hr minimum) for faster crash detection on long mining cards.
- The 4hr TTL is generous enough for our longest cards (~45min mining + buffer).
- Bot death + reassign is the [`board-dynamics.md`](board-dynamics.md) Path 2 hand-off case; the atomic guarantee comes from this layer.

---

## Kanban — `max_in_progress`

**Official docs:** [User Guide — Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)

**Key facts:**
- Config key: `kanban.max_in_progress` (default: unset = unlimited).
- **Scope: board-wide.** Not per-assignee, not per-profile, not per-gateway.
- Quote: *"caps the number of simultaneously running tasks. When the board already has N running, the dispatcher skips spawning more — useful for slow workers (local LLMs, resource-constrained hosts) so they finish what they have before more pile up and time out."*
- Invalid or below-1 values log a warning and behave as unlimited.
- Enforcement is at dispatcher-claim time via the same `BEGIN IMMEDIATE` transaction; counter is checked atomically.

**Our usage:**
- This is **not** a substitute for our per-bot mutex. Our `landfolk` plugin's `gate-check` + `post_tool_call` hook enforces "one card per assignee at a time" because v0.15 doesn't expose a per-assignee cap.
- We may set `max_in_progress` as a soft global ceiling (5 bots × 1 card each + headroom).
- Our [`landfolk-plugin.md`](../specs/kanban/plugin-landfolk.md) stays load-bearing because of this scope gap.

---

## Kanban — auto vs manual orchestration

**Official docs:** [User Guide — Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)

**Key facts:**
- Config: `kanban.auto_decompose: true|false` (upstream default `true`; **we keep it `false`**).
- Rate cap: `kanban.auto_decompose_per_tick` (default `3`, clamps ≥1 internally).
- Dashboard toggle: pill labeled "Orchestration: Auto/Manual" (emerald = Auto, gray = Manual).
- Auto mode flow: triage card → gateway dispatcher tick runs decomposer → LLM produces JSON task graph → original task becomes parent of all children → flips to `todo`.
- Decomposer is a separate aux LLM (see [Auxiliary clients](#auxiliary-clients)).
- Decomposer reads profile roster + descriptions (per `~/.hermes/profiles/<name>/profile.yaml` `description:` field) to route children.
- Manual mode: triage cards stay parked until `hermes kanban decompose <id>` or dashboard "⚗ Decompose" click.

**Our usage:**
- We keep `auto_decompose: false` because our @mention DSL bypasses LLM decomposition entirely (`@planner` parses literally — see [`@mention` collaboration pattern](#kanban--mention-collaboration-pattern) for what upstream gives us vs. what we build).
- The native auto-decomposer remains a fallback for prose cards that don't carry @mentions.
- We may pin `auxiliary.kanban_decomposer.model` to a cheap fast model for the fallback path.

---

## Kanban — `@mention` collaboration pattern

**Official docs:** [User Guide — Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) ("Collaboration patterns" table, P6)

**Key facts:**
- `@mention` is listed as collaboration **pattern P6** in the kanban docs: *"inline routing from prose — `@reviewer look at this`"*. That single line and example are the entirety of upstream documentation.
- **There is no native parser.** Verified by:
  - Reading [`website/docs/user-guide/features/kanban.md`](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/kanban.md), the [worker-lanes page](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes), and the [`devops-kanban-orchestrator`](https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/devops/devops-kanban-orchestrator) skill — none describe an `@mention` tokenizer, no kanban tool/CLI flag processes `@mention` text, no auto-decomposer or specifier hook reads `@mention`s, no REST/WS event references `@mention` parsing.
  - **Source-code search of `NousResearch/hermes-agent` (verified 2026-06-06).** The only co-occurrence of "kanban" and "@mention" anywhere in the repo is the P6 row in `website/docs/user-guide/features/kanban.md` (and its Chinese translation). `gh search code 'mention path:plugins/kanban'` returns zero hits; `gh search code '"@mention"'` returns zero literal hits in code. No tool handler, no plugin hook, no orchestrator skill code path consumes `@profile_name` text from card bodies.
- The other places `mention` appears in the codebase are **unrelated**:
  - **Platform-adapter gating** (Discord / Slack / Matrix / WhatsApp / Telegram / Signal / Feishu / Mattermost / Dingtalk / Yuanbao / BlueBubbles) — `require_mention: true` makes the bot ignore channel messages that don't `@`-tag it. This is "should this message reach the gateway at all?" — completely separate from kanban card routing.
  - **Desktop chat UI** (`apps/desktop/src/components/assistant-ui/directive-text.tsx`) parses **typed** directives like `@file:`, `@image:`, `@tool:` in chat text and renders them as styled chips. Visual only; no kanban path.
  - **`agent/context_compressor.py: _PATH_MENTION_RE`** extracts file paths the agent mentioned in conversation. Unrelated.
- Inside a card body, the string `@miner` is plain text. Assignment is `assignee=<profile>` at `kanban_create` time only ([ref](#kanban--create-flags-and-fields)).
- P6 is best read as **convention upstream codifies but doesn't implement**: you may write `@reviewer look at this` in a comment as a signal to a human reader (or to the next worker invocation that reads the comment thread via `kanban_show()`), but Hermes itself takes no automated action on it.

**Issue tracker — verified 2026-06-06.** Comprehensive search of `gh issue list --repo NousResearch/hermes-agent --state all`:

- **No open or closed issue / PR proposes a P6 `@mention` parser** for kanban card bodies. Searches across `P6`, `mention DSL`, `inline routing prose`, `@reviewer kanban`, `@planner kanban` returned only the doc-page hit and unrelated chat-platform mention-routing PRs.
- The original [Kanban v1 RFC (#16102, closed)](https://github.com/NousResearch/hermes-agent/issues/16102) explicitly flags **"skill-aware routing"** as v2 design input — but eight weeks later no concrete proposal has appeared. P6 was named in the docs and nobody picked it up.

**Adjacent feature requests we should watch (all open as of 2026-06-06):**

| Issue | Why it matters to us |
|---|---|
| [#33245 — Task-scoped read-only skill overlays + orchestrator skill catalog](https://github.com/NousResearch/hermes-agent/issues/33245) | Asks for `--skill-root` overlays so a PM/orchestrator can attach skills per-task without bloating worker profiles. **Directly relevant** to our agent skill-bundle deployment: today we install all bundles into every profile via `setup-landfolk-profiles.sh`; an overlay API would let `@dispatcher` attach exactly the right bundle per card without sync. Lean: if this lands, simplify our deploy. If not, keep installing. |
| [#36079 — External worker-lane plugin API for AgentPlane-style supervisors](https://github.com/NousResearch/hermes-agent/issues/36079) | Proposes `register_worker_lane(match, spawn_fn, profile_exists=True)` so assignees matching a pattern dispatch to an external supervisor instead of a fake profile. **This is essentially the spawn-layer API we need for bot-bound cards** ([`impact.md`](impact.md) Section F). If it lands, our `landfolk` plugin registers a lane for `bot-bound` cards instead of monkeypatching gate-check. Worth watching closely. |
| [#35261 — Task tagging / structured metadata](https://github.com/NousResearch/hermes-agent/issues/35261) | Adds first-class `tags:[]` to cards. Could replace some uses of `metadata.bot` with `tags:[bot:pip]`, or coexist. If it lands, evaluate whether tags are cleaner than free-form `metadata.bot`. |
| [#24206 — Per-task model override](https://github.com/NousResearch/hermes-agent/issues/24206) | Confirms upstream knows the gap. Still open. Don't plan against it; per-agent profile model + intra-phase `delegate_task` remain the only routing knobs. |
| [#23961 — `on_kanban_tick` hook?](https://github.com/NousResearch/hermes-agent/issues/23961) | Relevant for our `@dispatcher` polling design. Open question, no answer yet. We'd use it if present; we plan for its absence. |
| [#26116 — `/goal` doesn't auto-route to Kanban](https://github.com/NousResearch/hermes-agent/issues/26116) | Confirms there's no prose→cards routing today; `/goal` is same-session continuation only. Reinforces that our `@planner` parser is the only path from intent text to cards. |
| [#19931 — Specialist worker lanes architecture (closed)](https://github.com/NousResearch/hermes-agent/issues/19931) | The architecture predecessor for #36079. Worth reading for the **explicit `assignee: codex \| claude-code \| opencode` routing model** — upstream's mental model for "this card goes to a non-profile worker" matches what we want for `bot:pip`. |

**Our usage:**
- The hermescraft `@mention` DSL described in [`hermes-agents.md`](hermes-agents.md) is **a hermescraft-built feature**, not a Hermes one. We own the parser end-to-end.
- `@planner` is the parser. It walks card body lines, matches `^@(\w+)(?:\s+(\w+))?\s+(.+)$` for the `@agent [bot] <action>` form, validates `:mark:` references against `/api/marks`, and emits one `kanban_create` call per matched line with `assignee=<agent>` and optional `metadata.bot=<bot>`. No LLM call required for the parse step.
- Lines that don't match the DSL fall through: either to the native auto-decomposer (if we ever enable it for prose cards) or to `@planner`'s playbook library.
- Practical reading of P6: upstream gave the convention a name. We built the routing layer underneath. The naming convergence is good — it means our DSL feels native to anyone reading the Hermes docs — but the implementation is entirely ours.
- **Don't expect upstream to grow into P6 directly.** Even if Hermes ever ships a native `@mention` parser, ours still owns Minecraft-specific semantics: per-line bot binding (`@crafter pip produce slabs`), `:mark:` validation, parent-graph rewiring (`[parents: 0,1]`), and inline flags like `--max-runtime`. Plan as if the upstream feature won't arrive.
- **Do watch #33245 and #36079.** Those are the two upstream features that would simplify our implementation if they land — task-scoped skill overlays would clean up the deploy story, and a worker-lane plugin API would clean up our bot-bound spawn layer.

---

## Kanban — inter-agent communication patterns

**Official docs:** [User Guide — Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban), [Worker lanes](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes)

**The fundamental constraint:** workers spawn only when a card they're assigned to hits `ready` and gets claimed by the dispatcher. **A profile that isn't currently the assignee of a `ready`/`running` card has no execution turn.** This is the durability model — there's no daemon per profile, no inbox-poll loop, no event-driven wake.

**Key facts:**

- **Comments are the persistent thread, not a wake signal.** From the kanban docs: *"Comment — the inter-agent protocol. Agents and humans append comments; when a worker is (re-)spawned it reads the full comment thread as part of its context."* Mentioning `@reviewer` in a comment **does not spawn `@reviewer`** — it just leaves text the next worker on that card will read via `kanban_show()`.
- **`kanban_show()` returns the full thread on spawn:** *"Read the current task (title, body, prior attempts, parent handoffs, comments, full pre-formatted `worker_context`)."* That's how an agent "receives" anything — by being spawned on a card whose thread now contains it.
- **Wake mechanisms — the only four:**
  1. **`kanban_create(assignee=B, …)`** — A creates a new card for B. B's worker spawns when the card hits ready. This is the durable, observable, lifecycle-tracked path.
  2. **`kanban_unblock`** — a reviewer unblocks a blocked card; dispatcher respawns the **same assignee** on the same card; the new worker reads the updated thread.
  3. **`kanban_reassign`** — atomic transfer of a card to a new assignee; new worker spawns, reads the thread.
  4. **`rerun_task`** ([PR #29097](https://github.com/NousResearch/hermes-agent/pull/29097), v0.15) — reset a `done`/`blocked`/`gave_up` card to `ready`; same assignee respawns.
- **Subscriptions are chat-platform delivery, not agent wake.** `hermes kanban notify-subscribe --platform telegram --chat-id …` routes terminal events to a human-facing Discord/Telegram/Matrix channel. [PR #35635](https://github.com/NousResearch/hermes-agent/pull/35635) added `kanban.assignee_notification_channels` for per-profile lanes — but explicitly *"keeps worker/profile channels as notification lanes only; it does not implement channel-to-profile execution routing."* A profile getting a Discord notification still doesn't spawn a worker.
- **Session continuity across spawns is not durable.** Each spawn is a fresh AIAgent. [PR #33873 — "persist worker `session_id` per run and pass `--resume` on respawn after unblock"](https://github.com/NousResearch/hermes-agent/pull/33873) — closed, not merged. Plan for fresh-context-per-card.
- **P5 (Human-in-the-loop) is the closest documented "reply" pattern:** *"worker blocks → user comments → unblock"*. The worker that wrote the block sees the new comments when respawned. It's a synchronous request/response between a worker and a human, not between two agents.
- **The RFC v2 hint** ([#16102](https://github.com/NousResearch/hermes-agent/issues/16102)) flagged *"structured comments as multi-peer session substrate"* as an open v2 question. Eight weeks later, no implementation. Watch but don't depend.

**The implied agent-to-agent protocol** (composed from the primitives above):

| Goal | Pattern |
|---|---|
| A wants B to do work | A calls `kanban_create(assignee=B, title=…, parents=[A_card_id])`. B's worker spawns when the card hits ready. |
| A wants B's answer to flow back | B writes the answer in `kanban_complete` metadata + summary on B's card. A's worker reads it via parent handoff or `kanban_show(B_card_id)` when A respawns. |
| A wants B's review of a blocked card | A blocks. Either an orchestrator creates a `[REVIEW]` card assigned to B with `parents=[A_card_id]`, or B's review happens out-of-band and a human runs `kanban_unblock(A_card_id, comment=…)`. The unblock respawns A's original assignee, not B. |
| Long-running dialogue between A and B | Not supported as a session. Encode as a card chain: each turn is a card; each agent's response is a `kanban_complete` + child card to the other. |
| Broadcast / pub-sub on a card | Not supported between agents. Subscribe a chat platform for human visibility instead. |

**Our usage:**
- This model **fits hermescraft well** because our work is already phase-as-card. `@miner` → `@navigator` handoff is a parent/child pair, not a chat. `@miner` writes `{inv_delta, exit_pos}` on `kanban_complete`; `@navigator`'s worker reads it from the parent's metadata.
- **The `@mention` DSL is a write-time routing tool, not a wake tool.** `@planner` parses `@miner extract iron` and emits a `kanban_create(assignee=miner)`. The card is what wakes `@miner` — the literal `@` text doesn't.
- **Don't design protocols that require an agent to "reply to a comment."** If `@overseer` needs to ask `@dispatcher` something, the answer goes through a card, not a comment thread. Same for `@sentinel` raising a threat: emit a `[URGENT] @soldier` card, don't post a comment hoping `@soldier` checks in.
- **`@dispatcher` polling is the workaround for "always-listening" agents.** Either a long-running standalone worker (one card that reschedules itself), a cron card every N minutes (fresh AIAgent each tick), or a plugin-extension polling the WS event stream from inside the gateway process. See [`board-dynamics.md`](board-dynamics.md) open question on plugin-extension vs bot-less agent.
- **WS event subscription is our async signal layer** — Fleet Manager subscribes to `/api/plugins/kanban/events?since=<id>` and reacts to `crashed`/`died`/`blocked`/`gave_up` events. This is event-driven, but the reaction is "write a new card / reassign / unblock," not "wake the affected profile to respond."

---

## Kanban — REST surface and WebSocket events

**Official docs:** [User Guide — Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)

**Key facts (all under `/api/plugins/kanban/`):**

| Method | Path | Purpose |
|---|---|---|
| GET | `/board?tenant=<n>&include_archived=...` | Full board grouped by status |
| GET | `/tasks/:id` | Task + comments + events + links |
| POST | `/tasks` | Create (accepts `triage: bool`, `parents: [...]`) |
| PATCH | `/tasks/:id` | status / assignee / priority / title / body / result / summary / metadata |
| POST | `/tasks/bulk` | Batch patch |
| DELETE | `/tasks` | Bulk delete (JSON body `{"ids": [...]}`) |
| POST | `/tasks/:id/comments` | Append comment |
| POST | `/tasks/:id/specify` | Triage specifier |
| POST | `/tasks/:id/decompose` | Kanban decomposer |
| GET | `/profiles` | Installed profiles + descriptions |
| PATCH | `/profiles/:name` | Set/clear description |
| GET | `/orchestration` | Read orchestration config |
| PUT | `/orchestration` | Update orchestration config |
| POST | `/links` | Add parent → child dependency |
| DELETE | `/links?parent_id=...&child_id=...` | Remove dependency |
| POST | `/dispatch?max=...&dry_run=...` | Nudge dispatcher |
| GET | `/workers/active` | Spawned workers: PID, profile, task id, started-at, last heartbeat |
| GET | `/runs/{id}` | Single-run detail (task id, status, started/ended, exit code, log path) |
| GET | `/inspect` | Dispatcher snapshot (backlog, in-progress vs `max_in_progress`, recent events) |
| GET | `/config` | Read `dashboard.kanban` preferences |
| WS | `/events?since=<event_id>` | Live `task_events` stream |

**Our usage:**
- Fleet Manager subscribes to the WS event stream for rebind on `crashed`/`reclaimed`/`died` events.
- `/workers/active` and `/inspect` replace our `pgrep`-based `landfolk status` introspection.
- `/board` + `/tasks/:id` are how the dashboard surfaces bot lanes.
- `/api/marks` (separate from kanban) is what `@planner` reads to validate `:mark:` references at parse time.

---

## Kanban — `task_events` kinds

**Official docs:** [User Guide — Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)

**Lifecycle:** `created`, `promoted`, `claimed`, `completed`, `blocked`, `unblocked`, `archived`.
**Edits:** `assigned`, `edited`, `reprioritized`, `status` (dashboard drag-drop).
**Worker telemetry:** `spawned` (`{pid}`), `heartbeat` (`{note?}`), `reclaimed` (`{stale_lock}`), `crashed` (`{pid, claimer}`), `timed_out` (`{pid, elapsed_seconds, limit_seconds, sigkill}`), `stale` (`{elapsed_seconds, last_heartbeat_at, heartbeat_age_seconds, timeout_seconds, pid, terminated}`), `respawn_guarded` (`{reason}`), `spawn_failed` (`{error, failures}`), `protocol_violation` (`{pid, claimer, exit_code}`), `gave_up` (`{failures, effective_limit, limit_source, error}`).

**Our usage:**
- `respawn_guarded` + `gave_up` are first-class circuit-breaker telemetry that replace some of `scripts/auto-stuck-check.py`.
- Fleet Manager reacts to `crashed`, `died`, `timed_out`, `stale` for rebind logic.
- `blocked` with reason starting `world_state_mismatch:` is what triggers the [`board-dynamics.md`](board-dynamics.md) repair-chain pattern.

---

## Profiles + token locks

**Official docs:** [User Guide — Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles)

**Key facts:**
- A profile is a "separate Hermes home directory" — `~/.hermes/profiles/<name>/`. Owns its own `config.yaml`, `.env`, `SOUL.md`, memories, sessions, skills, cron, state database, gateway state.
- `HERMES_HOME` env var scopes all file paths. Default profile is `~/.hermes/` itself.
- `.env` precedence: per-profile `.env` overrides top-level `~/.hermes/.env`. **Key rotation must hit both.**
- One profile = one gateway. Gateways do not span profiles.
- **Token locks:** if two profiles try to use the same messaging-bot token (Telegram, Discord, Slack, WhatsApp, Signal), the second gateway startup fails explicitly. Runtime guard, not compile-time.
- **No documented session-level mutex** on profile use. Isolation is OS file-level (separate `HERMES_HOME`).

**Our usage:**
- Under the [target architecture](target.md): **agents are profiles** (`miner`, `navigator`, `crafter`, `planner`, `dispatcher`, etc.), not bots. Each profile holds the agent's `.env` (provider keys, no MC binding), `config.yaml` (model + `env_passthrough: [MC_API_URL, MC_USERNAME]`), `SOUL.md`, skills, memory, sessions.
- Bots (`pip`, `mox`, … — [`bot-roster.md`](bot-roster.md)) are **not** Hermes profiles — they're registry entries (`data/bots/<bot>.yaml`) consumed at worker spawn for MC env injection. See [`workspaces.md`](workspaces.md).
- Token-lock pattern doesn't transfer — our "gateway" is the Mineflayer process. The per-bot mutex we need is enforced by the landfolk plugin reading `metadata.bot`.
- Today's bot profiles (`flint`, `mason`, ...) retire as part of the migration. The `.env` rotation hazard goes away: agent profiles share provider keys but have no MC bindings.

---

## `hermes profile` CLI

**Official docs:** [User Guide — Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles) + [Profile Distributions](https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions)

**Key facts:**
- `hermes -p <name> <command>` — scope a command to a profile.
- `hermes profile create <name> [--description "..."] [--no-skills]` — create a new profile directory.
- `hermes profile use <name>` — set sticky default for the shell.
- `hermes profile list` — list installed profiles + status.
- `hermes profile show [<name>]` — show sessions, memory size, etc.
- `hermes profile describe <name> [--text "..." | --auto]` — set/clear description (the decomposer reads these).
- Wrapper scripts: `<profile> chat`, `<profile> gateway start` — created on profile install.

**Our usage:**
- Today: [`scripts/setup-landfolk-profiles.sh`](../../scripts/setup-landfolk-profiles.sh) sets up bot profiles (`flint`, `mason`, etc.) + a Steward profile. These retire under the target architecture.
- Target: a rewritten deploy creates **agent profiles** (`miner`, `navigator`, `crafter`, `builder`, `soldier`, `farmer`, `planner`, `dispatcher`, `overseer`, …) and writes the `data/bots/*.yaml` registry. See [`impact.md`](impact.md) for the migration plan.
- Profile descriptions matter for the native auto-decomposer fallback path — set them on agent profiles.

---

## Multi-profile gateways

**Official docs:** [User Guide — Multi-Profile Gateways](https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways)

**Key facts:**
- macOS: `~/Library/LaunchAgents/ai.hermes.gateway-<profile>.plist`.
- Linux: `~/.config/systemd/user/hermes-gateway-<profile>.service`.
- CLI: `<profile> gateway start|stop|restart` works per-profile independently.
- **No documented routing layer** between profiles. No pause/in-use marking. No queueing/leasing across gateways.
- No mechanism for binding long-lived external connections to a profile gateway.
- Health check: `hermes -p <profile> doctor`.

**Our usage:**
- We don't need this. Mineflayer is the gateway from Hermes' perspective; the Hermes profile binds via env vars.
- [`scripts/landfolk`](../../scripts/landfolk) already supervises per-bot start/stop richer than the upstream multi-profile pattern.
- Useful only if we ever add a chat-platform bot for `@planner` in-game responses — not the current direction.

---

## Delegation

**Official docs:** [User Guide — Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)

**Key facts:**
- Tool: `delegate_task(goal, context, toolsets=[...], model=..., max_iterations=..., role="leaf"|"orchestrator")`.
- Batch form: `delegate_task(tasks=[{...}, {...}])` — up to 3 concurrent by default.
- **Synchronous and blocking.** Parent waits for child. **Children die if parent is interrupted.**
- Isolation: fresh conversation per child; no parent history visible.
- Return: only the **final summary** enters parent context. Not the full transcript.
- Model + provider per child: `delegation.model`, `delegation.provider` in config; can override per-call.
- Restricted toolsets per child via the `toolsets` parameter.
- Always-blocked tools in leaf subagents: `delegation`, `clarify`, `memory`, `code_execution`, `send_message`.
- Depth: `max_spawn_depth` (default 1 = flat). Range 1-3. Orchestrator subagents can delegate further; leaves cannot.
- Cost scales multiplicatively: at depth 3 with 3 concurrent children, tree can reach 27 leaves.
- TUI `/agents` overlay shows live tree, per-branch cost, file-touched rollups, pause/kill controls.

**Our usage:**
- **Wrong tool for outer phase work** — phases are kanban cards (durable, survive restart). Delegation doesn't survive parent interrupt.
- **Right tool for intra-phase specialization in short bot-less cards** — e.g., `@crafter` material budget computation that benefits from per-step model routing. The only place per-step model selection is exposed on v0.15.
- See [`hermes-agents.md`](hermes-agents.md) + [`board-dynamics.md`](board-dynamics.md) "Delegation's narrow role".

---

## Plugins + hook surface

**Official docs:** [User Guide — Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)

**Key facts:**
- `plugin.yaml` manifest at plugin root: `name`, `version`, `description`. Optional: `author`, `kind` (`standalone`/`backend`), `hooks`, `requires_env`.
- Entry point: `register(ctx)` in `__init__.py`.
- `ctx` (PluginContext) methods:
  - `register_tool(name, toolset, schema, handler)`
  - `register_hook(hook_name, callback)`
  - `register_command(name, handler, description)` — slash commands
  - `register_cli_command(name, help, setup_fn, handler_fn)` — `hermes <plugin> <verb>`
  - `register_skill(name, path)`
  - `register_platform(name, label, adapter_factory, ...)`

**Documented hooks** (with firing conditions):
- `pre_tool_call` — before any tool executes
- `post_tool_call` — after any tool returns
- `pre_llm_call` — once per turn, before LLM loop (can inject context)
- `post_llm_call` — once per turn, after LLM loop (success only)
- `on_session_start` — first turn of new session
- `on_session_end` — every `run_conversation` end + CLI exit
- `on_session_finalize` — CLI/gateway tears down active session
- `on_session_reset` — gateway swaps in new session key
- `subagent_stop` — once per child after `delegate_task` finishes
- `pre_gateway_dispatch` — gateway received user message, before auth/dispatch

**Other hooks referenced in source** (`hermes_cli/plugins.py` `VALID_HOOKS`) but not all documented on the public page: `transform_terminal_output`, `transform_tool_result`, `transform_llm_output`, `pre_api_request`, `post_api_request`. **No `pre_decompose` or `post_decompose` hook exists.**

**Discovery and enablement:**
- Plugins discovered from (in precedence order): bundled `<repo>/plugins/`, user `~/.hermes/plugins/`, project `.hermes/plugins/` (requires `HERMES_ENABLE_PROJECT_PLUGINS=true`), pip entry_points.
- Later sources override earlier on name collision.
- **Opt-in:** `plugins.enabled: [name, ...]` in `~/.hermes/config.yaml`. `plugins.disabled` wins if in both.
- Bundled platforms/backends/memory/context/model-providers auto-load without opt-in.

**Our usage:**
- Our [`plugins/landfolk/__init__.py`](../../plugins/landfolk/__init__.py) registers `post_tool_call` (parking + promote) and `register_cli_command` (`hermes landfolk gate-check`). Live and load-bearing.
- The doc banner in [`docs/specs/kanban/plugin-landfolk.md`](../specs/kanban/plugin-landfolk.md) claiming "hooks never registered" is **stale** — see `__init__.py:28`.
- No decompose-lifecycle hooks means we can't intercept the LLM decomposer; our path-B fallback uses `post_tool_call` on `kanban_create` events instead.

---

## Skills

**Official docs:** [User Guide — Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)

**Key facts:**
- Storage: `~/.hermes/skills/<category>/<skill-name>/SKILL.md` (required) + optional `references/`, `templates/`, `scripts/`, `assets/`.
- External dirs: `skills.external_dirs: [...]` in `config.yaml`. Local precedence on naming conflict.
- Skill bundles: `~/.hermes/skill-bundles/<slug>.yaml` — groups multiple skills under one slash command. `/bundle-name` loads all; bundles take precedence over individual skills.
- **Progressive disclosure via `skill_view` tool:**
  - Level 0: `skills_list()` → `[{name, description, category}, ...]` (~3k tokens)
  - Level 1: `skill_view(name)` → full content + metadata
  - Level 2: `skill_view(name, path)` → specific reference file
- `SKILL.md` format: YAML frontmatter (`name`, `description`, `version`, `platforms`, `metadata.hermes.{tags, category, requires_toolsets, config}`) + markdown body.
- CLI: `hermes skills browse/search/install/list`.
- Skills can declare `required_environment_variables` and `config` settings stored in `config.yaml`.
- Agents can modify skills via `skill_manage` tool (`create`, `patch`, `edit`, `delete`).

**Our usage:**
- Agent skill bundles (`agent-navigator`, `agent-miner`, etc.) live in [`skills/`](../../skills/) and get installed per profile by [`scripts/setup-landfolk-profiles.sh`](../../scripts/setup-landfolk-profiles.sh).
- Workers call `skill_view('agent-navigator')` as turn 1 (per our worker SOUL pattern) to load the bundle body.
- `kanban_create(skills=[...])` requires the skill names to exist on the assignee profile — installation is part of setup, not dispatch.
- The `skill_manage` tool gives `@engineer` (future) a path to modify skill bundles via PR workflow.

---

## Memory

**Official docs:** [User Guide — Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)

**Key facts:**
- `~/.hermes/profiles/<profile>/memories/MEMORY.md` (~800 tokens / 2200 chars) — agent's notes.
- `~/.hermes/memories/USER.md` (~500 tokens / 1375 chars) — user preferences.
- Both injected into the system prompt **at session start as a frozen snapshot** — preserves LLM prefix caching. Changes appear in next session.
- `memory` tool: `add`, `replace`, `remove` (substring-matched). **No `read` action** — content auto-injected.
- 80% capacity warning; agent must consolidate before adding more.
- `session_search` tool — full-text FTS5 search across SQLite-stored sessions; ~20ms queries, no token cost. `hermes sessions list` to browse.
- Eight external memory provider plugins (Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory) configurable via `hermes memory setup`.

**Our usage:**
- Workers append to bot's `MEMORY.md` via the `memory` tool for cross-card durable knowledge ("died at coords X", "village to the north"). See [`workspaces.md`](workspaces.md) for the boundary between memory and workspace artifacts.
- `session_search` is the v0.15 fast-path that subsumes some of [`scripts/auto-stuck-check.py`](../../scripts/auto-stuck-check.py) log scanning.
- Memory size caps mean expertise that doesn't fit (vein databases, recipe caches) lives in agent workspaces, not memory.

---

## Tools and toolsets

**Official docs:** [User Guide — Tools & Toolsets](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools)

**Key facts:**
- Toolsets are logical groupings of capabilities; selected per profile via `toolsets:` in `config.yaml`.
- Built-in (partial): `web`, `search`, `x_search`, `terminal`, `file`, `process`, `browser`, `vision`, `image_gen`, `tts`, `todo`, `clarify`, `execute_code`, `delegation`, `memory`, `session_search`, `cronjob`, `messaging`, `homeassistant`, `spotify`, `discord`, `discord_admin`, `debugging`, `code_execution`, `rl`, `safe`.
- Platform presets: `hermes-cli`, `hermes-telegram`, dynamic `mcp-<server>`.
- `disabled_toolsets` config suppresses specific capabilities.
- Naming: snake_case (`web_search`, `browser_navigate`, `vision_analyze`).
- Terminal backend swappable: `local` (default), `docker`, `ssh`, `singularity`, `modal`, `daytona` via `terminal.backend`.
- Custom tools added via plugins (`ctx.register_tool(...)`).
- Kanban tools (`kanban_create`, `kanban_show`, etc.) are **plugin-provided**, not in the built-in toolset list on this page.

**Our usage:**
- Bot-bound workers need: `terminal` (for `mc`), `kanban` (plugin), `file`, optional `memory`/`session_search`.
- Bot-less agents (`@dispatcher`, `@planner`, `@overseer`) need: `kanban`, `file`, `memory`, `session_search`. No `terminal` access to MC needed.
- `@engineer` needs: `terminal` + `file` + `code_execution` + git via terminal.
- `disabled_toolsets` is a per-agent boundary mechanism — we can disable tools an agent shouldn't reach for.

---

## Goals (`/goal`)

**Official docs:** [User Guide — Goals](https://hermes-agent.nousresearch.com/docs/user-guide/features/goals) (best-effort URL; verify in the live site nav)

**Key facts:**
- `/goal` slash command — set/clear a persistent goal that persists across sessions.
- Kanban integration via `--goal` flag and `--goal-max-turns N` (default 20) on `kanban create`.
- In goal-mode, the worker keeps acting toward the goal until satisfied or max-turns hit.

**Our usage:**
- [`data/base-goals.yaml`](../../data/base-goals.yaml) defines world-scope goals; `@planner` consumes them when reading triage context.
- Per-bot goal files like `data/goals-<bot>.json` are bot-specific role goals — kept where they are per the [`workspaces.md`](workspaces.md) marks decision.
- Goal-mode cards may apply to `@overseer` epic-review work (judge until convinced), not to execution agents.

---

## Cron

**Official docs:** see [Developer Guide — Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture) (scheduler.py) and the cron-related CLI subcommands (verify with `hermes cron --help` after upgrade — public docs page is thin)

**Key facts:**
- Cron jobs are first-class agent tasks stored in `jobs.json`, not shell tasks.
- Scheduler ticks within the gateway's main loop or standalone CLI context.
- Per tick: load due job → create **fresh AIAgent (no history)** → inject attached skills as context → execute prompt → deliver to target platform.
- `--no-agent` flag for script-only jobs (no LLM call) — verify exact CLI surface in v0.15.2.
- Per-profile by default; v0.15 adds cross-profile cron visibility and per-job profile support.
- Notification delivery across profiles via `kanban.notification_sources` (v0.15).

**Our usage:**
- `@sentinel` watcher cards are candidate cron jobs — patterns to mine from [`../archive/steward-out-of-game.md`](../archive/steward-out-of-game.md).
- `@dispatcher` polling could be a cron job rather than a long-running worker — open question in [`board-dynamics.md`](board-dynamics.md).
- The "fresh AIAgent per tick" model is what bot-less agent cards inherit naturally.

---

## Auxiliary clients

**Official docs:** see [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration) — auxiliary clients are a config-level pattern

**Key facts:**
- `auxiliary.<task>.{provider, model, base_url, api_key, timeout, extra_body}` config per auxiliary task in `~/.hermes/config.yaml`.
- Documented tasks observed in source: `kanban_decomposer`, `profile_describer`, `curator`. Likely more.
- Each task lazily resolves its own client; unset values fall back to the active profile's default provider/model.
- Used for: decomposition, profile auto-description, content curation, and other "side" LLM calls that shouldn't burn the main agent budget.

**Our usage:**
- `auxiliary.kanban_decomposer.model` — pin to a cheap fast model for the prose-fallback path when `@planner` doesn't parse `@mentions`.
- Pattern reusable for any future side-LLM task: capacity forecasting, plan-feasibility checks, etc.

---

## `hermes status` and `hermes doctor`

**Official docs:** [Getting Started — Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating) (doctor) + [User Guide — CLI](https://hermes-agent.nousresearch.com/docs/user-guide/cli) (status slash command)

**Key facts:**
- `hermes doctor` — comprehensive check of configuration, dependencies, service health.
- `hermes -p <profile> doctor` — scoped to a profile.
- `hermes config check` — finds missing config keys post-update (different from `doctor`).
- `hermes config migrate` — interactive add of missing keys.
- `/status` slash command (inside a session) — model/profile/tokens/duration + recap block.
- `hermes status` (CLI) — partially documented; check `hermes status --help` for full surface.
- `hermes version` — current version. Compare against GitHub releases for upgrade.

**Our usage:**
- Pre-flight + post-upgrade verification (per [`../platform/hermes-upgrade-0.15-runbook.md`](../platform/hermes-upgrade-0.15-runbook.md)).
- Operator's "is the fleet healthy?" surface — could be composed into `landfolk status` to roll up per-bot `hermes doctor` outputs.

---

## Hermes internal architecture

**Official docs:** [Developer Guide — Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)

**Key facts:**
- Five major subsystems:
  - **AIAgent** (`run_agent.py`) — the synchronous conversation loop. Single orchestrator used by CLI, gateway, cron, ACP.
  - **Gateway** (`gateway/run.py`) — long-running messaging dispatcher; supports 20 platform adapters; manages session routing, auth, slash commands, hooks.
  - **Provider Resolution** (`runtime_provider.py`) — `(provider, model)` → credentials + API mode; 18+ providers, OAuth, alias resolution.
  - **Tool System** (`tools/registry.py`) — 70+ tools across ~28 toolsets. Tools self-register at import time.
  - **Plugin Manager** (`plugins/`) — three discovery sources (user, project, pip). Plugins register tools/hooks/CLI/skills.
- **Cron scheduler ticks within gateway main loop or standalone CLI** — creates fresh AIAgent per job with skills attached as context.
- **Profile isolation enforced at filesystem and database layers** via `HERMES_HOME` propagation.
- Sessions are SQLite-persisted with lineage tracking (parent/child across compressions) and FTS5 full-text search.
- Tool plugins register via `register_tool()` and trigger import-time discovery.

**Our usage:**
- Knowing the layering tells us where to instrument observability (gateway logs, tool registry events, plugin hooks).
- "Fresh AIAgent per cron tick" is the model our bot-less agent cards (`@dispatcher`, `@sentinel`) inherit.
- Profile isolation at filesystem level means bot env files and workspaces stay cleanly separated — no extra mutex needed for per-bot state.
- The five-subsystem split is useful when reasoning about where a new agent capability should attach (most go through the kanban plugin, not into Hermes core).

---

## Updating

**Official docs:** [Getting Started — Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating)

**Key facts:**
- `hermes update` — auto-detects installation type, pulls latest, runs dependency + config migration.
- `hermes update --backup` — full snapshot of `HERMES_HOME` (config, auth, sessions, skills) before update. Opt-in due to time cost.
- `updates.pre_update_backup: true` config key — enables backup on every update.
- Post-update validation: `hermes doctor`, `hermes config check`, `hermes config migrate`.
- PyPI versions track tagged releases. Date-based tag pattern: `vYYYY.M.D` (e.g., `v2026.5.29.2`).
- `hermes version` shows current; compare to GitHub releases.
- **Rollback:** `git checkout <commit-hash>` + `uv pip install -e ".[all]"`, OR `git checkout vX.Y.Z` for tag. Run `hermes config check` after, remove unrecognized config keys.

**Our usage:**
- See [`../platform/hermes-upgrade-0.15-runbook.md`](../platform/hermes-upgrade-0.15-runbook.md) for the hermescraft-specific upgrade runbook (pre-flight, verification, adoption phases). This reference doc is the **primitive catalog** architecture cites; the guide is **how to install and verify**.
- Phase 0 pre-flight uses `hermes doctor` + `hermes config check` per docs.
- Rollback path: pip-pinned reinstall of v0.14.0 + restore from `/tmp` backups.

---

## How to use this reference

- Architecture docs cite specific entries here when describing v0.15 features.
- When a fact changes (Hermes version update), update the relevant section + the "Last verified against" date at the top.
- Drop sections that become irrelevant; add sections for new primitives the architecture starts depending on.
- This doc is not a copy of Hermes' docs — it's the slice that matters to us, with our usage notes attached.

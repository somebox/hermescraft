# Farmer feedback — w1-1780879052 (bot:mox)

## Problems hit

- **MC_API_URL injection remains broken (4th run).** Same as w1-1780871693,
  w1-1780875295, and the chrono-sync run: the terminal session does not have
  `MC_API_URL` or `MC_USERNAME` set despite the card body promising
  "injected at spawn from `data/bots/<bot>.yaml`". I use the pre-existing
  `bin/mc` workaround on each turn but the first turn is always a blind
  `mc status` fail followed by a fix-up. This is now the single highest-token
  tax across all farmer cards — ~2 wasted calls per card, every card.

- **`mc farm_status` still takes raw coords, not mark names.** `mc farm_status
  --mark wheat_plot` would save the "look up corners → type them out" dance
  on every plant and harvest card. This was flagged in feedback #1, #2, and
  #3 — no change observed across any of the intervening runs.

- **Cron one-shot for harvest reminder still depends on gateway being alive.**
  The `cronjob(action='create', ...)` call returns a job id, but if `hermes
  gateway` isn't running on the host (which it wasn't), the scheduled reminder
  never fires. The card flows through to `kanban_complete` on the planting
  side but the downstream harvest card waits forever for a trigger that will
  never come. There is no `gateway_is_alive` probe available from a worker.

- **`mc till_area` UNCHANGED on the water tile is still noise.** 80/81 cells
  succeed, 1 returns UNCHANGED because it's the water source cell. Every new
  reader spends a turn verifying nothing is broken. A one-line change in the
  `mc till_area` response (filter UNCHANGED when the cell is already water)
  or in the skill documentation would remove this friction.

- **Fourth FEEDBACK card repeating all the same items.** This is now the
  fourth farmer feedback card on wheat-capstone — w1-1780871693, the chrono-sync
  run, w1-1780875295, and now w1-1780879052. The action items have been
  identical across all four: MC_API_URL injection, farm_status --mark,
  gateway/cron dependency. The feedback mechanism is one-shot per run with
  no dedup or status tracking, so each run writes the same complaints into a
  different file and the list never shrinks. A per-board "known issues" tracker
  (kanban board meta-task, a lightweight JSON registry, or even a single
  staleness-dated file) would consolidate the feedback so the next run either
  resolves the issue or acknowledges it's still open.

- **No in-world timer primitive exists for harvest scheduling.** The card
  says "plant + schedule harvest" and the only scheduling tool is the Hermes
  cron system (platform-level). An `mc reminder add 90 "mc harvest ..."` verb
  would be a self-contained Minecraft-domain solution — no gateway required,
  no cron infrastructure, the bot comes back and fires the timer. Until that
  exists, the harvest-reminder step is a cross-layer dependency that silently
  fails when the gateway isn't up.

## Tooling improvements

1. **`mc farm_status --mark <name>`** — resolves a mark's saved bounding box
   and runs farm_status on it. This is the single highest-ROI change for the
   farmer agent: it would save ~3-4 tool calls per card (no `mc marks` lookup,
   no coord-by-coord extraction, no typo risk) across both plant and harvest
   phases. Estimated savings: 15-20% of total tool calls per farmer card.

2. **Stale `stuck_warning` auto-clear on new task.** When a farmer worker
   spawns at the correct plot and `mc status` shows `stuck_warning` from a
   builder card 3 runs ago, that's noise, not a real stuck condition. The
   stuck_warning counter is position-based and doesn't reset on task boundary
   — either auto-clear it when a new kanban task claims the bot, or add a
   `--no-stuck-warning` flag to `mc status` for turn-1 orientation.

3. **`mc reminder` in-world timer verb.** A fully Minecraft-domain timed
   callback: `mc reminder add 90 "mc harvest -54 46 -46 54 64"` that fires
   the verb and broadcasts to chat when the timer expires. This would
   eliminate the cron+gateway dependency entirely from the harvest scheduling
   flow, making it hermetic within the Minecraft domain.

## Bundle / skill gaps

- **agent-farmer.md §2 "Verbs you use" lists `mc farm_status :mark:`** yet
   `mc farm_status` doesn't accept mark names. This was flagged in the
   previous two feedback cards. The literal command in the skill document is
   still aspirational rather than functional. Either the CLI needs to support
   mark resolution in farm_status, or the skill should document the fallback
   coord-form.

- **agent-farmer.md has no "post-plant handoff" section for the cron step.**
   The agent-farmer skill covers every in-world verb well, but the card body
   asks for "schedule harvest" which is an Hermes-platform operation (cronjob
   tool). There's no documentation on what to expect if the cron job succeeds
   or what to do if the gateway is unreachable — the farmer silently
   `kanban_complete`s their part while the second phase is dead.

- **minecraft-farming.md §"construct/till" doesn't mention UNCHANGED on water.**
   A one-line note: "`mc till_area` returns UNCHANGED for the water source cell;
   that's correct behaviour — skip/ignore that col" would save the reader-
   confusion tax every new worker pays.

- **This feedback card is a structural anti-pattern.** Four identical feedback
   files in four different directories with the same findings and no resolution
   tracker. The feedback system is working as intended per-run, but the
   per-board/bot cross-run trends are invisible. A simple JSON file at
   `data/postmortems/wheat-capstone/_known_issues.json` keyed by issue slug
   with `{first_seen, last_seen, status, resolution}` would let each feedback
   card reference existing issues and mark when they close.
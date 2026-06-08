# Farmer feedback — w1-1780875295 (bot:mox)

## Problems hit

- **MC_API_URL injection still unreliable.** Same issue as w1-1780871693: the env vars promised by "injected at spawn" don't appear in the terminal session. On the second run I knew to check `data/bots/mox.yaml` immediately, saving a few calls, but this is a permanent tax on every card. The `bin/mc` fallback script helps but is a workaround, not a fix.

- **Cron scheduled but gateway not running.** `cronjob(action='create', ...)` returned a job id and the scheduler confirmed persistence, but the gateway (`hermes gateway`) wasn't running on this system so the one-shot harvest reminder will never fire. The card's second phase (unblock when cron fires) is silently broken. The farmer completes their part but the downstream harvest is disconnected unless someone manually runs the cron trigger. There's no verb to check "is the gateway alive?" from the worker side.

- **No `mc farm_status --mark` — still manual.** `mc farm_status -54 46 -46 54 64` works but every time you need to look up the corners from `mc marks` and type them. The prior feedback noted this; it's unaddressed. Over a multi-worker pipeline this adds ~3-5 calls per harvest-or-plant card.

- **`mc till_area` UNCHANGED counter causes double-take again.** Tilling the 9×9 plot with water at the center: `mc till_area` returns 80/81 "succeeded" and 1 "failed" with `UNCHANGED`. The water cell at (-50,64,50) is correctly skipped but the "failed" counter is noise. A first-time reader spends a turn confirming nothing is wrong.

- **`mc timer` / `mc reminder` primitives don't exist.** The card asked for "schedule a harvest reminder" — the only way to do that is via the Hermes cronjob tool, which is an Hermes platform concern, not a Minecraft concern. An `mc reminder` or `mc timer` subcommand (in-world) would keep the loop inside the Minecraft domain and avoid the gateway-dependency problem entirely.

- **HERMES_HOME path override confusion persists.** `HERMES_HOME=/Users/foz/.hermes/profiles/farmer` causes `~` to resolve to a nonstandard path. The cron tool and skill paths are relative to the real `~/.hermes/`, so writing deeper paths requires manual expansion. Every turn I write `/Users/foz/hermescraft/...` explicitly because `~/hermescraft/` doesn't resolve correctly.

- **Profile bin/mc is a good workaround but fragile.** The `bin/mc` script that exports MC_API_URL + MC_USERNAME by reading `data/bots/mox.yaml` works — but only because the displaced worker profile happens to have access to `mox.yaml` via the parent project path. If the profile were truly isolated (container/ssh), this fallback wouldn't exist.

## Tooling improvements

1. **`mc farm_status --mark <name>`** — resolves a mark's bounding box (the named plot area) and runs farm_status on it. Would save ~4 tool calls per plant+harvest cycle: no `mc marks` extraction, no manual coord transcription, no typo risk.

2. **`mc reminder add N <verb>` / `mc reminder list`** — an in-world timed callback system so card phases can schedule a future action without depending on the Hermes cron/gateway layer. Example: `mc reminder add 90 "mc harvest -54 46 -46 54 64"` fires a chat message or executes the verb when the bot is next online. This would make the harvest-reminder flow self-contained—the bot comes back, fires the harvest, everyone downstream sees it without gateway infra.

3. **`mc status --no-stuck-warning`** — or make stale stuck_warnings (same position, older than last `kanban_complete`'s timestamp) auto-clear. A farmer restarting on the correct plot doesn't need to see "STUCK 13min" from a builder card 3 runs ago.

4. **MC_API_URL injection at the terminal tool layer** — rather than depending on shell-level env vars that leak unpredictably, the terminal tool itself could prepend `MC_API_URL=<value> MC_USERNAME=<value>` to every command when the profile is a Minecraft profile. This would side-step the env-propagation issue entirely.

## Bundle / skill gaps

- **agent-farmer.md §4** says "Read the parent handoff" and "Use `mc farm_status :mark:`" — but `mc farm_status :mark:` doesn't work because `mc farm_status` takes raw coords, not mark names. The literal command in the skill (`mc farm_status :mark:`) is aspirational, not functional. Either the CLI should support mark names or the skill should list the full coord form.

- **agent-farmer.md no mention of cron.** The card body explicitly called for "schedule harvest" which is an Hermes cron operation, but the farmer bundle has zero guidance on cron scheduling—no shape, no fallback if the gateway is down, no "this is the Hermes-level primitive for timed follow-ups" note. A bundle that expects its worker to use a tool should document the failure mode.

- **minecraft-farming.md §"construct/till kanban cards"** describes `mc verify_plot` and `mc till_area` well but doesn't mention the UNCHANGED-on-water tile behaviour. A one-liner ("tilling the water source cell returns UNCHANGED; that's correct — skip that col") would save the double-take.

- **This feedback card is the third FEEDBACK card for this profile** (w1-1780871693, then the chrono-sync run, then w1-1780875295). Between w1-1780871693 and w1-1780875295, the `mc inspect --mark` and `mc farm_status --mark` needs were identical. If the feedback mechanism is per-run but the action items are same-run-overlap, some issues get re-reported without resolution. A lightweight "known issues" tracker per bot/board could deduplicate and track closure status.

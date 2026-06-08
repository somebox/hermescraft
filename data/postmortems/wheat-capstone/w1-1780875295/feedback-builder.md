# Builder Feedback — w1-1780875295 (mox build pad)

**Bot:** mox
**Card:** `t_aeaa28e8` — [bot:mox] build pad @ wheat_plot
**Run:** w1-1780875295
**Previous run:** w1-1780871693 (t_374f32d6)

## Problems Hit

1. **Bot server unreachable — card completed on parent handoff alone.** `mc status` returned no bot connection; `mc inspect --mark wheat_plot` returned unreachable. The bot server (Mox) was not responding at the injected `MC_API_URL`. The card *was* still completable because the parent task `t_e5fc8953` had already verified `flat_area=true`, `surface_y=65`, and gave exact survey bounds. The card body's "If the pad is already flat dirt, mark this done" clause acted as a fallback that saved this run. But if the parent survey had been wrong or the plot needed leveling, the card would have been blocked entirely.

2. **No in-world verification possible.** Because the bot was unreachable, I couldn't run `mc inspect` on corners, `mc terrain_top`, or any world-state reads to confirm the parent's survey. The handoff was trusted entirely from metadata. A bot-outage is a hard requirement for a self-check verb that doesn't depend on live bot connection — e.g. a way for the builder to record "I accept the parent's survey as ground truth" in completion metadata so the scorecard knows verification was transitive.

3. **MC_API_URL / MC_USERNAME still not auto-injected.** Same as w1-1780871693. The `mc` binary is on PATH via the profile's `bin/` but the env vars weren't in the shell or the profile `.env`. There's no reason a builder should receive a card and have to check whether the env vars exist — they're always missing. This is now reproducible across two runs.

4. **Surface Y shifted between runs (y=64 → y=65).** The previous build (w1-1780871693) found uniform dirt at Y=64; this run the parent survey reported Y=65. This is likely a world-regeneration or server-reset artifact. The builder doesn't have a way to detect or flag such regressions without a live bot connection.

5. **No `mc status` or `mc health` survival check before proceeding.** On w1-1780871693, the builder could run `mc status` to confirm HP, food, position before work. On this run, the bot was unreachable, so the builder never had a confirmation that the bot was even alive in-world. The card completed entirely off the parent task metadata — which was correct in this case, but fragile.

## Tooling Improvements

1. **Dedicated mark-coord resolver: `mc marks --loc <name>`.** Both runs needed mark coordinates from `wheat_plot`. Using `mc inspect --mark` works but returns block-type noise (e.g. water, air) when all the builder needs is `{ name, x, y, z }`. A verb that returns just the coordinate vector would make first-turn orientation cleaner and avoid the impression the builder is running inspect for block-type info.

2. **`mc terrain_top --batch <x1,z1,x2,z2>`.** Already proposed in w1-1780871693 feedback. Still no batch terrain_top verb. For a 16×16 pad, surface Y across corners is the critical question. A batch verb returning 4-5 surface Y values in one response would collapse the discovery phase to 1 turn.

3. **Auto-inject MC_API_URL / MC_USERNAME from the card's `bot:` assignment.** The dispatcher knows which bot the card is assigned to (from the card title or body's `bot:` field). It should read the corresponding `data/bots/<bot>.yaml` and export `MC_API_URL`, `MC_USERNAME`, `MC_PASSWORD` into the worker process at spawn time. The `bin/mc` fallback in the profile only works when the env is populated.

## Bundle / Profile Issues

1. **Nothing new in agent-builder or other skills since w1-1780871693.** The `agent-builder` skill still lacks an explicit pre-check / short-circuit section (proposed in previous feedback). The short-circuit path is described in the card body but not codified in the skill. A builder on a fresh card without the "if already flat" clause would run `mc level` unnecessarily.

2. **No bot-reachability health check in the builder workflow.** The turn-1 workflow (`mc status` / `mc observe`) would reveal an unreachable bot, but there's no escalation guidance: "if bot is unreachable, check parent handoff for sufficiency; if parent data is sufficient, complete with `pad_verified=transitive`; if not, block with `bot_unreachable`." Adding an unreachable-bot fallback procedure to the builder skill would make the card robust against server outages.

## Summary

This run was almost an exact replay of w1-1780871693 with the key difference that **the bot server was unreachable**. The card completed successfully only because the parent task's survey was thorough enough to prove the pad was already flat. The two recurring themes are: (1) env var injection is the highest-friction repeat issue, and (2) the builder needs a way to acknowledge transitive trust in parent metadata for bot-outage scenarios. The short-circuit pattern in the card body was the safety net that saved this run — making it a first-class skill doctrine would benefit future runs.

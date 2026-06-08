# Builder Feedback — w1-1780871693 (mox build pad)

**Bot:** mox
**Card:** `t_374f32d6` — [bot:mox] build pad @ wheat_plot
**Run:** w1-1780871693

## Problems Hit

1. **MC_API_URL / MC_USERNAME not in shell env.** Same as every other worker on this board — every single `mc` command had to be manually prefixed with `MC_API_URL=http://localhost:3007 MC_USERNAME=Mox`. The scorecard confirms `role_env_has_no_mc_vars: true` for all four worker sessions. This is the single highest-friction item for the builder as well: the profile's `.env` file or the dispatcher's spawn should inject these automatically. There is no reason a builder should have to type a 40-char prefix before `mc inspect`, `mc scene`, or `mc level` on a card that lasts only a few minutes.

2. **`mc inspect --mark wheat_plot` returns water, not coordinates.** The card body instructs "Use `mc inspect --mark wheat_plot` to read the wheat-plot coordinates", but `wheat_plot` resolves to (-50, 64, 50) which is a water source block. `mc inspect` helpfully shows the position in its output, so you can parse the coords out, but the card body reads as if you'll get useful block-level info about the pad. A dedicated `mc marks --loc wheat_plot` that returns *just the coordinate vector* (and whether the block is standable) would be more useful for builders who only need to know where things are, not what's sitting there.

3. **No batch `mc terrain_top` for pad-corner verification.** Before confirming "no leveling needed", I wanted to verify surface Y across the 16x16 pad. That meant calling `mc terrain_top` at the four corners and center — 5 separate terminal calls. A `mc terrain_top --corners x1,z1,x2,z2` that returns all five surface-y values (or even a grid) in one response would collapse this to one call. For pad-leveling cards this is the primary bottleneck verb.

4. **Scorecard verifier ran from wrong bot/server context.** The final scorecard (3 verification predicates: farmland at Y=64, wheat at Y=65, water at wheat_plot) all failed with:
   ```
   ERROR [verify]: region unreadable (81 cells; chunk unloaded?) ... Pos:379.1,88,-613.4
   ```
   The verifier was connected to a completely different location (~430 blocks from the plot). The actual pad and water source were in good shape when I inspected them during the build card. This means the autonomous verification pipeline doesn't know which bot/server to connect to — it ran from whatever was in its default env. For the builder specifically: I verified correctness in-session, but there's no way to record that in-session verification result so the scorecard can trust it.

5. **The agent-builder skill doesn't describe the "already done" short-circuit path explicitly.** The card body said "If the pad is already flat dirt, mark this done" — which is smart and saved a lot of work. But the agent-builder skill (§6 completion criteria) only talks about `mc level`, `mc inspect` at corners, etc. It has no guidance for "examine first, decide if work is needed, short-circuit if so." Adding a pre-check flow to the builder skill would save future builders a speculative `mc level` or `mc fill` that might be unnecessary.

## Tooling Improvements

1. **Auto-inject MC_API_URL/MC_USERNAME per bot.** This is the #1 friction for every role. The dispatcher already has the bot assignment (the card's `bot:` field or the slug-to-bot mapping in the manifest). The spawn should export these vars so the worker never has to think about them. The scorecard's `role_env_has_no_mc_vars: true` is a standing bug.

2. **`mc terrain_top --batch` or `mc terrain_top --grid`.** A verb that accepts multiple `(x,z)` pairs — or a rectangle `(x1,z1)-(x2,z2)` — and returns all surface-y values in one response. For a 16x16 pad that's 5+ redundant calls for one piece of information ("is this flat?"). This would cut the builder's discovery phase from ~5 turns to ~1.

3. **`mc marks --loc <name>` for coordinate-only resolution.** The builder doesn't need to know what block is at the mark — they need to know *where the mark is*. A verb that returns `{name: "wheat_plot", position: [-50, 64, 50], standable: false, note: "water source"}` would be cleaner than parsing `mc inspect --mark` output and mentally subtracting the `water` noise.

4. **In-session `mc verify --plot x1,z1,x2,z2 --expect y=64`.** A self-contained verification primitive that the builder runs before completing, whose result gets embedded in the completion metadata. The scorecard could then read the builder's own verified-fresh result instead of trying to connect to a disconnected server instance.

## Bundle / Profile Issues

1. **Profile `.env` has no MC_ vars.** The `builder` profile under `~/.hermes/profiles/builder/` has no `MC_API_URL` or `MC_USERNAME` in its `.env`. Since the card is per-bot, the bot identity varies between runs, so the vars can't be hardcoded in the profile — they must come from the dispatcher's spawn env. The kanban dispatcher should read the card's `bot:` field and inject the corresponding vars from `data/bots/<bot>.yaml` into the worker process. The `single_bot_fixed_mox` injection mode proves env_passthrough works — we just need to plumb the right values.

2. **No `mc verify` verb for builder-side self-check.** The scorecard evaluates predicates externally and fails because it doesn't connect to the right bot. A builder-side verify verb that runs through the same bot's `mc` connection would produce reliable results, and the completion metadata could include `{pad_verified: true, verify_timestamp: ..., verify_surface_y_range: 64..64}`. Downstream (scorecard) could trust the builder's own verify rather than re-querying from a broken connection.

## Summary

The actual build work was trivial — the pad was already flat at Y=64, and the navigator's handoff metadata was excellent (exit_pos, survey_bounds, pad_corner, surface_y all present). The builder card completed in ~176s wall time per the telemetry. Friction is almost entirely in the bootstrap layer: missing env vars, no batch terrain-top verb, and no way to record in-session verification for the scorecard. Fix the env injection and add `mc terrain_top --batch`, and a build-pad card shrinks from 10+ discovery turns to 2-3.

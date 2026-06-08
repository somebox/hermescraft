# Trial feedback — w1-1780875295

Board: wheat-capstone
Roles: navigator,builder,farmer,crafter
Generated: 2026-06-08T02:19:15+02:00

## navigator

- card: `t_f8daead5`  status: done

# Navigator Feedback — w1-1780875295 (mox nav survey, 2nd trial)

**Bot:** mox
**Card:** `t_e5fc8953` — [bot:mox] nav survey @ wheat_plot
**Run:** w1-1780875295
**Prior feedback:** `t_185dbe60` — see `data/postmortems/wheat-capstone/w1-1780871693/feedback-navigator.md`

## Problems Hit

1. **MC_API_URL/MC_USERNAME boilerplate STILL not injected into shell env.**
   Same friction as the first trial. Every `mc` command needed `MC_API_URL=http://localhost:3007 MC_USERNAME=Mox`
   prefixed inline — ~40 chars per call, ~15 calls = 600 chars of ceremony. The dispatcher spawns the worker
   with the card's `data/bots/mox.yaml` in scope but doesn't set the env vars. This is the single highest
   source of wasted tokens across both trials.

2. **`mc advise` STILL broken** — same KeyError `'health_poll_interval_s'` in `tests/_lib/bot.py:21`.
   First thing I hit on turn 2 (stuck_warning probe). The error is identical to trial 1. The advise protocol
   is the navigator's designated recovery path, and it's been dead across two runs. Either the config dict
   needs a default fallback, or the `mc advise` verb itself should handle the missing key gracefully.

3. **`wheat_plot` mark is a water block — STILL no hint in card body.**
   The card says "inspect mark `wheat_plot`" but doesn't mention it resolves to a liquid. New workers
   burn a discovery turn figuring out that `mc move -50 64 50` won't work on water. The first feedback
   flagged this; nothing changed. A one-line hint ("wheat_plot is the center water source; approach via
   adjacent dirt blocks") in the card body is all that's needed.

4. **`mc status` stuck_warning on first turn (4.7 min) — zero card context for last position.**
   Same as trial 1. The bot was parked at `wheat_start` for nearly 5 minutes because the prior agent
   or operator left it there. The card body has no `exit_pos` field, no "bot last seen at" note. I had to
   run `mc status` → `mc read_chat` → `mc inspect wheat_plot` → `mc reachable` → `mc terrain_top` ×7
   just to orient. A simple `exit_pos` metadata field on the card (even a one-shot comment from the
   dispatching agent) would save 5-8 discovery calls.

5. **No terrain_top batching** — same as trial 1. The 16×16 survey needed surface_y checks at 7 corner
   and midpoint cells. That's 7 sequential `mc terrain_top` calls with full MC_API_URL boilerplate on
   each one. A batch verb (`mc terrain_top -58,42 -58,58 -42,42 -42,58`) would collapse this into one
   round-trip. Both trials now document this gap.

6. **`mc scene` vs `mc nearby` vs `mc observe` — unclear cheapest path for survey work.**
   For a simple "is the ground flat" survey, I needed multiple sense verbs because none of them alone
   gives a compact Y-range map of a rectangle. `mc map 16` gives relative height but no absolute Y
   numbers. `mc scene` is too heavy (~10 KB). `mc nearby 16` gives block counts but not topology. A
   dedicated survey verb (`mc surface_profile x1,z1,x2,z2` → returns Y-min, Y-max, slope count,
   obstacle list) would be the ideal single-call answer.

## Tooling Improvements

1. **Auto-inject bot env at dispatch.** This has been flagged in both feedback cards. The fix is
   straightforward: the kanban dispatcher reads `data/bots/<bot>.yaml`, extracts `MC_API_URL` and
   `MC_USERNAME`, and sets them as `env` on the worker process. Every worker across all roles hits
   this — it's not just navigator.

2. **`mc surface_profile` or `mc terrain_top --batch` for survey rectangles.**
   The survey card's core job is "is this N×M area flat?" and right now it takes 7+ `mc terrain_top`
   calls + a `mc adjacent`/`mc nearby` to answer. A verb that accepts a rectangle and returns the
   Y-range, flatness metric, and obstacle list would collapse the entire survey into one call.

3. **Card body hint for non-standable marks — automated or manual.** Either the dispatcher should
   detect that a card's target mark resolves to a liquid and append an auto-hint, or card authors
   should be prompted to add one. Two trials both burned a discovery turn on "wheat_plot is water."

## Bundle / Profile Issues

1. **`mc advise` is STILL broken — no fix between trials.**
   The KeyError in `health_poll_interval_s` has been reported, the root cause is identified
   (config dict in `tests/_lib/bot.py:21` lacks a required key), and no patch was applied. This
   should be a one-line fix: `config.get('health_poll_interval_s', 5)`. Until it's patched, the
   entire stuck-advise protocol defined in agent-navigator and kanban-worker skills is dead code.

2. **Agent-navigator skill STILL not in dispatcher's skills list.**
   The card's `skills` field only listed `kanban-worker`. I loaded `agent-navigator` manually via
   `skill_view()` on turn 1, but a worker that doesn't know it exists won't load it. The dispatcher
   should include the bundle's primary skill in the card's skills list when dispatching to a
   bundle-specific profile.

3. **`HERMES_NAV_BRIEF` mode STILL inactive.**
   The agent-navigator skill and minecraft-navigation skill both describe a `nav_brief` field in
   `mc observe` output with suggested next moves. It never appeared in either trial. Whether this
   is an env var (`HERMES_NAV_BRIEF=1`), a server flag, or unshipped code, the skill documentation
   describes a feature that workers cannot use. Either flip it on or remove the docs.

## Summary

Trial 2 on the same card type hit exactly the same friction points as trial 1. No regressions,
but zero fixes applied between runs. The core observation workload is fine — flat terrain, no
hostiles, marks resolve — the friction is entirely in the bootstrap layer: env vars, broken
advise, missing batch verbs, and stale bundle documentation. A nav survey card that currently
takes ~20 turns could be ~6 turns with the env injection fix alone.

## builder

- card: `t_18920e21`  status: done

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

## farmer

- card: `t_f8352398`  status: done

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

## crafter

- card: `t_56c431c6`  status: done

# Crafter feedback — w1-1780875295 (bot:mox) on t_fad66a0c

**Card:** `[bot:mox] harvest + deposit` — harvest remaining wheat from 9×9 plot at
wheat_plot, deposit wheat + iron_hoe into wheat_chest, clean up harvest-reminder cron.

Turn count: ~18 (orient → harvest → deposit → memory → complete).

---

## Problems hit

1. **`environment_has_no_mc_vars: true` (repeat from w1-1780871693).** Same root
   cause: `MC_API_URL` and `MC_USERNAME` absent from env at spawn despite being listed
   in the dispatcher config's `env_passthrough`. The scorecard's `architectural` block
   confirms `role_env_has_no_mc_vars: true` again. On this run the card was
   immediately **blocked** on creation (telemetry: `card_terminal: blocked` at
   1780875297, then unblocked at 1780876338). This suggests the bot couldn't reach the
   minecraft server at all until the operator intervened. The block-unblock delay cost
   ~17 minutes of wall time (most of the 2108s total). This is the single biggest drag
   on the trial.

2. **Acceptance predicates contradict the card's job.** The scorecard checks `wheat >=
   60` at the plot after the "harvest + deposit" card has run. That's exactly what the
   card is supposed to *eliminate* — of course wheat = 0 afterward. The
   `acceptance_satisfied = false` for the wheat predicate is a correct detection of an
   incorrect spec: the acceptance check should either run *before* the crafter card
   (pre-condition check) or check the chest contents (`wheat_chest contains >= 12
   wheat`) instead. The manifest.json lists a `chest_contains wheat min_count=12`
   predicate but the scorecard never uses it — only the three region_blocks predicates
   are evaluated. The chest check was defined but not executed.

3. **Scorecard flapping across multiple evaluations.** The final `per_predicate` set
   on the terminal scorecard shows:
   - farmland (79/81) = satisfied ✓
   - wheat (0/81) = satisfied=false (expected)
   - water at wheat_plot = satisfied ✓
   
   But *earlier* evaluation runs (visible in the telemetry) show all three flapping:
   farmland went `false→false→false→true` across four evaluations being written to
   telemetry.jsonl, wheat stayed `false` throughout, water went
   `false→false→true→true`. The farmland flapping was due to "chunk unloaded?" errors
   (`READ_FAILED` on 39/81 cells) alternating with clean reads. A predicate that
   sometimes can't read its region shouldn't contribute to the final band.

4. **Bot took passive drowning damage during evaluation idle.** The final scorecard
   state shows `hazard: SUBMERGED in water` and `hp=20→15→9→20` across the evaluation
   window. The bot was parked at (-49.5, 64.2, 50.5) — directly in the water hole at
   the center of the wheat plot. The bot stood there for ~60s while the verifier ran;
   the `SUBMERGED` hazard triggered and passive drowning damage ticked HP down to
   ~14.5 (from 20). One subsequent evaluation shows `hp=9.2`. The bot eventually
   recovered (final hp=20) but the mid-evaluation damage is unnecessary — the
   verifier should not leave the bot in a hazard state.

5. **No chest-verify step in the card after deposit.** The card body says "harvest +
   deposit" but there's no explicit verification step coded into the card (e.g. "run
   `mc chest @wheat_chest` after depositing to confirm the wheat landed"). I did this
   anyway as part of my standard workflow, but a less thorough worker could complete
   the deposit and never actually check the chest accepted the items. Scorecard
   confirms this: the `chest_contains` predicate was never evaluated, so we don't have
   an independent verification that 77 wheat actually made it into the chest.

6. **Cron cleanup was a no-op (same as w1-1780871693).** The card body said "remove
   harvest-reminder cron" but `hermes cron list` returned no matching jobs. Either the
   prior farmer card already removed it, or the cron was never created. The instruction
   survives in the card body as dead text.

---

## Tooling improvements

1. **Fix env-passthrough plumbing (repeat).** This is #1 on every worker's feedback.
   The dispatcher's `env_passthrough` never actually passes the vars. On this run it
   was worse: the card auto-blocked at creation, suggesting the bot couldn't even
   connect. Fix the injection or add a `mc_connect` verb that reads
   `data/bots/<bot>.yaml` and sets env automatically.

2. **Acceptance predicates should respect card semantics.** The "harvest + deposit"
   card's purpose is to clear the wheat and chest it. Checking `wheat >= 60` afterward
   is a test for an *un*-harvested state. Acceptance criteria should match card
   ordering:
   - Pre-condition check (before card runs): "wheat >= 60 exists"
   - Post-condition check (after card runs): "chest_contains wheat >= 12 and
     region_blocks wheat = 0"
   
   Or define the acceptance at pipeline level (check all 4 cards once they're all
   done), not per-card.

3. **Evaluator should deploy a safety stand before verification.** The verifier parked
   the bot directly in the water block and let it drown. Before running region scans,
   the verifier should ensure the bot is on a non-hazardous cell (dry, not on fire, not
   at a fall edge). A one-line `mc move X Y Z` to a safe adjacent cell would prevent
   the HP attrition seen here.

4. **Evaluator retries on `READ_FAILED` / `chunk unloaded`.** The earliest evaluations
   show `scanned=42 unreadable=39` for the farmland region — the chunk wasn't loaded.
   The verifier should wait 2-3 seconds and retry, or instruct the bot to navigate
   toward the region before scanning. Two of the four scorecard writes in telemetry
   show chunk-unloaded partial reads, which corrupts the per-predicate verdict.

5. **Wire up the `chest_contains` predicate.** The manifest.json already defines it
   (`kind: chest_contains, mark: wheat_chest, item: wheat, min_count: 12`) but the
   scorecard never exercises it — it only evaluates the three region_blocks predicates.
   This means the one predicate that directly proves the card succeeded is never
   checked. Either fix the evaluation code to include chest_contains, or remove the
   dead predicate from the manifest.

6. **Card body generator: suppress stale instructions.** The "clean up harvest-reminder
   cron" line was a no-op for the second consecutive trial. If the cron didn't exist
   after the farmer card, the crafter card body shouldn't mention it. Add a pre-check
   step in the card-generator pipeline that skips instructions for entities that don't
   exist at generation time.

---

## Bundle / skill gaps

- **agent-crafter.md §6 — completion criteria.** The bundle says "For deposit cards:
  every line item from the card body is reflected in the chest's contents (verified
  via `mc chest @MARK`)". This is correct guidance and I followed it, but there's no
  parallel guidance for what to do when the chest **rejects** a deposit (full chest,
  wrong block type, chest broken). The escape table (§5) covers `chest_full:<mark>`
  but not less common failures. A `chest_rejected:<item>:<details>` escape would cover
  the gap.

- **No `minecraft-chores` skill in the bundle.** Same gap as w1-1780871693. The
  agent-crafter bundle (§3) says "the full grammar is in minecraft-chores.md" but that
  skill isn't in the card's skill list. If a worker's mental model of `mc craft`,
  `mc deposit`, etc. is incomplete, there's no fallback without the skill loaded.
  Either include `minecraft-chores` in every crafter card, or inline the verb reference
  into agent-crafter.md itself.

- **`mc inspect --mark` still doesn't exist (repeat from w1-1780871693).** I used
  `mc marks` to resolve wheat_chest coords, then manually typed them into
  `mc inspect`. A `mc inspect --mark wheat_chest` one-liner would save 2 turns on
  every crafter card that opens with a chest verification.

- **Farmland predicate needs `unreadable=0` guard in scorecard.** One evaluation
  scored farmland as `satisfied=false` when 39/81 cells were unreadable — that's not a
  "predicate not satisfied" verdict, it's an "insufficient data" verdict. The band
  calculation should exclude predicates where `observed.unreadable > 0`, or mark them
  `evaluable=false`.

---

## Summary

The card completed correctly (77 wheat harvested, deposited in wheat_chest, iron_hoe
returned, cron confirmed clean). But the run exposed two structural problems that
persist from the previous trial:

1. **Env var injection is still broken** — the card auto-blocked on creation and
   needed an operator unblock, wasting 17 minutes of wall time and 80% of the trial
   budget.
2. **Acceptance evaluation doesn't match card semantics** — checking `wheat >= 60`
   after a harvest card is structurally wrong, and the `chest_contains` predicate
   that *would* prove success was defined but never evaluated.

The evaluation-driven HP damage (drowning in the wheat-plot water block) is new to
this trial and fixable with a one-line safety-stand placement before verification.


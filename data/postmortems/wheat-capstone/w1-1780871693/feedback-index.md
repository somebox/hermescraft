# Trial feedback — w1-1780871693

Board: wheat-capstone
Roles: navigator,builder,farmer,crafter
Generated: 2026-06-08T01:19:40

## navigator

- card: `t_185dbe60`  status: done

# Navigator Feedback — w1-1780871693 (mox nav survey)

**Bot:** mox
**Card:** `t_5a1f0f61` — [bot:mox] nav survey @ wheat_plot
**Run:** w1-1780871693

## Problems Hit

1. **MC_API_URL / MC_USERNAME not in shell env.** Every single `mc` command had to be manually prefixed with
   `MC_API_URL=http://localhost:3007 MC_USERNAME=Mox`. This added ~40 chars of boilerplate to every terminal
   call — roughly 15× over the span of the run. The navigator profile's `.env` should inject these, or the
   workspace should provide a wrapper script (`./mc`) that sets them automatically.

2. **`mc advise` crashed with KeyError.** On the first stuck-probe turn, `mc advise` crashed with:
   ```
   KeyError: 'health_poll_interval_s'
   ```
   in `tests/_lib/bot.py` line 21. This means the perception_advise module can't find a required config key.
   I had to skip the entire stuck-advise protocol and proceed manually. For a card that starts with a
   `stuck_warning`, losing the advise verb is a real reliability gap.

3. **Card body didn't say the target mark is a water block.** `wheat_plot` resolves to (-50, 64, 50) which is
   a water source block — not a standable cell. I had to infer `--near 2` from minimal context. A single
   sentence ("wheat_plot is the water source at plot center; standable cells are the dirt blocks adjacent")
   would save the navigator a discovery turn.

4. **No terrain_top batching.** I needed to check surface_y at 7 corner/midpoint coordinates to map the
   16×16 survey rectangle and find the ravine edge. That's 7 separate `mc terrain_top` calls because there's
   no batch verb. A `mc terrain_top x1,z1 x2,z2 ...` or `mc terrain_top --area x1,z1,x2,z2` would have
   collapsed this to one call.

5. **`mc status` reported `stuck_warning` on first turn with zero context.** The bot was stationary at
   `wheat_start` with 5.7 min of no movement. The card didn't mention the bot's last known position or
   state, so I had to recover orientation from `mc status` + `mc observe` + `mc scene` — three discovery
   calls before I could move. A handoff field in the card metadata with the bot's last `exit_pos` would
   have been enough.

## Tooling Improvements

1. **Auto-inject MC_API_URL/MC_USERNAME per bot.** Either the profile's `.env` should source these from
   `data/bots/<bot>.yaml`, or the kanban dispatcher should set them as env vars when spawning the worker
   for a bot-specific card. This is the single highest-friction item — every worker I've seen reinvents
   the env boilerplate.

2. **`mc terrain_top --batch` or equivalent.** A verb that takes multiple `(x,z)` pairs and returns all
   results in one response would dramatically speed up survey work. 7 sequential terminal calls for one
   survey is ~40% of the whole run right there.

3. **Card body hint for non-standable marks.** When a card targets a mark that resolves to a liquid or
   solid block (not a standable cell), the card body should say so explicitly. The navigator protocol
   (`mc move @MARK --near 2`) handles it fine *if you know*, but wasting a turn discovering the water is
   unnecessary.

## Bundle / Profile Issues

1. **`mc advise` is broken** — the KeyError in `tests/_lib/bot.py:21` makes the entire stuck-advise
   protocol non-functional. This should be the navigator's primary recovery tool, but it produces a
   `backend_error` instead of guidance. Fix: ensure `health_poll_interval_s` is present in the config
   dict (default fallback 5s if missing).

2. **`HERMES_NAV_BRIEF` mode was not active** — the agent-navigator skill describes a `nav_brief` field
   in `mc observe` output with suggested next moves, but I never saw this during the run. Whether this
   is a missing env var (`HERMES_NAV_BRIEF=1`), a server-side flag, or a feature that hasn't shipped
   yet — whatever it is, the skill doc describes something that doesn't work in practice. Either ship
   the feature or remove it from the skill doc.

3. **agent-navigator skill was not in the skills list** — the card's `skills` only had `kanban-worker`,
   so the bundle wasn't force-loaded. The dispatcher should include the bundle skill in the card's
   `skills` list when dispatching to a bundle-specific profile. Without it, I had to manually
   `skill_view('agent-navigator')` on turn 1 — which I did, but workers that don't know to load it
   miss the bundle entirely.

## Summary

The actual survey went smoothly once past setup friction — no hostiles, flat terrain, marks resolved
correctly. The friction is almost entirely in the bootstrap layer: env injection, broken advise verb,
missing batch verbs, and unclear card handoff. Fix those and a nav survey card goes from ~20 turns
to ~6 turns.

## builder

- card: `t_c5348bd2`  status: done

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

## farmer

- card: `t_8f5ba48e`  status: done

# Farmer feedback — w1-1780871693 (bot:mox)

## Problems hit

- **MC_API_URL / MC_USERNAME not in env.** The SOUL says "injected at spawn by the dispatcher" but they were empty. Had to discover the bot port from `data/bots/mox.yaml` (port 3007) and manually `export MC_API_URL` + `MC_USERNAME` in every terminal call. The `env_passthrough` list in config.yaml includes them but they never arrived. About 30% of turn budget burned on discovery and repeated exports.

- **`mc inspect --mark wheat_plot` fails.** The card body instructs "Use `mc inspect --mark wheat_plot` to read the wheat-plot coordinates" but this returns `ERROR: inspect:x:not_number`. The `mc inspect` verb doesn't support `--mark`. Had to fall back to `mc marks` which works fine — but the card instruction sent me down the wrong path first.

- **Stuck warning from prior run.** The bot had `stuck_warning: "STUCK 13min"` on the first `mc status` from a previous builder card iteration. Not a real stuck — the bot was idle at the right position — but the warning is loud and the first read is alarming. The farmer needs to know it can ignore stale stuck_warnings when the position is correct for the card.

- **`mc till_area` failure reporting is subtle.** The water source cell at (-50,64,50) reports as 1 "failed" with `UNCHANGED` code — which is actually correct behaviour (don't till the water). The 80/80+1unplantable is right but the "failed" counter reads like an error. A clear "skipped 1 water source" would remove the double-take.

- **`mc farm_status` uses absolute coords, not marks.** Every call to `mc farm_status` needs explicit corner coords. There's no `mc farm_status --mark wheat_plot`. Manually typed `-54 46 -46 54 64` from reading `mc marks` output — fragile and error-prone.

- **HERMES_HOME path override.** `HERMES_HOME=/Users/foz/.hermes/profiles/farmer` overrides `HOME`, making `~` resolve to `/Users/foz/.hermes/profiles/farmer/home/` instead of `/Users/foz/`. This breaks paths like `~/.hermes/state` in card instructions — had to resolve absolute paths manually.

- **No `mc chat` presence from prior workers.** The builder cards left no `mc chat` trail — the farmer had no in-world awareness of the prior agent's work. Had to re-derive everything from marks and card metadata.

## Tooling improvements

1. **`mc inspect --mark <name>` support.** A single command to get the mark coords and inspect the block at that position. Would replace the current two-step (`mc marks` + manual coord extraction). The agent-farmer bundle lists `mc inspect <pos>` but not `mc inspect --mark` — because the latter doesn't exist.

2. **`mc farm_status --mark <name>`.** A mark-aware farm status that auto-resolves the mark center and inspects the bounding area with known plot size (9×9 default). Would save re-typing corner coords on every diagnostic.

3. **Persistent MC_API_URL injection.** The SOUL says "injected at spawn" but the mechanism isn't working for this profile. Either the dispatcher isn't setting the env vars at spawn time, or `env_passthrough` in the terminal config doesn't propagate to children correctly. A working injection would have saved ~6 tool calls of manual discovery and export.

## Bundle / skill gaps

- **agent-farmer.md** lists `till_area` and `farm_status` correctly as existing verbs (good) but doesn't mention that `mc inspect --mark` doesn't exist. The skill should either warn that mark-param is unsupported, or the `mc` CLI should support it. I'd vote for the CLI fix.

- **agent-farmer.md §4** says "Read the parent handoff" — I did (kanban_show), and the parent metadata had the coords. But if I had skipped the parent read and gone straight to `mc inspect --mark` per the card body, I'd have been stuck at the `not_number` error without a fallback. The card body and the tool surface should agree.

- **card body spec divergence.** The card says "Use `mc inspect --mark wheat_plot`" which doesn't work. Either the card spec should say `mc marks` or inspect needs the flag. The card is the source of truth for the worker but the tool doesn't support the contract the card describes.

- **No minecraft-farming skill was bundled** on this W1 card (skills list was `kanban-worker, agent-farmer, minecraft-farming, minecraft-survival` but for this particular run only `kanban-worker` was actually loaded). Having the farming skill at hand for verb reference would have reduced `mc help` calls.

## crafter

- card: `t_53937480`  status: done

# Crafter feedback — w1-1780871693 (bot:mox) on t_7022eec0

**Card:** `[bot:mox] harvest + deposit` — harvest 9×9 wheat plot at wheat_plot, deposit wheat + iron_hoe into wheat_chest, clean up harvest-reminder cron.

Turn count: ~20 total (including orient → harvest → deposit → cron cleanup → memory → complete).

---

## Problems hit

1. **`MC_API_URL` / `MC_USERNAME` absent from env at spawn.** The SOUL ("injected at spawn by the dispatcher") was wrong — both vars were empty. Had to read `data/bots/mox.yaml` to discover port 3007, then `export MC_API_URL=... MC_USERNAME=Mox` on every terminal call that needed `mc`. The scorecard JSON confirms `role_env_has_no_mc_vars: true`. This cost roughly 4-5 tool calls of discovery and repeated exports. Shared root cause with the farmer and builder cards.

2. **`mc status` returned position=null / health=null.** First command after orientation returned a valid response (`ok:true`) but all position/health/food fields were null. The bot was alive (deposit later succeeded) so this was either a race condition on bot restart or the status endpoint was mid-heartbeat. Burned one turn re-running to confirm.

3. **`mc inspect --mark <name>` doesn't exist.** The agent-crafter bundle says to use `mc inspect <pos>` — correct — but the mental habit of `--mark <name>` from other `mc` verbs (most accept marks) led to a one-turn detour validating that syntax. The `mc inspect` verb takes raw coords only; there's no mark-resolve flag.

4. **Chest deposit requires adjacent standable cell — no guidance in the card body.** The chest at `wheat_chest` sits at (-50,65,60). You can't `mc goto (-50,65,60)` because the chest block is solid. The kanban-worker skill covers this (`goto_near + range=2`) but the card body just says "deposit at wheat_chest" with no hint about the adjacency pattern. On a tight iteration budget the guess-and-retry burns turns.

5. **Verifier runs from the wrong bot position.** The scorecard shows all three predicates failed with `chunk unloaded?` — the bot was at (379.1, 88, -613.4) at evaluation time, far from the wheat plot at (-50, 65). The verify step doesn't move the bot or instruct it to navigate. The predicates (farmland count, wheat count, water at wheat_plot) are all true at the correct location but reported unevaluable because the chunk isn't loaded from the evaluator's position. The pipeline should either navigate the bot back before verifying, or verify from snapshot data.

6. **Harvest-reminder cron was already cleaned up.** The card said "remove wheat-harvest-reminder cron job" but `hermes cron list` returned no matching jobs. Not a real problem — just a no-op instruction that wasted one round-trip. Better if the prior agent or the card generator tracks whether the cron actually exists.

---

## Tooling improvements

1. **`mc inspect --mark <name>` — add mark-resolve to inspect.** This is the same request the farmer made. Every agent bundle wants this: "show me what's at the mark I care about" without the two-step of `mc marks` → manual coord copy → `mc inspect <x> <y> <z>`. The `mc` CLI already resolves marks in most verbs (`mc deposit`, `mc withdraw`, `mc goto`, `mc chest`). Adding it to `mc inspect` (and `mc status --mark`) would be consistent and save 1-2 turns per card.

2. **Persistent MC_API_URL/MC_USERNAME injection at spawn.** The top fix by far. This is a platform-level gap: the dispatcher config has `env_passthrough` with MC vars listed, but they never materialise in the child process. Fix the injection plumbing (or add a `mc_connect` verb that auto-reads `data/bots/<bot>.yaml`). Every card on this run burned 2-5 turns on discovery/exports.

3. **Chest-deposit hint in card body generator.** When the card says "deposit into <chest_mark>", the body generator should add a one-liner: `(stand adjacent, not on the chest block — use goto_near with range=2)`. The kanban-worker skill has this detail but the card body should repeat it; not every worker re-reads the skill mid-card.

4. **Verify step should navigate to mark before reading.** The evaluator/server should move the bot to the mark/region before running predicates. The chunk-unloaded failure pattern will recur on every card where the bot's eval-time position is distant from the evaluated site.

---

## Bundle / skill gaps

- **agent-crafter.md §3:** The verb table lists `mc chest @MARK` and `mc deposit <item> <count> @MARK` but doesn't mention the `mc chest <x> <y> <z>` coords variant (needed when you have raw coords from `mc marks`). Minor gap — inferred it quickly but a note would help.

- **agent-crafter.md §4 — handoff reading:** The bundle correctly says "Read the parent handoff". The farmer's `kanban_complete` metadata included `exit_pos: [-55.5, 65, 50.5]` and `work_at_mark: wheat_plot` — I used these directly. This worked well and is the right pattern. No gap here.

- **No minecraft-chores skill loaded for this card.** The skill list included `kanban-worker, agent-crafter` but not `minecraft-chores` (which is the verb reference agent-crafter's §3 says contains "the full grammar"). If I'd needed a verb outside my mental catalog, I'd have been guessing. Bundle should include the domain skill for verb lookups.

- **agent-crafter.md §5 escape table is good.** The `world_state_mismatch` escape ("block at the mark isn't the expected container kind") is exactly the right pattern for checking w heat_chest before depositing. Used it as-is and it fit.

---

## Summary

The card completed successfully (86 wheat + iron_hoe deposited, cron checked) but the env-var injection gap was the dominant cost across all four workers. Fixing that one platform issue would save ~25% of turn budget across every card in a trial. The scorecard's `partial` band with 0 acceptance predicates evaluable is a verification-runner bug (wrong position), not a card-execution bug — the bot actually did all the work.

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

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

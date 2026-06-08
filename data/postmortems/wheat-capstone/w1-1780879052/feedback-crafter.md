# Crafter feedback — w1-1780879052 (bot:mox) on t_fec054b2

**Card:** `[bot:mox] harvest + deposit` — harvest 9×9 wheat plot at
wheat_plot, deposit into wheat_chest, clean up reminder cron.

Turn count: ~14 (orient → harvest (2 batches) → deposit → cron check → complete).

---

## Problems hit

1. **`mc inspect --mark` still doesn't work (repeat from w1-1780875295).** The
   card body says `Use mc inspect --mark wheat_plot` and `mc inspect --mark
   wheat_chest`. Both fail with `ERROR [inspect] : mc inspect requires numeric
   x, y, z`. The `--mark` flag is not a verb suffix that `inspect` accepts,
   despite being documented in the card body for the third consecutive trial.
   Workaround: call `mc marks` to resolve coords, then pass numeric x y z.
   This costs 2 extra turns per card.

2. **Card body still suggests the broken `--mark` syntax (repeat).** This is
   the exact same stale instruction that appeared in w1-1780875295 and
   w1-1780871693 feedback. The card generator re-uses the same template
   regardless of whether its native verbs actually exist. A template-level
   pre-flight check (or just switching to `mc marks` in the template) would
   fix this once across all cards.

3. **Bot started confined/underground at the plot edge.** The initial `mc
   status` showed `stuck_minutes=3.3`, `situation=Head-level block is blocking
   movement`, `nav_mode=confined` with 0 exits and density 0.81. The previous
   card (farmer/planter) left the bot in a 1-block-deep hollow at the SE edge
   of the wheat plot with a farmland block at head level. The crafter had to
   work around the stuck state before it could harvest. A handoff convention
   requiring the previous card to leave the bot on a clear, standable surface
   (or at a named `:craft_start:` mark) would prevent this.

4. **`mc collect wheat 80` rejected — per-invocation cap of 64.** The 9×9 plot
   has 80 farmland cells (79 wheat + 1 water). The card body suggests `mc
   collect wheat 80` but the CLI enforces a max of 64 per call. Workaround:
   split into `mc collect wheat 64` + `mc collect wheat 20`. A `mc collect`
   that auto-batches to the requested count, or a `mc harvest_area` verb for
   bounded rectangles, would save the round-trip.

5. **`mc move` to chest failed — chest cell is unstandable.** The pathfinder
   rejected `mc move -50 65 60` with `NAV_BLOCKED: target not standable`
   because the chest block is at that coordinate. Required `mc goto_near -51
   65 60 range=2` to reach an adjacent standable cell. The card body could
   note this: "deposit from an adjacent cell, not the chest's own coords" or
   give a `goto_near` hint.

6. **Cron cleanup was a no-op (repeat from w1-1780875295, w1-1780871693).**
   `cronjob list` returned zero jobs — the one-shot wheat-harvest-reminder
   cron had already auto-removed after firing. The state file was also
   already cleaned. This instruction survives in the card body as dead text
   for the third consecutive trial. The card generator should skip this step
   when the cron is a one-shot (it self-deletes) or check existence before
   generating the instruction.

---

## Tooling improvements

1. **Add `mc inspect --mark <name>` as a real verb, or kill the docs.** This
   is the #1 friction point on crafter cards. Every card body references it,
   and every crafter has to work around it. The `mc inspect` parser needs to
   accept a `--mark` flag that resolves a named mark to its coordinates
   before inspecting. Or: change the card template to `mc marks` + `mc
   inspect X Y Z` which is what actually works.

2. **`mc collect` should auto-batch past the 64 cap.** When the user asks for
   80 wheat, the CLI already knows the cap is 64. It could split the request
   into two internal collect calls and batch the results. Or add a
   `mc harvest_area X1 Z1 X2 Z2 [Y]` verb that harvests a bounded rectangle
   without the per-count cap, since the `harvest` verb already exists for
   farming contexts.

3. **Handoff convention for exit position.** The farner card should guarantee
   the bot is left on a standable, unobstructed cell (not in a 1-deep hollow
   with a head-level block). A `exit_pos_clear: true` flag in kanban_complete
   metadata that the next card can check before starting work. The crafter
   currently wastes 2-3 turns on "oh the bot is stuck" recovery.

---

## Bundle / skill gaps

- **agent-crafter.md §3 — verb table lists `mc inspect <pos>` but not
  `mc marks`.** The crafter bundle's verb table shows `mc inspect` with
  `<pos>` but doesn't show `mc marks` as a resolution step. Since
  `mc inspect --mark` doesn't work, the recommended turn-1 sequence should
  be: `mc marks` → `mc inspect X Y Z`. Add a row for `mc marks` in the
  verb table.

- **No guidance for split-batch collect.** The bundle says "For deposit cards:
  every line item from the card body is reflected in the chest's contents".
  For harvest cards, there's no parallel guidance on the `collect` cap of 64.
  A note in the card body template or the crafter bundle's harvest section
  ("split harvests >64 into multiple `mc collect` calls") would save every
  crafter on every harvest card from the first-try rejection.

- **`minecraft-chores` still not consistently loaded across crafter cards.**
  The t_fec054b2 card's skill list includes `minecraft-chores` and
  `minecraft-survival` (visible in its `created` event skills array), so
  this card was better provisioned than some earlier ones. But the `agent-crafter`
  bundle §3 still says "the full grammar is in minecraft-chores.md" as if
  reading a fallback. If the card generator already includes it (good!), the
  bundle reference is redundant but harmless.

---

## Summary

The card completed correctly (79/79 wheat harvested, 40 wheat deposited in
wheat_chest, cron confirmed auto-cleaned). Turn count was ~14 — reasonable.

Compared to the previous trial (w1-1780875295), this run was smoother:
- No env-var block at spawn time (the card was created `blocked` but only
  for ~8 minutes, not the 17 of last time)
- No drowning hazard from the evaluator
- Same number of harvest batches (2) due to the 64-cap

Four problems persist across all three trials:
1. `mc inspect --mark` doesn't work despite every card body referencing it
2. The cron cleanup instruction is dead text for one-shot crons
3. `mc collect` cap of 64 forces an extra round-trip on 9×9 plots
4. Previous card leaves the bot in a confined/stuck position

Items 1 and 4 are the highest-impact fixes for trial throughput.
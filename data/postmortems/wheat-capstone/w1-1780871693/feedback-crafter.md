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

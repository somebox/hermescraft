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

# Builder Feedback — w1-1780879052 (mox build pad)

**Bot:** mox
**Card:** `t_8ad434c8` — [bot:mox] build pad @ wheat_plot
**Run:** w1-1780879052
**Previous:** w1-1780875295 (t_aeaa28e8), w1-1780871693 (t_374f32d6)

## Problems Hit

1. **Scorecard evaluation ran 5 times before passing.** The telemetry shows 5 successive `evaluate_started` / `scorecard` entries (at 1780879752, 1780879805, 1780879867, 1780879951, 1780879966) covering ~914s wall time. The first two failed with `acceptance_evaluable: false` — the verify bot was at (-48.5,64.9,50.5) and then (3.7,65,5.4), both >9 blocks from `wheat_chest`. The third and fourth attempts had the bot correctly positioned at (-49.5,65,59.5) and could read the chest (40 wheat) but the `min_count` was still set to 60, so `satisfied: false`. The fifth attempt passed because `min_count` was relaxed to 30. The scorecard cannot converge without either (a) navigating the verify bot to the chest, or (b) starting with realistic thresholds. Five re-evaluations for a single run is not sustainable.

2. **Scorecard verify bot position drift between attempts.** The verify bot's position jumped between evals: (-48.5,64.9,50.5) → (3.7,65,5.4) → (-49.5,65,59.5). This means the verify pipeline isn't pinning a session — each eval may connect to whatever the bot's current position is, or the bot is moving in-world between checks. The scorecard should either `mc move @wheat_chest` before the chest check, or the verifier should start from a known location.

3. **Env var injection is fixed but fragile.** This run had `role_env_has_mc_vars: true` for the first time — a real improvement over w1-1780871693/1780875295 where every `mc` command needed manual prefixing. However, the `injection_ceiling_note` in the scorecard is honest: "MC_* routed via role .env because Hermes spawn strips them (kanban_db.py:6671); not per-card bot lookup (W4)." This means the fix is hardcoded to the mox bot in the builder profile's .env — it won't work for multi-bot cards or different bot assignments without a separate .env per profile.

4. **The wheat threshold (60→30) suggests a predicate design issue.** The original card expected `min_count: 60` wheat in `wheat_chest`, but the farmer could only deliver 40 within the run window. The threshold was adjusted to 30 to make the run pass. This is correct in that it lets a successful pipeline complete, but it reveals that the initial predicate didn't account for the farmer's realistic throughput. Either the farmer card should have a higher output target, or the predicate should be set from expected output, not aspirational.

5. **Builder turn-1 still has no batch terrain-top verb.** This is the third consecutive feedback raising `mc terrain_top --batch` (or `mc terrain_top --grid`). The builder short-circuited because the pad was already flat, so the 5-call terrain_top sequence was avoidable. But the next builder on a non-flat pad will still pay 5+ calls just to answer "what Y is the surface at these four corners?" This is the single highest-turn-cost friction for pad cards.

## Tooling Improvements

1. **Scorecard verifier should self-navigate.** The `chest_contains` predicate failed twice because the verify bot was far from `wheat_chest`. The verify runner has the mark name — it should run `mc move @wheat_chest` (or `mc goto_near <mark_coords> 2`) before checking, instead of returning `NOT_ADJACENT`. This would save 2-3 evaluation passes per run.

2. **Per-bot env injection from the card body, not the role .env.** The dispatcher should read `bot:` from the card title/body and inject the corresponding vars from `data/bots/<bot>.yaml` into the worker process at spawn time, rather than relying on each profile's `.env` being manually updated. This is W4 (or W3.5) architecture, but it's the only fix that scales past single-bot runs.

3. **`mc terrain_top --batch x1,z1 x2,z2 [x3,z3 ...]`** — Repeating this from every previous feedback. A verb that accepts the four corners of a rectangle and returns `{y, block_type}` for each in one call. For pad-leveling cards this would cut the discovery phase from 5 turns to 1.

## Bundle / Profile Issues

1. **Scorecard predicate thresholds need a reality baseline.** The 60-wheat threshold went through three scorecard iterations before being relaxed to 30. The scorecard's own telemetry could compute a data-driven threshold from prior runs: "last 3 runs yielded 35-45 wheat; setting threshold to 30 gives 95% pass rate." Without this, every subsequent run with the old 60-wheat predicate will fail the same way.

2. **Hermes spawn strips env vars (kanban_db.py:6671).** The `injection_ceiling_note` in the scorecard is a standing architectural debt. The builder profile now works around it via a role-level `.env`, but this doesn't compose. If a future card assigns the builder to a different bot (e.g. "flint" instead of "mox"), the .env hardcodes won't match. The fix belongs in `kanban_db.py`'s spawn path — not in each profile's `.env`.

3. **No procedural escalation for scorecard re-evaluations.** The 5-eval cycle consumed ~900s of wall time. The scorecard pipeline has no upper bound on retries or a "give up after N non-terminal" threshold. Adding a `max_eval_attempts` (e.g. 3) and a deterministic failure mode would prevent the cycle from running unbounded.

## Summary

This run achieved a **pass** band — a first for this pipeline — thanks to three key fixes since w1-1780871693: (1) env vars are now available via the profile `.env`, (2) the builder short-circuited cleanly because the pad was already flat, and (3) the wheat threshold was relaxed to 30. The builder card itself completed in 25s with no friction. The remaining pain is all in the scorecard evaluation layer: bot position drift between evals, `NOT_ADJACENT` failures on chest checks, and predicate thresholds that don't match real output. Fix the scorecard verifier to self-navigate and set thresholds from actual run data, and the pipeline converges in 1-2 passes instead of 5.

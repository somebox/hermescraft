# Genesis P1 completion experiment — 4-run postmortem

**Dates:** 2026-05-27 → 2026-05-28 (single session, ~6 hours)
**Goal:** Get one clean Phase-1 completion (5 cards → P1 EPIC done → P2 promoted)
to validate the architectural fixes shipped earlier this session.
**Outcome:** P1 reached 4 of 6 cards complete in `g-2026-05-28-3` (deepest of the
series); operator hand-executed the remaining 3 orch-parked cards to confirm
P2 auto-promotes. Each run surfaced exactly one bug and the next fix routed
around it cleanly — the "exit value" was a regression test suite, not a
finished run.

## The 4 runs

| Run | Seed/anchor | What broke | Fix (commit) | Test that would catch it |
|---|---|---|---|---|
| `g-2026-05-27-10` | -1312...79 / (258,64,63) | Steward filed `[SCOUT]` with `--parent <P2_epic>`; the SCOUT stayed `todo` forever because the epic stayed `ready`. Dispatcher idled 40+ min. | `497ea27` — `scripts/kanban` facade splits into `--epic` (body trailer) and `--depends-on` (real task_links). `--parent` not exposed by facade. | `test_facade_create_does_not_accept_parent_flag` |
| `g-2026-05-28-1` | -1312...79 / (258,64,63) | `seed_base_pad` filled 0/81 cells but logged "partial" warning. Workers walked into a world with no pad. Mason blocked correctly on system_chest_empty (the new shelter card body did its job). | `96fd826` — chunk-readiness poll with 1×1 probe; hard-fail on 0/N filled. | `test_seed_base_pad_zero_cells_raises` |
| `g-2026-05-28-2` | -1312...79 / (258,64,63) | `seed_system_chest_fill` reported ok (33 deposits each ok:true) but chest was empty. Then on rerun: chest filled but no cobble in manifest. | `0c3694c` — post-fill `list_container` verify, exit 3 if stacks=0. `1131cc6` — add cobblestone to DEFAULT_MANIFEST. | `test_system_chest_fill_has_post_verify` + `test_system_chest_manifest_includes_cobblestone` |
| `g-2026-05-28-3` | -1312...79 / (258,64,63) | 4 of 6 P1 done in 21 min — anchor confirm, survey (NEW card from Tier 1, produced 4 lt_* marks), shelter (P1 system_chest exception worked), chests. Stalled on Steward orch-complete doctrine gap — she tried `hermes kanban claim` on her own ready cards, got "active profile is default", burned 2 rounds investigating. Operator hand-executed RECONCILE + SITE + P1 EPIC. P2 promoted automatically. | Steward SOUL — new "Completing your own orch-parked cards — no claim, direct complete" section. | (not unit-testable; doctrine-only) |

## Architectural wins this series confirmed

1. **`--epic` vs `--depends-on` split — zero wedges from epic-as-parent.** All four runs after the facade landed used the body-trailer mechanism; no card got stuck in `todo` waiting on an orchestrator-continuous epic. `scripts/kanban list-epics` correctly enumerates members via trailer scan.

2. **Genesis hard-fails on broken setup.** Before this series, `seed_base_pad` and `system_chest_fill` could silently report success and leave the world in an unusable state. Now both hard-raise before bots start.

3. **Phase chain via depends-on works.** When P1 EPIC was completed in g-2026-05-28-3, P2 auto-promoted from `todo` to `ready` on the next dispatcher tick. The pattern P1 → P2 → P3 → P4 is reliable.

4. **Tier 1 card-body changes are load-bearing.**
   - The new `[SCOUT] Survey resources` card produced 4 `lt_*` marks in 13 min — exactly the input P2 needs. Without it Mason improvised pillar-mining in -10 and got entombed.
   - The shelter card's `system_chest` cobble exception worked end-to-end once the manifest had cobble.
   - The water-doctrine + slab-ban guardrails didn't fire (no water adjacent to base, no slabs improvised), so they're untested in production but cheap to keep.

## Failure modes that are now regression-tested

`scripts/tests/test_genesis_failure_modes.py` — 7 tests, run with the rest of the suite via `uv run --with pytest --with pyyaml python -m pytest scripts/tests/ -q`:

| Test | Catches |
|---|---|
| `test_seed_base_pad_zero_cells_raises` | g-2026-05-28-1 silent zero-fill |
| `test_seed_base_pad_partial_fill_logs_warn` | partial fill (e.g. 80/81) must still be tolerated; not over-fixed |
| `test_system_chest_fill_has_post_verify` | regression if anyone removes the chest verify block |
| `test_system_chest_manifest_includes_cobblestone` | g-2026-05-28-2 missing-cobble in manifest |
| `test_facade_create_does_not_accept_parent_flag` | g-2026-05-27-10 wedge-class re-introduction |
| `test_facade_create_with_epic_does_not_call_link` | --epic must NEVER write to task_links |
| `test_facade_substring_safety_regression` | `_scan_epic_children` substring confusion |

Plus the existing 30 tests in `scripts/tests/` (`test_genesis_lib.py`, `test_templates.py`, `test_genesis_snapshot.py`, `test_kanban_facade.py`).

## What's still NOT unit-testable

These need integration tests (real MC server + real LLM) or are doctrine-only:

- **Steward 5-min round budget.** Three of four rounds in `g-2026-05-28-3` failed at exit=142 (SIGALRM). The OBSERVE ritual cut helped (2/3 in budget at one point) but didn't eliminate the issue. Tradeoff between rich diagnosis and round cost is unresolved.
- **Steward agent restart cost.** Every cycle re-pays for ~830 lines of SOUL + skills. Visible in token consumption but doesn't have a clear failing test until the SOUL is profiled.
- **Worker primitive bugs** — `mc collect` region-blindness, `mc mark` current-position-only, pillar_up/down off-by-one Y. Three are in flight (commits `9f34448` + `192936b` cover collect refactor; `mc mark` target-coord queued as `t_2392ac49` BUG card; pillar fuzz queued in `data/genesis-runs/g-2026-05-27-10/observations/2026-05-28-mid-p1-issues.md` §4).
- **Doctrine confusion patterns** — Steward's claim-vs-complete mistake (just fixed in SOUL), her chat-plumbing exploration (fixed by clearer doctrine + future python3 sandbox effect). Each surfaced through observation; the new SOUL sections target them.

## What's still open as TODOs

- `t_2392ac49` — `mc mark` target-coord form. Filed on landfolk-ops board.
- Tier 2 doctrine items (sapling protocol, inventory floor before [SUPPLY], pre-computed Steward snapshot) — captured in `data/genesis-runs/g-2026-05-27-10/observations/2026-05-28-prompt-improvements.md`. Defer until P2 has actually run end-to-end.
- Pillar_up / pillar_down Y off-by-one — captured in `2026-05-28-mid-p1-issues.md` §4. Half-day's work including property tests.
- Mason mark coord offsets (same root cause as t_2392ac49) — observed across g-2026-05-28-3 chest marks all 1-2m off.
- Steward "active profile is default" identity — works in practice (her hermes profile is `default` with the Steward persona/SOUL applied), but the mismatch with the kanban `assignee=steward` field creates the claim-error she got confused by. Worth revisiting whether the orchestrator profile should be named differently.

## Recommended next run

Apply the new SOUL doctrine and run with the same seed for a 5th attempt. Expected behavior delta:

1. Steward's round-1 reasoning should NOT explore `hermes kanban claim` for her own cards. If she still does, the doctrine isn't landing and we need more aggressive prompting.
2. P1 should close within ~25 min (vs operator hand-execution in run-3 at ~30 min — the doctrine win is ~5 min, plus removes the operator dependency entirely).
3. P2 promotion + first P2 SCOUT cards filed from Steward's body should follow within 1-2 more cycles. **Watch for whether Steward uses the new `--epic <P2_id>` form** in her create commands — that's the test of whether the SOUL Tier 1.1/1.5 changes generalized beyond the seed-script.
4. **Watch for any `mc advise --target` calls before [SUPPLY] file** — the commit gate. The survey produced 4 lt_* marks; if Steward proceeds straight to SUPPLY without an advise check, the gate doctrine isn't internalized.

If run-5 also stalls on a doctrine issue (not a setup issue), the round budget is the next bottleneck and we should profile / cut the SOUL.

## Lessons for future genesis experiments

1. **One bug per run is the right cadence.** Each of the 4 attempts surfaced exactly one new failure mode. Trying to "stack" multiple fixes per run risks attributing wins/losses to the wrong cause.

2. **Hard-fail at setup beats hand-debug mid-run.** Both `seed_base_pad` and `system_chest_fill` previously logged-and-continued. Switching to hard-raise made each subsequent attempt's failure mode crisp and easy to attribute.

3. **Trust the architecture once it's tested.** The facade + epic chain worked from g-2026-05-28-1 onward and never re-broke. Continuing to monitor it would have eaten budget that found later bugs.

4. **Worker doctrine that says "refuse and escalate" beats doctrine that says "improvise."** Mason blocking the shelter card with a named reason ("system_chest_empty — P1 exception cannot be honored") was far more useful than the previous run's "Mason mines blindly and entombs himself." The Tier 1.3 card-body fix is the template for future cards.

5. **`mc advise` as a commit gate is the right pattern, but workers need a primitive (`mc mark X Y Z`) that lets them save what they observed.** Otherwise the advise gate runs on marks that are 1-6m off — false-positive issues, real-positive misses.

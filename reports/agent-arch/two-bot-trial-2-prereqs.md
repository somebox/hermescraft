# Two-bot trial 2 — prerequisite fixes checklist

Tick boxes as items land. Trial 2 doesn't run until at least every **P0** is green.

Source of these items: [`2026-06-07-two-bot-trial-1-postmortem.md`](2026-06-07-two-bot-trial-1-postmortem.md).

## P0 — load-bearing for trial 2

These two were the proximate cause of trial 1 stalling. If they don't land, trial 2 stalls the same way.

- [ ] **Fix `mc collect` response shape** in `bot/lib/actions/collect.js` (or wherever it lives — locate first):
  - [ ] Add three counts to the response `data`:
    - `blocks_broken` — what the verb does today
    - `items_dropped` — count of dropped_item events observed
    - `items_collected_in_inventory` — recount inventory delta against pre-call snapshot
  - [ ] `result:` user-facing message must reflect `items_collected_in_inventory`, not `blocks_broken`
  - [ ] Add a Tier-1 contract test in `bot/test/actions/collect-contract.test.js`:
    - Stage 5 stone blocks in a mock world
    - Run `mc collect cobblestone 5`
    - Assert response includes all three counts with correct values
    - Assert `result` text reflects inventory-delta, not blocks_broken
  - [ ] Update `mc-cheatsheet.md` if it has misleading "Mined N/N" language
- [ ] **Fix `agent-crafter.md` verb table**:
  - [ ] Drop `mc chest open :mark:` everywhere
  - [ ] Replace with: `mc chest <x> <y> <z>` and `mc chest @MARK`
  - [ ] Update `mc withdraw / deposit` lines: positional mark works (`mc withdraw item count chest_stash`); `:colons:` form is for *card body references*, not CLI args
  - [ ] Add explicit "If you forget the syntax, run `mc help <verb>` — the bundle's verb table is a quick reference, not the authoritative grammar"
- [ ] **Audit all agent bundles for verb-table drift** vs `bot/cli/registry.mjs`:
  - [ ] Stand up `scripts/audit-skill-verbs.py` (was deferred — now P0)
  - [ ] Run against all 5 bundles: navigator, builder, crafter, miner, farmer
  - [ ] Each MISSING verb in any "Verbs you use" table is a P0 fix item

## P1 — likely to surface during trial 2 if not landed

- [ ] **`agent-miner.md` — outcrop-face mining strategy**:
  - [ ] Add §4 subsection "Mining an outcrop face":
    - "If `mc collect` returns 'Mined N/M' but `mc inventory` shows fewer than M items, drops are unreachable. Switch to: `mc dig <x> <y> <z>` one cell at a time, then `mc pickup` *immediately* before stepping. For multi-block faces, batch `mc dig_area` in ≤32-block chunks at a single Y plane (avoids per-call limit and fall-hazard check)."
  - [ ] Tighten §5 escape rule: "After 3 collect/dig attempts without inventory delta matching target, block with `extraction_yield_low:<observed>/<target>`. Report observed drops to the next agent."
- [ ] **All bundles using `mc move`** — pre-check movement targets:
  - [ ] Add to §4: "Targets that are solid blocks (chests, walls) need `goto_near`, not `move`. The mark form `mc move @MARK` handles this for you — prefer it. Raw coords work only when the destination cell is air."
  - [ ] Bundles to touch: navigator, builder, crafter, miner, farmer
- [ ] **Zee's lane — decide pickaxe path**:
  - [ ] **Option A (architecturally honest)**: split `z_nav_stone` into `z_nav_stash` + `z_withdraw_pickaxe` + `z_nav_stone`. Zee lane grows 3 → 5 cards. Symmetric with pip's axe-fetch.
  - [ ] **Option B (test extraction in isolation)**: fixture adds `/give Zee minecraft:iron_pickaxe 1` after `/clear Zee` in prep. Zee lane stays 3 cards.
  - [ ] Pick one before trial 2 and document the choice in this file
  - [ ] Update `two_bot_base_graph.py` for Option A, or fixture for Option B

## P2 — quality-of-life, not strict blockers

- [ ] **`mc pickup` search radius**:
  - [ ] Extend search from bot's cell to a small radius (Mineflayer's default pickup distance is ~1.5 blocks)
  - [ ] Surface what was picked up vs what's nearby-but-unreachable
  - [ ] Tier-1 contract test for this
- [ ] **Cross-bot chat noise in tool output**:
  - [ ] Add one-line guidance to every bundle (navigator, builder, crafter, miner, farmer):
    > Chat lines from *other* bots are not your concern unless your card body specifically references the other bot's progress. If you see `<other_bot> done t_xyz: ...` in tool output, treat it as background noise.
- [ ] **Investigate run-26 worker spawn crash**:
  - [ ] Check Hermes' dispatch spawn-failure path: does an unhandled exception during boot get marked `crashed` with no traceback?
  - [ ] If yes, ensure tracebacks land in `errors.log`

## P3 — operational hygiene

- [ ] **Real dispatcher script**:
  - [ ] Option A: `scripts/proto-dispatcher.sh` mirroring `scripts/landfolk-dispatcher.sh` for the proto tenant
  - [ ] Option B: integrate the dispatcher loop into `run_two_bot_base.py --watch` (one command starts both)
  - [ ] Decision can wait until after P0/P1 land
- [ ] **`pytest --run-id` registers properly**:
  - [ ] Move `pytest_addoption` from `test_two_bot_base_handoff_contract.py` into `prototypes/agent-arch/tests/conftest.py`
  - [ ] CLI form should work without setting `TWO_BOT_RUN_ID` env var
- [ ] **`scripts/stop-bots.sh` whitelist**:
  - [ ] Add Pip / Zee / Mox to the known-bot list
  - [ ] OR rewrite `scripts/colony` to do its own pkill instead of delegating to stop-bots.sh
- [ ] **`scripts/colony start --all` health check honesty**:
  - [ ] Today health-check passes if /health returns connected=true — even if /health is answered by a STALE process that the new start didn't replace
  - [ ] Need: confirm the answering PID matches the *just-spawned* PID
- [ ] **`hermes profile show` JSON support**:
  - [ ] Either the CLI grows a `--json` flag or the runner's verification logic parses the text output
  - [ ] Update `setup-pilot-pip-zee.sh` mandatory-verification accordingly

## Pre-flight checks for trial 2 (after P0–P1 land)

- [ ] `bash bot/test/run-tests.sh` — all bot Tier-1 contract tests green (includes new collect test)
- [ ] `pytest prototypes/agent-arch/tests/` — all green (includes any new bundle parsing tests)
- [ ] `scripts/audit-skill-verbs.py` — zero unknown verbs across all 5 bundles
- [ ] `scripts/colony status` — all 3 bots up, all in `landfolk-test` after a fresh `scripts/reset-open-test.sh`
- [ ] Manual smoke: `mc collect cobblestone 5` against a staged 5-block test cobble pile via Tester — confirm inventory delta matches reported count

## Trial 2 success criteria (same as v1)

| # | Number | Target |
|---|---|---|
| 1 | `parallelism_observed` + `overlap_s` | true / ≥ 60s |
| 2 | `pip_done_count` / `zee_done_count` | 7/7 and 4/4 (full lanes) |
| 3 | `sign_at_seed` | true |

Pass = (1) + (3). Partial = anything else. Fail = orchestration broke, not bundle gaps.

## Status

| Wave | Status | Notes |
|---|---|---|
| P0 | not started | Estimate ~3–4 h |
| P1 | not started | Estimate ~2–3 h |
| P2 | not started | Estimate ~2 h |
| P3 | not started | Estimate ~1–2 h |

Total to clear P0+P1 (the gate for trial 2): ~5–7 hours of focused work.

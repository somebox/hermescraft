# Navigator feedback — proc-nav-1780956289

Worker sessions: `t_272dd83b` ([NAV] reach overlook), `t_5267e4e6` ([NAV] reach return_post), `t_1e0cc1e4` ([VERIFY] live anchors)

---

## Problems hit

1. **`mc inspect --mark <name>` returns `INVALID_COORD` on mox backend.** Both the NAV trip (`mc inspect --mark overlook`) and VERIFY trip (`mc inspect --mark overlook`, `mc inspect --mark return_post`) failed with this error. `mc help inspect` shows `--mark` as valid syntax, but the backend rejects it. Workaround: call `mc marks` first to get numeric coords, then `mc inspect X Y Z`. Cost: 1 extra turn per card.

2. **`mc move @overlook` failed `NAV_TARGET_UNSTANDABLE` with no path hint.** The overlook mark is at Y=96 but ground level is Y=80 — a 16-block air gap. The card body said "reach mark within 4 blocks" with no mention that pillar_up would be necessary. Had to probe via `mc terrain_top 0 0` and `mc inspect` at several Y levels before figuring out the plan. Cost: ~5 extra turns of discovery that a single "pillar_up ~17 blocks needed" in the card body would have avoided.

3. **Bot started with only 3 dirt at spawn cliff (stuck_minutes=4.3).** The spawn position was on a cliff ledge at Y=89. First `mc status` already showed `stuck_minutes: 4.3` — the bot had been sitting idle. Had to descend the cliff with `mc stair_down south`, then collect 20 dirt from surface blocks mid-route to fuel the pillar_up. If the starting inventory had zero dirt, this would have been a blocker.

4. **No `mc help` call culture across the runs.** I didn't call `mc help` even once across 3 tasks. The `--mark` flag failure could have been spotted by checking `mc help perceive` first. Noted as a self-corrective — `mc help` is cheap and would have saved 2 rounds of guessing.

5. **VERIFY card body didn't specify which marks to inspect or which predicates to run.** Card said "verify live anchors" with no explicit list. Had to infer from context (the two NAV marks from the chain: overlook and return_post) and choose predicates based on memory of what was carried. A template with `marks_to_inspect: [...]` and `predicates: [...]` would eliminate ambiguity.

## Tooling improvements

1. **Fix `mc inspect --mark <name>` on the mox backend** so it matches the documented syntax — or remove it from `mc help inspect` output if the backend doesn't support it. The mismatch between `mc help` and reality cost every run on this board.

2. **Card body template for `[NAV]` cards should include a "hint" field.** Something like `hint: target is at Y=96, ground at Y=80 — plan for vertical climb`. Even one sentence about vertical vs horizontal would save turn budget on the first NAV card. For the second NAV card (return_post), the state continuity from memory made it smooth — one sentence in the card body would give new workers that same head start.

3. **`mc marks --names-only` or `mc mark_coords <name>`** — a lightweight subcommand that returns just the coords for one mark, without the full marks table. Parsing the `mc marks` output for a single mark wastes tokens.

## Skills / profile issues

1. **`agent-navigator` skill is solid but doesn't warn about `--mark` flag backend incompatibility.** A one-liner in the pitfall section like "`mc inspect --mark` may not work on all backends; fall back to `mc marks` + numeric coords" would save future runs.

2. **`minecraft-navigation` skill covers pillar_up correctly.** The pillar_up/pillar_down pattern worked reliably across both NAV cards. No issues here.

3. **Profile env vars were already set** — `MC_API_URL` and `MC_USERNAME` were in the environment at spawn. No config friction in this run.
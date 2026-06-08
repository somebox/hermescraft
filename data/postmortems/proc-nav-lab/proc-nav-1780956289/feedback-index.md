# Trial feedback — proc-nav-1780956289

Board: proc-nav-lab
Roles: navigator,planner
Generated: 2026-06-09T00:53:11+02:00

## navigator

- card: `t_a7261c92`  status: done

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
## planner

- card: `t_bbec7a31`  status: done

# FEEDBACK — planner (proc-nav-1780956289)

**Run:** proc-nav-1780956289 (board proc-nav-lab, bot mox)
**My cards:** `t_cd85d105` (draft anchor playbook), `t_b8929b57` (finalize from verify)
**Graph:** proc-scout / tier: core

---

## Problems hit

1. **No card-body reference to data source.** For `t_cd85d105`, the card said "research anchor playbook" but didn't say *where* the anchor coordinates lived. I had to discover `data/runtime/last-scenario-map.json` by searching the repo — a wasted round-trip that should be a single sentence in the card body.

2. **Runbook file path not given.** The card expected me to edit `proc-nav-scout-runbook.md` but didn't specify which directory. I searched the entire `~/.hermes` tree before finding it under `reports/agent-arch/`. A relative path hint in the body would save one search call per card.

3. **`mc inspect --mark NAME` returns INVALID_COORD.** This came up in the verify stage (`t_1e0cc1e4` / navigator) and I documented it in the runbook, but it forced a workaround: workers must use numeric coords (`mc inspect 0 96 0`) instead of mark names. On a trial that's testing navigation and anchoring, a broken `--mark` flag is a primary friction.

4. **Parent-task metadata schema not documented.** On `t_b8929b57`, I needed the navigator's `verify_results` from the parent card. The data was there in `kanban_show` metadata, but the body didn't tell me *which metadata keys* to look for. I parsed the whole metadata dict blind. A one-line hint (e.g. "verify results are in parent `t_1e0cc1e4` metadata under key `verify_results`") would make the handoff zero-friction.

5. **Seed `1001` versus world name ambiguity.** The scenario-map JSON references world `proc-lab` (the template), but the arena is materialised as `proc-nav`. A new operator reading the runbook could be confused about which world name to use where. The collision table at the bottom helps, but the anchor table itself still says `proc-lab` which conflicts with the env block's `PROC_WORLD=proc-nav`.

## Tooling improvements

1. **Add `mc inspect --mark NAME` as a working flag.** This is the biggest concrete improvement for a navigation-trial runbook. The verifier fixture (`scripts/proc-nav-verify-anchor.sh`) already works around it by parsing `last-scenario-map.json` coords, but a *live* bot doing in-world inspection should be able to say `mc inspect --mark overlook` and get a block type, not an `INVALID_COORD` error.

2. **A `skill_view('proc-nav')` or `data/postmortems/proc-nav-lab/_layout.json`** that lists the canonical file layout for a proc-nav run: where the runbook lives, where `last-scenario-map.json` lives, where postmortem artifacts go, and which environment variables are expected. This would eliminate the "find the file" search round-trip on every researcher card.

3. **Card-body template for RESEARCH cards.** A consistent template with placeholders for:
   - Source data path (e.g. `data/runtime/last-scenario-map.json`)
   - Target file path (e.g. `reports/agent-arch/proc-nav-scout-runbook.md`)
   - Parent task id (for handoff reads)
   This is 3 lines of structured YAML in a card body and would eliminate all four of the search/guess problems above.

## Bundle gaps

- **Stale: the Anchor playbook section** was entirely new (it didn't exist before this run), so no staleness there. The rest of the runbook was current.
- **Missing: no "canonical file map" skill** for proc-nav workers. Each worker role (planner, navigator, steward) discovers file paths independently. A shared reference in the bundle would cut the per-worker orientation overhead.
- **The SOUL profile** (planner) had the right tools — no missing verbs. The `kanban_*` tools worked, `read_file`/`write_file`/`patch` worked. The gap was process/documentation, not tooling.

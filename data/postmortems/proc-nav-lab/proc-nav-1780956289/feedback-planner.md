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
# mc command surface audit — 2026-05-29

**Follow-on strategy:** convergence policy (two-layer registry vs agent surface, facade roadmap, evidence loop) — [`../architecture/embodied-control.md`](../architecture/embodied-control.md).

Workflow run: regenerated cheatsheet from `bot/cli/registry.mjs`, reconciled `docs/reference/mc-command-reference.md`, ran the static-sync test suite, and audited per-command schema/test coverage.

**Scope:** 181 commands across 11 categories.

---

## 1. Documentation sync

### `docs/reference/mc-cheatsheet.md` was stale
Regenerating via `node scripts/gen-mc-cheatsheet.mjs` produced **18 changed lines** — 14 new commands plus 4 updated descriptions. The committed cheatsheet was last regenerated before the following commands landed:

- observe: `blueprint`, `check`
- movement: `jump`, `ladder`, `move --force`
- world: `edit_sign`, `farm_status`, `level_ground`, `sail_to`, `till_area`, `verify_plot`
- memory: `go_site`, `region_create`, `region_remove`, `region_update_intent`, `regions_reload`, `regions_terrain`, `site_add`, `site_remove`
- task: `task_context`
- building (new category): `construct`, `repair`

**Action:** cheatsheet has now been regenerated and committed in this audit. Add a hook or CI check (see fix list §F.4) so it can't drift again.

### `docs/reference/mc-command-reference.md` taxonomy is out of sync with registry
Section A buckets several commands under the wrong intent. Comparing the table against `RAW_COMMAND_DEFS[*].category`:

| Doc says intent | Registry category | Commands |
|-----------------|-------------------|----------|
| movement | world | `escape`, `through` |
| memory | world | `set_home` |
| memory | movement | `deathpoint` |
| platform | observe | `health`, `advise` |
| platform | goals | `goals` |
| world | task | low-level boat verbs (board/disembark/sail/place_boat) — registry has them as world, doc mention is fine |

Also missing from the doc entirely:
- The whole **`building`** category (`construct`, `repair`).
- `respawn` (world).
- The expanded **regions** vocabulary: `regions_reload`, `regions_terrain`, `region_update_intent`, `site_remove`, `task_context`.

### `CATEGORY_ORDER` drift
Two copies of the list exist and **neither includes `building`**:

- `bot/cli/registry.mjs:2201` → `[platform, observe, movement, world, craft, combat, social, memory, task, goals]`
- `scripts/gen-mc-cheatsheet.mjs:20` → `[observe, movement, world, craft, combat, memory, goals, task, social, platform]` (different order!)

The cheatsheet generator's fallback dumps `building` at the bottom of the file with no explanatory header, and the CLI's grouped help (`mc help`) is driven by the registry copy.

---

## 2. Missing test coverage

41 of 181 commands have **no test reference at all** (string-grep against `bot/test/**`):

```
observe:     alerts, anchors, blueprint, fair_play, furnaces, logistics,
             screenshot_meta
movement:    look_at
world:       construct (building), farm_status, fish, repair (building)
memory:      region_update_intent, regions_reload, regions_terrain, site_remove
craft:       —
combat:      crit, shield, shoot, sneak, sprint_attack, strafe
goals:       goal_add, goal_load, goal_presets, goal_remove, goal_set,
             goal_status
task:        bg_combo, bg_fight, bg_smelt, bg_strafe, checkpoint_respond,
             task_history, task_pause, task_resume, task_start
social:      acknowledge_command, cancel_command, complete_command, overhear
platform:    batch, dashboard
```

Combat verbs in particular (`shoot`, `shield`, `sprint_attack`, `crit`, `strafe`) are zero-coverage despite being the meat of the combat category. The four queue-management verbs (`acknowledge_command`, `cancel_command`, `complete_command`) are also untested.

## 3. Failing tests on master

`HERMES_VALIDATE=1 npm test` from `bot/` surfaces these real failures (the suite was interrupted before completion due to the sign-watcher hang noted below):

| Test | Failure | Likely cause |
|------|---------|--------------|
| `actions-manifest.test.js` — *action module factory names match the createXxxActions convention* | `farming-survey.js: no create*Actions export found` | File exports `runVerifyPlot`/`runFarmStatus`/`runRegionsTerrain` runners but no factory. Either rename to `_farming-survey.js` (skip-prefix) or move runners into `farming.js`/`regions/observe.js` properly. |
| `queries-escape-characterization.test.js` — *enclosure_inside → ESCAPE_ENCLOSURE* | got `ESCAPE_HP_TOO_LOW` instead of `ESCAPE_ENCLOSURE` | New HP gate runs before the classification branch; fixture needs full HP, or the gate needs to fall through to enclosure classification first. |
| `eat-while-mounted.test.js` — *on dry land + food not held → equip + consume* | equip call count `0 !== 1` | `equip()` no longer invoked on the on-land path (auto-eat mod handles it?). Test or code is stale. |
| `eat-while-mounted.test.js` — *mounted + equip fails → fall through to consume via hotbar slot* | result string lacks `"equip warn"` | Same shape — code stopped emitting the equip-warn diagnostic. |
| `base-goals.test.js` — *evaluateStock: stock below target_min → SUPPLY hint* | output says `100/128 (target_ok 192)` but test expects `100/512` | `cobblestone` target values were tuned down; test fixtures still on the old constants. |
| `base-goals.test.js` — *evaluateStock: floors fractional counts* | same shape as above | Same cause. |
| `test/runtime/regions/sign-watcher.test.js` | **hangs** (>20s with `--test-timeout`, parent suite logged 138s on first run) | A watcher or fs poll isn't being torn down. Blocks the full-suite run from finishing. |

## 4. Schema / parameter issues

### 4.1 Unbounded numeric parameters (53 occurrences)
Registry args of type `number` with no `min`/`max`, excluding world-coords (x/y/z/x1…z2/gx…dz which legitimately span the world). A few representative cases — pass huge values and the only thing stopping them is the handler:

- `nearby.radius`, `map.radius`, `scene.range`, `scout.radius`, `find.scan_range`, `is_sheltered.radius`, `reachable.range` — perception radii; handlers clamp some but not all (`map` is documented as clamped to 16, but the schema doesn't enforce it).
- `fight.duration`, `bg_fight.duration`, `wait.seconds`, `fish.timeout_seconds`, `sail.timeout_seconds`, `task_resume.lease_seconds` — time-based; an agent passing `duration: 1e9` will tie the bot up indefinitely.
- `dig_pit.{w,l,d}`, `tunnel.{length,width,height}`, `stair_up/down.{length,width,height}`, `build_stairs.length` — bulk-block ops with documented caps (e.g. "max 500 blocks") that live only in the handler, not the schema. Easy to under-specify in agent prompts.
- `toss.count`, `deposit.count`, `withdraw.count`, `bg_collect.count`, `find_blocks.count`, `chest_search.max_results`, `hunt.count`, `pillar_step.count`, `pillar_down.count` — quantities; unbounded means an agent typo (`count: 1000`) doesn't fail fast.
- `complete_command.index`, `acknowledge_command.index`, `cancel_command.index` — queue indices; could plausibly use `min: 0`.

Full list dumped to `/tmp/mc-findings.json` and reproducible via `node -e "import('./bot/cli/registry.mjs')..."` (script in this audit).

### 4.2 Commands with no `examples`
**88 commands** have no `examples:` array — that's nearly half the surface. The cheatsheet generator falls back to the `usage:` line, but `mc <cmd> --help` shows a near-empty Examples section. Notable ones because they're frequently agent-facing:

- `chat_to`, `whisper`, `team_chat`, `report`
- `goal_*` (every goals verb)
- `bg_collect`, `bg_goto`, `bg_fight`, `bg_smelt`, `bg_combo`, `bg_strafe`, `task_start`, `task_pause`, `task_resume`
- `shoot`, `shield`, `sprint_attack`, `crit`, `strafe`, `combo`
- `equip`, `place`, `interact`, `use`, `toss`, `eat`, `sleep`
- `mark`, `marks`, `mark_update`, `go_mark`, `unmark`, `regions`, `check`
- `construct`, `repair`
- `health`, `dashboard`, `commands`, `help`, `anchors`, `stats`, `connect`, `fair_play`
- `chest`, `furnaces`, `furnace_check`, `furnace_take`, `smelt`, `smelt_start`, `recipes`
- queue verbs: `complete_command`, `acknowledge_command`, `cancel_command`
- social: `social`, `read_chat`, `overhear`, `rally`, `set_team`, `team_status`, `deaths`, `sounds`

### 4.3 Schema-level positives (no findings)
- **No alias collisions** across the 181 entries.
- **No raw `throw new Error()` in handlers** — all six `throw` sites in `bot/lib/actions/` are rethrows from `try/catch` wrappers, so the dispatcher's `ok:false` envelope is always reached.
- **No `required: true` + `default:` mixups** (would be a contradiction; none found).
- **No `path` + `pathFn` collisions**, no `GET` + `bodyFn` mixes.

## 5. Other observations

- `bot/lib/actions/mining/index.js:33` declares `safe_dig: null` and then reassigns on line 36. Cosmetic, but reads like a stub on first scan; consider building the handlers object in one expression.
- `mc-commands.md` ends with a "Regenerate this table after handler changes: grep `next_action_hint` under `bot/lib/actions/`" — the refusal-code → next-command table is hand-maintained against grep output, no automation. Worth scripting if the table is meant to stay current.
- `RAW_COMMAND_DEFS` is 2225 lines in one file. Splitting per-category would make per-domain audits cheaper, but that's a refactor decision, not a defect.

---

## Fix list (TODO)

### A. Documentation
- [ ] **A.1** Add `building` to `CATEGORY_ORDER` in both `bot/cli/registry.mjs:2201` and `scripts/gen-mc-cheatsheet.mjs:20`, and align the two arrays to the same order.
- [ ] **A.2** Update `docs/reference/mc-command-reference.md` § A (taxonomy table): move `escape`/`through` → world; `set_home` → world; `deathpoint` → movement; `health`/`advise` → observe; `goals` → goals; add a **building** row for `construct`/`repair`; mention `respawn`, `task_context`, `regions_reload`, `regions_terrain`, `region_update_intent`, `site_remove`.
- [ ] **A.3** Rerun `node scripts/gen-mc-cheatsheet.mjs` whenever the registry changes — wire as a `package.json` script (`npm run cheatsheet`) or pre-commit hook.
- [ ] **A.4** Either script the refusal-code → next-command table in `mc-commands.md` § E, or note that it's a best-effort snapshot and date it.

### B. Tests for uncovered commands
- [ ] **B.1** Combat verbs (highest leverage): `shoot`, `shield`, `sprint_attack`, `crit`, `strafe`, `combo`. Mock bot + assert ok/fail envelopes.
- [ ] **B.2** Queue verbs: `acknowledge_command`, `cancel_command`, `complete_command` — index bounds, missing-command, normal-path.
- [ ] **B.3** Region-mutation verbs: `region_update_intent`, `regions_reload`, `regions_terrain`, `site_remove`.
- [ ] **B.4** Goals verbs: `goal_add/set/remove/status/presets/load` — at least one happy-path each.
- [ ] **B.5** Background-task wrappers: `bg_combo`, `bg_fight`, `bg_smelt`, `bg_strafe`, `task_history`, `task_pause`, `task_resume`, `task_start`, `checkpoint_respond`.
- [ ] **B.6** Stragglers: `alerts`, `anchors`, `blueprint`, `fair_play`, `furnaces`, `logistics`, `look_at`, `farm_status`, `fish`, `construct`, `repair`, `batch`, `dashboard`, `overhear`.

### C. Failing tests on master
- [ ] **C.1** `actions-manifest.test.js` — rename `farming-survey.js` → `_farming-survey.js` (skip-prefix) since it's a helper, not a factory module. Verifies the test passes again.
- [ ] **C.2** `queries-escape-characterization` — decide intended behavior when HP is low AND enclosed: classify enclosure first or HP-gate first. Update test or code accordingly.
- [ ] **C.3** `eat-while-mounted` — two tests still expect the legacy `equip → consume` two-step. Either restore the equip-warn diagnostic or update tests to the new auto-eat shape.
- [ ] **C.4** `base-goals.evaluateStock` — three tests reference `512` cobblestone targets, code now uses `128`/`192`. Update fixtures.
- [ ] **C.5** `test/runtime/regions/sign-watcher.test.js` hangs indefinitely — find the unclosed handle (watcher / interval) and add an `after()` to tear it down.

### D. Schema tightening
- [ ] **D.1** Cap time-based knobs at handler limits in the schema: `wait.seconds` (≤300?), `fight.duration` / `bg_fight.duration` (≤600?), `fish.timeout_seconds` (≤300), `sail.timeout_seconds`, `task_resume.lease_seconds`.
- [ ] **D.2** Cap radii at the values handlers already enforce: `map.radius` (max 16, documented), `scout.radius`, `nearby.radius`, `find.scan_range`, `is_sheltered.radius`, `reachable.range`.
- [ ] **D.3** Cap bulk-block ops at the documented limits: `dig_pit.{w,l,d}`, `tunnel.{length,width,height}`, `stair_*`/`build_stairs.length`. Right now the docstring says "max 256 columns × 16 depth" but the schema accepts anything.
- [ ] **D.4** Set `min: 0` on the queue index params (`complete_command.index`, `acknowledge_command.index`, `cancel_command.index`).
- [ ] **D.5** Set `min: 1` on `count`-style params (`hunt.count`, `bg_collect.count`, `pillar_step.count`, `pillar_down.count`, `toss.count`, `deposit.count`, `withdraw.count`).

### E. Examples coverage
- [ ] **E.1** Backfill `examples:` for the 88 commands missing them. Lowest-effort fix: a single-line `examples: ['mc <name> <typical args>']` per entry. Highest-leverage targets: agent-facing verbs (`shoot`, `shield`, `goal_*`, `bg_*`, queue verbs, `task_start/pause/resume`, `regions`, `marks`, `chest`, social verbs).

### F. Process / guardrails
- [ ] **F.1** Pre-commit hook (or `tests` step) that runs `node scripts/gen-mc-cheatsheet.mjs` and fails if it changes anything tracked.
- [ ] **F.2** Add a registry test that fails when `category` is not in `CATEGORY_ORDER`.
- [ ] **F.3** Add a test that every command in registry has at least one `examples:` entry (or explicitly opt-out via a known list).
- [ ] **F.4** Document this audit + cadence (e.g., "rerun this audit after every command-registry PR") in `docs/conventions/` or `CLAUDE.md`.
- [ ] **F.5** Add `intent` + agent-surface tier (`core` / `macro` / `microscope`) on `CmdDef`; generate cheatsheet, lane tables, and `mc help --profile` from registry — strategy: [`../architecture/embodied-control.md`](../architecture/embodied-control.md) § Delivery order.
- [ ] **F.6** Contract test: block/entity payloads use shared typed-noun shape (observation-verb-grammar § response shapes).

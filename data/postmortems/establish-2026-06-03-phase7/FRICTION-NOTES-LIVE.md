# Phase 7 replay run-4 — live friction journal (2026-06-03)

Captured *during* run-4 (started 2026-06-03 02:29) — operator (re44) observations from watching the live session. Concrete patterns to dig into post-run via the analyzer and to inform the next round of nav/SOUL work. **Do not lose this file** — it has signal the kanban event log and t_*.log files don't capture.

## What the operator is observing (verbatim, paraphrased)

> Still seeing a lot of movement struggles. A common issue is that agents try to `move_to` a block which is **occupied** by a block. They mark something and then can't navigate back. `move_near` might be a solution, but in general the pathfinding should be less strict — it's OK if they arrive ±1-2 blocks if the distance is great.
>
> I also see regularly agents thinking they are trapped when they just **dug a block under foot**. Many cycles wasted on thinking they are trapped or blocked when in fact they could just **jump out of the hole**. Then they will **place blocks to escape the trivial situation**, and those blocks now become impediments for even more navigation issues.
>
> Agents should be more deliberate about digging and placement — deciding to construct or mine stairs is a **planned action**, and navigation should be more forgiving so they don't need to modify a working environment to make things harder.
>
> The base and surrounding area are littered with small holes and stairs that were started. The base is not preserved — many blocks are missing. `"No standable cell..."` and `"No path..."` and `"no block..."` dominate for `move` and `dig` commands. Meanwhile **`bg_goto` and `goto_mark` seem to be actually useful**.

## Patterns (named for follow-up reference)

### Pattern A — Mark-then-can't-return / occupied target

- Agent: `mc mark <name>` at some coord X. Later: `mc goto_mark <name>` or `mc move X Y Z` to return.
- Failure: "No standable cell within 1 of X" — the cell is occupied by the block they marked (e.g. a chest, the mark was placed at the chest's exact coord).
- Root: `mc move` is strict about the destination cell being standable; marks recorded at solid-block coords are unreachable by `move`.
- Fix surface: either (a) `mc mark` should auto-shift to nearest standable adjacent cell, or (b) workers should use `mc goto_mark` (lenient) or `mc move_near <X> <Y> <Z> --radius 2` for any non-self-placed mark.

### Pattern B — Self-trap after digging foot block

- Agent: `mc dig X 96 Z` where (X,96,Z) is the cell directly under their feet.
- Reality: bot falls 1 block, now stands at Y=95 in a 1-deep hole. Auto-jump can climb out trivially.
- Hallucinated state: bot's nav-brief / `mc status` reports `lastMoveFailed` or `NAV_RECURRING_STUCK`, agent reads this as "trapped."
- Cycles wasted: agent re-issues `mc status`, `mc scene`, decides to `pillar_up` or `mc place` cobble to escape.
- Fix surface: nav-brief should classify a 1-deep depression as `walk_out_via_jump`, not as trapped; or `mc escape` should auto-detect this and just step out.

### Pattern C — Panic-place blocks to escape trivial obstacles

- Trigger: agent thinks they're trapped (Pattern B above, or NAV_BLOCKED on flat ground).
- Action: `mc pillar_up` with whatever's in hand (cobble, dirt, planks).
- Result: a permanent 1×N pillar where there shouldn't be one, polluting the world for future pathfinding.
- Fix surface: `mc escape` SOUL guidance should be "ONLY when sidestep + jump both fail." Need observable: nav-brief field `exits_via_jump: bool` so the agent has the affirmative answer.

### Pattern D — Environment degradation / compound obstacle

- Cumulative effect of Pattern B + C: base area becomes "littered with small holes and stairs that were started."
- Subsequent navigation has more obstacles than the initial world, making future Pattern B more likely.
- Run3+Run2+Run-4 all share the same world (because `AUTO_REUSE=1 MATERIALIZE=0`), so this compounds across runs.
- Fix surface: (a) `AUTO_REUSE=0 MATERIALIZE=1` bootstrap path needs to work (currently broken — `mapcatalog try` requires `-r/--requirements` that the map regen doesn't pass), or (b) a lightweight "base area cleanup" rcon step in `establish-rcon-prep.py` that fills holes + clears non-structure blocks in the spawn radius.

## Verbs that work (operator observation)

- **`bg_goto`** — background async goto. Tolerates more uncertainty.
- **`mc goto_mark`** — works because it's already lenient about exact arrival cell.

These suggest the right model for `mc move` long-distance: **lenient by default**, with a strict-arrival flag only when needed.

## Run-4 specific oddity — 0 marks landed despite 4 closed explore cards

- All 4 explore cards (NE flint, NW gatherer, SE mason, SW gatherer) reached `done`.
- `data/locations-flint.json`, `locations-gatherer.json`, `locations-mason.json` all show **0 marks** in their `marks` arrays.
- Expected: `lt_<resource>_<dir>`, `candidate_pad_*`, and similar marks per the explore card body.
- Possible causes:
  1. Workers never called `mc mark` (they closed cards without producing structured outputs).
  2. Workers called `mc mark` but the calls errored (`mc mark` may have failed in the world-state mess).
  3. Marks are written somewhere else (board comments instead of `locations-*.json`)?
- This invalidates the Phase 7.4 predicate ("marks saved at target coords matching note text") — we can't measure it if no marks exist.
- Action: in the post-run analyzer pass, check the per-card t_*.log files for `mc mark` invocations and what they returned.

## Postmortem follow-up checklist (add to Phase 7.7 or a new Phase 8)

- [ ] **Analyzer extension:** count `mc move` "No standable cell within N of X,Y,Z" errors and the subsequent action (retry, pillar_up, give-up). Look for Pattern A (mark-then-can't-return).
- [ ] **Analyzer extension:** detect Pattern B (self-trap-by-digging) — sequence `mc dig <foot_coord>` → `lastMoveFailed=true` → many `mc status` calls without successful move.
- [ ] **Analyzer extension:** detect Pattern C (panic pillar) — `mc pillar_up` or `mc place` of a non-structure block immediately after a NAV_BLOCKED error.
- [ ] **Nav-brief field:** add `exits_via_jump: bool` (true if there's a standable cell at +1 Y in any cardinal direction from feet).
- [ ] **`mc move` lenient mode:** add `--near R` flag that accepts arrival within R blocks of target. Default R=2 for long-range (>20 blocks), R=0 for short-range.
- [ ] **`mc mark` auto-shift:** if the target coord is non-standable (block or fluid), shift to nearest standable adjacent cell and record the shift in the mark metadata.
- [ ] **`mc escape` SOUL prompt:** add explicit "jump is your first escape — only pillar_up if jump fails and sidestep fails."
- [ ] **World cleanup:** either fix `AUTO_REUSE=0 MATERIALIZE=1` bootstrap, or add `establish-rcon-prep.py` step that fills spawn-area holes (Y=spawn-3 → spawn for X∈[-6,6], Z∈[-6,6] cylinder).
- [ ] **Mark accounting:** investigate why 0 marks landed despite 4 closed explores. May be (a) SOUL bullet didn't reach workers' attention, (b) `mc mark` failed silently, or (c) marks went somewhere else.

## Useful for the postmortem narrative

The Phase 7.0 fix (seeder + orchestrator-tracker) is **clearly working**. The Phase 7.2 retry-warning fix is also doing its job (no NAV_RETRY_LOOP recurrence observed yet). But the **dominant friction in this run is not retry-loops** — it's:

- The strict cell-match in `mc move` (Pattern A)
- The hallucinated-trapped state (Pattern B)
- The panic-pillar response (Pattern C)
- The world degradation (Pattern D)

These four are not addressed by the current Tier 1+2+3 changes. They're the next round. The good news: the operator's verb-level observation (`bg_goto` + `goto_mark` work) points at a concrete model — those verbs are lenient by default. Pulling that pattern into `mc move`'s default behaviour (especially long-range) would close a lot of friction in one change.

## Timestamps for cross-reference

- Run-4 start: 2026-06-03 02:29
- Pattern observations captured: ongoing through 03:13+
- Mason rescue auto-handled by Steward: ~02:50-03:00
- NW closed (first explore close): ~03:13
- All 4 explores closed: by ~03:00
- Mason claimed pad construct: 03:00
- This file written: ~03:15

## Live observation 03:22 — Mason on pad t_628f0e9e (21 min runtime, 34 errors, 295 cognition lines)

Mid-run verb counts (running, not closed):

| Verb | Count |
|---|---|
| mc move | 19 |
| mc inspect | 18 (storm continues despite SOUL bullet) |
| mc go_mark | 12 (proves marks exist somewhere) |
| mc terrain_top | 9 |
| mc scene | 9 |
| mc goto_near | 6 |
| mc status | 5 |
| **mc pillar_up** | **4** (Pattern C panic-pillar — LIVE) |
| mc chest_search | 4 |
| mc map | 4 |

### Confirmed in real time

- **Pattern C live confirmation:** 4 `mc pillar_up dirt 10` calls in 21 minutes. Mason is leaving permanent dirt pillars behind every time she gets stuck-feeling.
- **Inspect SOUL bullet did not reach Mason:** 18 inspects vs the "at most 1-2 per failed fill slice" bullet. Either: (a) the SOUL/skill load path for Mason workers doesn't include the freshly-edited file, (b) Mason is inspecting for non-fill reasons (perception, decision-making), (c) the model isn't honouring the bullet. Investigate which in postmortem.
- **`--near 2` is in the wild:** Mason's last `mc move 14 102 3 --near 2` shows lenient-arrival is already used by some agents in some paths. Tier 2 nav-hint may have surfaced it, or it was muscle memory. Worth tracing the source.
- **Marks live somewhere other than locations-*.json:** `mc go_mark lt_stone_ne` succeeded for Mason. So lt_stone_ne exists as a named mark. But per-bot location files show 0 marks. Marks are in a shared board-level registry. Phase 7.4 predicate measurement is targeting the wrong file.
- **Multi-step supply detour:** Mason left the pad to find cobblestone (read residual chests, found them empty, decided to mine). This costs ~5-10 turns per detour; in a fresh world with prepped supply chests, this wouldn't happen.

### Action items added

- [ ] **Trace mark storage:** find where `mc go_mark` reads from. Likely `bot/lib/runtime/locations.js` `resolvePlace` reads from a shared map AND per-bot file. Determine the canonical source for Phase 7.4 measurement.
- [ ] **Mason SOUL load verification:** add a one-line `mc echo` or skill-load assertion in worker boot to confirm the freshly-edited `mason.md` was loaded by the current run. Suspect prompt cache or load-path issue.
- [ ] **Trace `--near` adoption:** count how many `mc move` calls in this run use `--near` vs strict. If <30%, the agent-side discipline isn't there yet and the verb default needs flipping.

## Pattern E — Terrain blindness (operator observation 03:30)

**What the operator is seeing live:**

> The play area is filled with missing blocks and holes, making players get constantly trapped. Either pathfinding takes them into these places or they are trying to mine? There's a cluster of chests near base that have oak fences scattered, unclear why the fences get built. I also observed that the play area is on a hill — this means an agent moves up/down hill and, realising they are at a different Y level, they think they are underground and need to pillar up, or high up and need to go down.

### The diagnosis

Agents read raw `Y` coords and absolute deltas, but lack a **characterisation** of the surrounding terrain. When Y=84 reads on `mc status`, the agent doesn't know:
- "You are on natural terrain at the local surface elevation" → walk normally
- vs. "You are 12 blocks below the local surface, in a pit" → need to climb out
- vs. "You are on a natural plateau, the rest of the world is lower" → expect Y differences

So a flat trip up a south-facing hill (legitimate navigation, no problem) reads identically to falling into a pit (real problem requiring escape).

### Fix surface — terrain characterisation field

Add a structured terrain-kind classification to `mc scene` / `mc status` (nav-brief). The hook already has the data: [`bot/lib/shared/scene-landscape.js`](bot/lib/shared/scene-landscape.js) computes `cardinalReliefDeltas` at radius 16. Extend with a `terrain_kind` classifier and a `feet_vs_local_ground` field.

**Proposed classification labels (initial set):**

| Label | Trigger |
|---|---|
| `flat` | All four cardinal deltas within ±2; biome not extreme |
| `gentle_slope_<N\|E\|S\|W>` | One cardinal dropping/rising ≥4 over 16 blocks, others within ±2 |
| `steep_slope_<dir>` | One cardinal dropping/rising ≥10 over 16 blocks |
| `hilltop` | All four cardinal deltas negative (ground around you is lower) by ≥3 |
| `small_mound` | All four cardinal deltas negative by 1-3 |
| `valley` | All four cardinal deltas positive (ground around you is higher) by ≥5; narrow |
| `depression` | All four cardinal deltas positive by 3-8 (e.g. a quarry-like pit) |
| `mountainside` | Two adjacent cardinals very high, opposite cardinals lower |
| `coastline` | Water within 4 cells in one direction, land on the others |
| `cave_floor` | Y feet ≥6 below nearest surface candidate; air above is enclosed |

**Proposed companion field `feet_vs_local_ground: int`:**

- Sample `local_ground_y` from `surfaceYAt(bot, pos.x, pos.z)` (already exists in scene-landscape.js).
- `feet_vs_local_ground = feet_y - local_ground_y`.
- 0 = standing on surface, 1 = on a placed block, -1 = in a 1-deep hole (can jump out — Pattern B prevention!), -8 = underground.

The agent reads `terrain_kind: gentle_slope_S, feet_vs_local_ground: 0` and knows: I'm on a slope at the surface, this Y change is normal, no escape action needed.

The agent reads `terrain_kind: depression, feet_vs_local_ground: -3` and knows: I'm in a 3-block-deep hole carved into otherwise flat terrain, I need to climb or fill.

### Side observation: fence cluster near base chests

Operator: *"there's a cluster of chests near base that have oak fences scattered, unclear why the fences get built."*

Hypothesis: Mason (or another worker) is calling `mc fence` or `mc place oak_fence` as a *panic-marker* or *partial-build* — possibly:
- Building a fence enclosure but abandoning mid-build (ran out of fence_block, switched task)
- Using fence as a "do not cross" placeholder around a work area
- The `mc fence` verb's `--gate <dir>` option not being invoked, leaving partial fence runs

Add to postmortem analyzer: count `mc place oak_fence` and `mc fence` calls per worker per card. Cross-reference with adjacent `mc dig oak_fence` (recovery). If a worker places fence then later digs it back up, that's a Pattern C/E mix.

### Postmortem follow-ups (Phase 8 candidate items)

- [ ] **Add `terrain_kind` field to nav-brief** ([`bot/lib/runtime/nav-brief.js`](bot/lib/runtime/nav-brief.js) + [`bot/lib/shared/scene-landscape.js`](bot/lib/shared/scene-landscape.js)). Use existing `cardinalReliefDeltas` data + a thresholded classifier. Surface in `mc status` nav_header and `mc scene` summary.
- [ ] **Add `feet_vs_local_ground: int` field** alongside `terrain_kind`. Same source: `surfaceYAt` already exists in scene-landscape.js. Zero new dependencies.
- [ ] **Worker SOUL update** (after the field ships): "interpret your altitude via `terrain_kind` and `feet_vs_local_ground`, not raw Y. If `terrain_kind: gentle_slope_*` you are NOT underground."
- [ ] **`mc escape` honours `feet_vs_local_ground == -1`**: short-circuit to jump action instead of pillar.
- [ ] **`mc fence` audit**: when the verb is invoked without `--gate`, return an advisory hint suggesting one be added; when partial fence-place happens (manual `mc place oak_fence` without forming a closed loop), no auto-fix but log for postmortem visibility.
- [ ] **Analyzer extension**: count `mc place oak_fence` calls and the cells they target. Map them to detect "fence cluster without enclosure" pattern.

### The architecture point worth making in the next postmortem

Most of these patterns (A-E) share a root cause: **the bot exposes raw geometry but not classified semantics.** The agent has to *re-derive* "am I in a hole?" "am I on a slope?" "did I trap myself?" every cycle from `mc status` deltas. That re-derivation costs LLM turns AND makes errors (Pattern B's hallucinated-trapped is exactly this).

The Phase 8 (or 9) thesis should be: **classify the situation server-side, present labelled state to the agent.** Fields like `terrain_kind`, `feet_vs_local_ground`, `exits_via_jump`, `nearest_standable`, `path_blocked_by: <fence|wall|pit|self>`. Each one collapses 3-10 cycles of model reasoning into a single read. Same pattern as `kanban_show` returning a structured worker_context instead of letting the agent assemble it.

---

## Run closed — postmortem complete (2026-06-03 ~03:35)

Full per-bot postmortem in [`THOROUGH-POSTMORTEM.md`](THOROUGH-POSTMORTEM.md) (4 parallel subagent reports consolidated). Headlines:

### Phase 7 predicate scorecard (3 of 10 held)

- ✅ 7.0 seeder fix — 0 Steward kanban-worker sessions for explore cards
- ✅ Steward orchestrator-deny — 0 mutating mc verbs
- ✅ Steward reassigned explore cards within first OBSERVE cycle
- ⚠️ 7.2 nav hints — flint doesn't retry-3x (pivots instead), so warning never fires; predicate unmeasurable
- ❌ 7.3b FILL_PARTIAL — **Mason never called `mc fill` at all**. Contract change had no chance to exercise.
- ❌ 7.3a HTTP timeout — same reason (no `mc fill` calls)
- ❌ 7.4 mark `--at` — **0 of ~12 explore-phase marks used `--at`** (all bots saved at standing pos)
- ❌ 7.5 structured handoff template — Gatherer (gold standard) reverted to run2 ad-hoc narrative
- ❌ Steward `hermes kanban diagnostics` — **0 calls in 20 OBSERVE cycles** despite SOUL mandate
- ❌ Steward `parents=[…]` / `idempotency_key=…` — not adopted in her creates

### Per-bot one-line summary

- **Steward** — clean orchestration mechanically, but **whispered raw-Y terrain advice** ("you're underground at Y=96, pillar_up 15") that caused Pattern C panic-pillars in workers. Pattern E at the orchestrator level.
- **Flint** — adaptive pivoting, lenient verbs used. **0/3 marks with `--at`**, 4 `mc pillar_up` calls. Inherited Mason's degraded pad mid-run.
- **Mason** — **best self-rescue** (two deliberate `pillar_up --force` from spawn pit), 6 named marks on SE. But **never called `mc fill` on the pad** — manual dig/place loop consumed 150 turns. 4 panic-pillars.
- **Gatherer** — most reliable explorer (2 cards closed). **0 use of structured handoff template** despite the SOUL inheriting from her run2 gold standard. 5 panic-pillars. Hit `mc collect oak_log 64` count cap (issue #55).

### Newly discovered issues (above Patterns A-E)

1. **Spec-execution gap** — Mason's pad task body literally specified `mc fill cobblestone 13 103 1 21 103 9` but the worker treated it as flavour text and dug manually. 150 turns lost.
2. **Mark storage mystery resolved** — marks land in `locations-base.json` (shared), not per-bot files. UX trap.
3. **Steward generates Pattern E orders** — terrain-blindness at the orchestrator level cascades into worker panic-pillars.
4. **`mc collect COUNT max=64`** (issue #55) blocks SUPPLY cards routinely.
5. **0 cards used `parents=[…]` / `idempotency_key=…`** in run-4 — Steward's run2 discipline regressed.
6. **Iteration budget (150)** is fragile for construct cards. Run2 hit it; run-4 hit it on the same card.

### Tier 1 Phase 8 candidates (hermetic, fast)

1. Enforce `mc mark --at` when note text contains coords — soft-fail with hint.
2. Surface `terrain_kind` + `feet_vs_local_ground` in nav-brief (reuse existing `scene-landscape.js` data).
3. Steward SOUL: mandatory `hermes kanban diagnostics` on >15-min IN-FLIGHT card.
4. `mc move` long-range (>20 blocks) default to `--near 2`; strict mode opt-in.
5. Update Steward SOUL to interpret `terrain_kind` (after #2 ships).

See [`THOROUGH-POSTMORTEM.md`](THOROUGH-POSTMORTEM.md) for full Tier 1-4 list and the per-bot evidence behind each finding.

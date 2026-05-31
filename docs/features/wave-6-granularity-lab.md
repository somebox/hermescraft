# Wave 6 — Granularity lab (hard task, phase batch size)

**Status: closed** (2026-05-31). Results preserved below; pass summary:
[`playbook-improvement-pass-closure.md`](playbook-improvement-pass-closure.md).
No further matrices under this pass — successor testing uses procedural worlds.

## Question

For **deepseek-v4-flash** workers on a **hard** card (not chop-oak-8), does
playbook structure help when we tune **phase count** and **ritual budget**?

We are not re-running flat A1. We measure:

1. **World pass** — honest predicates (height / block column), not playbook verb presence alone.
2. **Cost** — mc CLI median, ok:false, turns used vs `max_turns`.
3. **Telemetry** — sub-play JSONL for `pillar_up_safe` when the playbook arms use it.

Optional escalation arm: same YAML with `--model deepseek/deepseek-pro` (n=2) if
all Flash arms fail completion but show lower error rates on playbook.

## Primary scenario — mini vertical tower (W6-T1)

**Stress id:** `tower-reuses-pillar-up-safe` (alias: `tower-mini-pillar`).

**Spec:** `data/agent-tests/playbooks/tower-reuses-pillar-up-safe.yaml`

**Goal:** From a grass pad at `(82, 65, 58)`, raise a **6-block cobble column**
at `(84, 65, 58)` (y=65..70) and stand on top (`bot_y_at_least: 71`). Flint
starts with 20 cobble; no mining required — isolates **build + pillar ritual**
from chop/deposit noise.

**Arms:**

| Arm | Card shape | Phase ritual target | `max_turns` (Flash) |
|-----|------------|---------------------|---------------------|
| `prose-skilled` | Prose + `minecraft-building` / navigation skills | 0 playbook verbs | 45 |
| `playbook-coarse` | `playbook: build.tower_vertical` **3 phases** (preflight → raise → closeout); sub-play `pillar_up_safe` in raise | ≤2 `[run_state]` comments; minimal `phase set` | 45 |
| `playbook-medium` | Same playbook **5 phases** (preflight → approach → raise → verify → closeout) | ≤4 `[run_state]`; explicit verify | 55 |

Default model in YAML: `deepseek/deepseek-v4-flash:exacto` (override with
`scripts/agent-test.py --model …` per arm run).

**Pass (per arm, n≥3 Flash):**

- Predicate: `bot_y_at_least: 71` and cobble present at `(84, 70, 58)` (top cell).
- **Completion rate** ≥2/3 for an arm to be “viable”; compare medians only among arms that can finish at all.
- Playbook arms should show `sub_playbook_id: pillar_up_safe` in JSONL on ≥2/3 successful runs.

**Not a gate:** beating prose-skilled on mc median. Wave 5 already falsified
that on easy supply work. Here we learn **where** structure pays on hard work.

## Secondary scenario — shallow mine chamber (W6-T2)

**Not in registry yet:** `mine.underground_target`.

Same three-arm pattern as W6-T1 when built. **Lower priority than W6-T3** unless
Steward needs an explicit mine vertical default before genesis — single-chamber dig
may still look like “one loop” (like one column) and reproduce prose-skilled wins
without testing multi-step failure modes.

## W6-T3 — Platform tower (recommended next; harder than one column)

**Hypothesis W6-T1 did not test:** multi-anchor spatial work + enough mc budget that
Flash agents occasionally fail or partial-complete — where **resume (A3)** or
**preflight (A2)** might matter, not “playbook vs prose on mc median.”

**Stress id:** `tower-platform-3x3`

**Spec:** `data/agent-tests/playbooks/tower-platform-3x3.yaml`

**Status:** Harness ready (2026-05-31). Run matrix before updating § W6-T3 Results.

**Goal:** On grass pad `(96..104, z=66..74)`, build a **3×3 platform at y=69**:

- Four **corner pillars** at `(100,65,70)`, `(102,65,70)`, `(100,65,72)`, `(102,65,72)`,
  each **4 cobble tall** (y=65..68).
- **Floor:** cobble at all nine cells `(100..102, 69, 70..72)` (includes edges between corners).
- **Pass:** `bot_y_at_least: 70` standing on platform center `(101, 70, 71)`; predicates on
  four pillar tops `(y=68)` + center floor `(101, 69, 71)` via `world_block_at` (rcon `Test passed`).
- **Start:** `(98, 65, 71)`, 40 cobble, no pickaxe — pure place/pillar navigation.

**Why harder than W6-T1:**

| Dimension | W6-T1 | W6-T3 |
|-----------|-------|-------|
| Anchors | 1 column | 4 corners + 9 floor cells |
| Typical prose mc | ~10 | target **25–45** (ordering mistakes) |
| Playbook value | Ritual only | Optional **checkpoint** arm (see below) |
| Failure modes | Rare | wrong cell, run out of blocks, y confusion |

**Arms (this round):**

| Arm | Purpose |
|-----|---------|
| `prose-skilled` | Baseline cost + completion (n≥3 Flash) |
| `playbook-coarse` | `build.tower_vertical` platform_coarse ritual |
| `prose-skilled-resume` | Partial world + `[run_state]` (A3-class on build) |

**Regression before matrix:** `chop-preflight-refusal`, `chop-checkpoint-resume`.

**Harness changes bundled:** `prep_extra` per arm; `entity_in_bbox` via scoreboard (not bot chat).

### W6-T3 commands

```bash
scripts/regenerate-artifacts.sh
scripts/stress.sh chop-preflight-refusal
scripts/stress.sh chop-checkpoint-resume
scripts/stress.sh tower-platform-3x3 --arm prose-skilled

for arm in prose-skilled playbook-coarse prose-skilled-resume; do
  for i in 1 2 3; do
    scripts/stress.sh tower-platform-3x3 --arm "$arm"
  done
done
```

### W6-T3 Results

**2026-05-31 (n=3 per arm, `deepseek/deepseek-v4-flash:exacto`).**

| Arm | n | mc median (range) | mean | full pass | pillars 4/4 | center floor | playbook/run | ok:false |
|-----|---|--------------------|------|:---:|:---:|:---:|---:|---:|
| prose-skilled         | 3 | **46** (42–68) | 52.0 | **2/3** | 3/3 | 2/3 | 0   | 0 |
| playbook-coarse       | 3 | 55 (10–62)     | 42.3 | **0/3** | 0/3 | 0/3 | 1.3 | 0 |
| **prose-skilled-resume** | 3 | **43** (22–54) | 39.7 | **3/3** ⭐ | 3/3 | 3/3 | 0 | 0 |

**Verdict:** playbook-coarse 0/3 even with low ritual call count (1.3 avg) —
2 timeouts + 1 give-up at 10 mc. The arm isn't slowed by ritual; it doesn't
get far enough for ritual to matter. **Flash binds on multi-anchor work.**

prose-skilled-resume wins both axes: 3/3 complete, lowest median mc. The
partial-world prep + `[run_state]` hint lets the agent skip orientation
and go straight to finishing — same structural benefit A3
(`chop-checkpoint-resume`) showed on chop, now confirmed on build. **This
is where structure pays off** on Flash, not in playbook ritual.

| Hypothesis W6-T3 tested | Result |
|---|---|
| "Playbook ritual amortizes on harder spatial tasks" | **Falsified.** Coarse 0/3. |
| "A3-class partial-world resume translates to build verticals" | **Supported.** Resume 3/3 ⭐. |
| "Flash binds on multi-anchor work" | **Confirmed.** Coarse timed out twice; prose-skilled lost 1/3 to running out of turns. |

### Pro escalation — withdrawn

Earlier gating rule said "if Flash binds, run Pro to see if the
architecture amortizes." That conflates the architecture question with a
model-swap question. **Design constraint (2026-05-31): v4-flash is the
worker model; v4-pro is reserved for challenging planning (e.g. Steward),
not for rescuing falsified worker arms.** A Pro escalation that lifts
playbook-coarse from 0/3 to 3/3 doesn't help — production workers run
v4-flash. The architecture must make v4-flash succeed.

Read the W6-T3 result as: **at the design model, partial-world resume
(prose-skilled-resume, 3/3) is the structure that pays off; playbook
ritual (coarse, 0/3) does not.** Pro is off the table as a falsification
rescue. Per-model performance differences may be noted in passing
(e.g. A2 regression under v4-flash vs `google/gemini-2.5-flash` below)
but are not the experimental axis.

### Regression check (this matrix)

- **A3 `chop-checkpoint-resume`**: ✅ PASS at 24 mc.
- **A2 `chop-preflight-refusal`**: ❌ **FAIL** — agent issued
  `task_context` + `playbook` × 3 calls and stopped without checking
  inventory or blocking the card. Previous A2 runs under
  `google/gemini-2.5-flash` passed at 5 mc consistently. The YAML pins
  gemini-2.5-flash; if this run used a different model via override,
  the result is model-conditional. Flag for follow-up; not fixed in
  this batch.

### W6-T3 prep sketch (implemented)

- Arena `x=96..104`, `z=66..74`, separate from W6-T1 `(80–88)` and chop arenas.
- `fill` grass at y=64, clear y=65..80.
- No pre-placed cobble — inventory only.
- `max_turns`: 55 prose, 60 coarse; `mc_cli_invocations_max`: 90.

## W6-T4 — 3×3 dual-deck tower (zero dirt, 54 cobble)

**Stress id:** `tower-scaffold-3x3` (alias: `tower-scaffold-2x2`)

**Spec:** `data/agent-tests/playbooks/tower-scaffold-3x3.yaml`

**Status:** Harness ready — run after W6-T3 (or parallel).

**What gets built** (footprint **x=110..112, z=80..82**):

```
Side (corner column):

  y=75 ─ corner cobble
  y=72-74 ─ corner only (upper pillar extension)
  y=71 ─── full 3×3 upper platform
  y=66-70 ─ corners only (4 cells/layer); interior AIR (5-layer gap)
  y=65 ─── full 3×3 lower platform
```

- **Four corner pillars** **11 blocks** tall at each corner (y=65..75 along corner cells).
- **Two platforms** **5 layers apart** (lower y=65, upper y=71; open bay y=66..70).
- **54 cobble** total in work bbox — filling the mid bay solid **fails** (count > 54).

**Scaffold:** dirt only at **x=109 or x=113** (outside 3×3). Sectional or level-by-level OK (`minecraft-building`).

**Machine pass:**

| Check | Rule |
|--------|------|
| Structure | `structure_manifest` — platform layers + corner column ranges (54 cells) |
| Zero dirt | dirt **max 0** in work bbox (107..114, y=65..76, z=79..84) |
| Exact cobble | cobble **count == 54** in work bbox |
| Grounded | `bot_at` (107, 65, 83) ±3 |
| Budget | `mc_cli_invocations_max`: 150 |

**Prep:** 64 cobble, 48 dirt.

```bash
scripts/stress.sh tower-scaffold-3x3 --arm prose-skilled
for arm in prose-skilled playbook-coarse; do
  for i in 1 2 3; do
    scripts/stress.sh tower-scaffold-3x3 --arm "$arm"
  done
done
```

### W6-T4 Results

**2026-05-31 (n=3 per arm, `deepseek/deepseek-v4-flash:exacto`).**
After the pre-prep cycle fix, `inventory_reset`, env-var alignment to
`spec["_kanban_task_id"]`, and rcon-batched predicates. **Predicate phase
median ~3s** (range 2.8–3.1s) across all runs — the batching fix dropped
this from ~3min before. No Flint deaths. All bots ended inside the work
bbox.

| Arm | n | mc median (range) | mean | full pass | bot_at | structure | dirt≤0 | cobble==54 | pred phase |
|-----|---|--------------------|------|:---:|:---:|:---:|:---:|:---:|---:|
| **playbook-coarse** | 3 | **82** (70–87) | 79.7 | **2/3** ⭐ | 2/3 | 2/3 | 2/3 | 2/3 | ~3s |
| prose-skilled | 3 | 103 (72–121) | 98.7 | **0/3** | 0/3 | 2/3 | **0/3** | 1/3 | ~3s |

**Verdict — first reversal at v4-flash.** Playbook-coarse beats
prose-skilled on the full-predicate pass rate (2/3 vs 0/3) **and** on mc
median (82 vs 103). Prose-skilled failures are uniformly
"structure-mostly-built, dirt scaffold left behind, didn't return": run
3 hit 54/54 cobble but kept 13 dirt and ended 9.2 blocks from target.
**The closeout ritual is what pays off** — coarse's 3-phase
preflight → build → closeout pattern forces the agent to walk a closeout
phase that includes both dirt cleanup and the distance return, two
things prose-skilled agents drop under turn pressure.

This refines the Wave-5 falsification: **playbook ritual is not
universally beaten by prose-skilled at v4-flash** — it loses on tasks
with trivial closeout (A1 chop, W6-T1 single column, W6-T3 platform
with "stand on center" closeout) but wins on tasks where closeout is
multiple distinct verbs (W6-T4 dirt cleanup + return). The taxonomy is
**closeout complexity**, not raw task difficulty.

**Caveats (n=3, one fixture):**

- **Structure rate tied (2/3 both arms).** Coarse’s lift is on dirt, cobble
  count, and `bot_at` — not on manifest completion alone. That supports
  “closeout / teardown,” not “playbook builds better.”
- **Confounded card.** Coarse loads playbook skills plus an explicit
  **verify** line (“no dirt in work box before phase clear”); prose mentions
  teardown once in doctrine. Part of the win may be **checklist placement**,
  not `mc playbook phase set` overhead — untested until a
  `prose-skilled-closeout` arm (same verify bullets, zero playbook verbs).
- **Missing arm:** W6-T3’s winner was **`prose-skilled-resume` (3/3)**, not
  coarse. T4 never tested resume + strict bbox; coarse 2/3 does not retire
  resume for scaffold work.
- **Runner label vs world:** `verdict=TIMEOUT` when all predicates pass
  (coarse run 2) is a harness quirk — score matrices on predicates, not
  exit code alone.

### W6-T4 paths of interest

- **PASS path** — `tower_scaffold_3x3_playbook_coarse-2026-05-31T16-58-*` (run 2)
  and `…-16-58-*` (run 3): 87 / 82 mc, all four predicates pass, dirt=0,
  bot 0.7 blocks from target. Run 2's `verdict` is `TIMEOUT` (hermes hit
  max_turns) but **all world predicates pass** — the world signal is
  what counts; the timeout label is a meta-runner artifact.
- **Telling FAIL** — `tower_scaffold_3x3_prose_skilled-2026-05-31T16-39-*` (run 3):
  121 mc, **structure 54/54 built ✓**, but **dirt=13 ✗** and bot at
  (112.7, 72, 81.5) — 9.2 blocks from target, ended on top of the
  upper deck. Agent did the build, forgot the closeout. Exactly the
  failure mode the coarse ritual prevents.

## Model policy (design constraint)

**Workers run `deepseek/deepseek-v4-flash` (or `:exacto`).** `v4-pro` is
reserved for *challenging planning* (Steward author turns), not for
escalating worker arms. A Pro vs Flash comparison is not a falsification
rescue — even if Pro lifts a falsified worker arm, production workers
won't get Pro. **The architecture must make v4-flash succeed.**

Per-model performance differences (e.g. A2 preflight passing under
`google/gemini-2.5-flash` but failing under `v4-flash:exacto`) may be
noted as side observations but are not the experimental axis.

If a fixture binds at v4-flash, the move is to **change the architecture
or the card pattern**, not the model:

- Did partial-world prep + `[run_state]` flip the arm (A3-class resume)?
- Did `allowed_verbs` widen to include observation verbs the agent needs?
- Did the prep over-constrain (e.g. tp onto a chest cell)?
- Is the budget honest for the task (max_turns reasonable)?

When all of those are tuned and the arm still binds at v4-flash, the
fixture is *too hard for a worker* and should move to Steward author
scope, not to a stronger model.

## Ritual policy (playbook arms)

Documented in card bodies under `includes/tower-mini/`:

- **Coarse:** one `phase set` per macro phase; sub-play entered once with
  `--sub-playbook pillar_up_safe --sub-phase check_lateral`; clear sub when done.
- **Medium:** separate approach + verify phases; still one sub-play invocation
  for the 6-step raise (do not re-enter sub-play per block).

Expand `build.tower_vertical` `allowed_verbs` if compliance shows false
whitelist failures on `scene`/`status` (same lesson as Wave-5 chop).

## Commands

```bash
scripts/regenerate-artifacts.sh   # playbook-build-tower-vertical hub sync

# One arm
scripts/stress.sh tower-reuses-pillar-up-safe --arm prose-skilled
scripts/stress.sh tower-reuses-pillar-up-safe --arm playbook-coarse
scripts/stress.sh tower-reuses-pillar-up-safe --arm playbook-medium

# Matrix (Flash, n=3)
for arm in prose-skilled playbook-coarse playbook-medium; do
  for i in 1 2 3; do
    scripts/stress.sh tower-reuses-pillar-up-safe --arm "$arm"
  done
done
```

Record medians in this file § Results (after runs).

## Results

**2026-05-31 (n=3 per arm, `deepseek/deepseek-v4-flash:exacto`).**
Predicate fix in this window: `world_block_at` now reads rcon's own
`execute if block` stdout (`Test passed`/`Test failed`) instead of the
unreliable bot-side `new_chat` capture of a `say MATCH` marker. The first
matrix attempt reported 0/9 pass with this predicate broken — every arm
actually pillared 6 cobble correctly. See § Errata.

| Arm | n | mc median (range) | mean | pass (y≥71 + top cobble) | playbook calls/run | pillar calls/run |
|-----|---|--------------------|------|--------------------------|-------------------|------------------|
| **prose-skilled**  | 3 | **10** (8–12) | 10.0 | **3/3** ✅ | 0   | 1.7 |
| playbook-coarse    | 3 | 18 (18–33)    | 23.0 | 3/3 ✅      | 5.7 | 1.3 |
| playbook-medium    | 3 | 29 (29–38)    | 32.0 | 3/3 ✅      | 4.3 | 2.3 |

**Verdict — Option C (prose-skilled wins).** Completion is tied (3/3 across
all arms), but prose-skilled costs **~2× less than playbook-coarse and ~3×
less than playbook-medium**. The ritual cost (5–6 `mc playbook phase set`
calls per coarse run, 4 + extra pillar boundaries per medium run) doesn't
amortize on this fixture either — same shape as A1 at Flash, but cleaner
because both A1 and W6-T1 now show the same falsification on a more
structured task. Playbook tells *the same story it told on chop-oak-8*: at
v4-flash, the ritual is paid in tool calls; on a tractable build task the
overhead loses to a tight prose body + the right skill stack.

The "harder task changes the outcome" hypothesis is not supported by W6-T1.
A4 was the previous candidate; here a different structured task on a
different model gives the same answer.

### Errata — broken `world_block_at` predicate (now fixed)

The first matrix attempt reported 0/9 chest pass and `y_pass=None`. The
`bot_y` predicate was returning `True` (every arm reached y=71) but my
aggregator used the wrong key name. The `world_block_at` predicate was
genuinely broken — it sent `execute if block X Y Z run say MATCH` and
listened for the marker in the bot's `new_chat`. Server `say` doesn't
reliably reach the bot's mineflayer chat buffer, so the predicate returned
False even when the block was in place. Fix in `scripts/agent-test.py`:
read rcon's own stdout from `execute if block X Y Z minecraft:<block>`
(Paper prints `Test passed`/`Test failed`).

This is the same family of bug as the earlier `chest_item_count_at` SNBT
parse — predicates that look like they work but silently always fail.
Worth a quick audit pass on any other agent-test predicate that reads via
bot-side state. **2026-05-31:** `entity_in_bbox` migrated to scoreboard count
(same fix family).

## Decisions after W6-T1 (updated post W6-T3 / W6-T4)

- **Simple vertical (single column, W6-T1): Option C.** Prose-skilled +
  building/navigation skills; not `build.tower_vertical` in Steward templates.
- **Multi-anchor platform (W6-T3): Resume, not ritual.** Default partial-world
  + `[run_state]` pattern for handoffs; playbook-coarse 0/3 at Flash.
- **Scaffold dual-deck with strict teardown (W6-T4):** At Flash, **coarse
  playbook (2/3) beat prose-skilled (0/3)** on full predicates when closeout
  is dirt removal + return to ground anchor. Steward-facing default is **not**
  decided on n=3 — prefer either coarse playbook **or** prose with an explicit
  closeout checklist (and test resume) before cataloging `scaffold_3x3_dual`.
- **Stage 3 broad catalog: stays paused** until closeout pattern is chosen
  and validated with a fourth arm if needed.
- **Playbooks remain in scope for:** A2 preflight, A3 resume, A4 composition,
  and **T4-class closeout** where ritual/checklist prevents forgotten teardown.

## Next steps

**Superseded.** See [`playbook-improvement-pass-closure.md`](playbook-improvement-pass-closure.md)
§ Successor direction (procedural worlds, skills, collaboration patterns).

Historical regression only:

1. A2/A3 spot-checks before reproducing any Wave 6 arm.
2. Optional T4 confound arms (`prose-skilled-closeout`, resume on T4) — only if
   revisiting closeout science; not required for pass closure.

## Related docs

- Registry: `data/playbooks/registry.yaml` → `build.tower_vertical`
- Playbook doc: [`playbooks/build-tower-vertical.md`](playbooks/build-tower-vertical.md)
- Baseline A1/A4: [`baseline-turns-fixture.md`](baseline-turns-fixture.md)
- Test procedure: [`playbook-pass-test-procedure.md`](playbook-pass-test-procedure.md) § Wave 6

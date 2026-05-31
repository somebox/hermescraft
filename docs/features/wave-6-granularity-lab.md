# Wave 6 — Granularity lab (hard task, phase batch size)

Status: **W6-T1 complete (Option C)** · **W6-T3 prepared** (platform matrix pending).

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

| Arm | n | mc median | pass | Notes |
|-----|---|-----------|------|-------|
| prose-skilled | 0 | — | — | |
| playbook-coarse | 0 | — | — | |
| prose-skilled-resume | 0 | — | — | |

### W6-T3 prep sketch (implemented)

- Arena `x=96..104`, `z=66..74`, separate from W6-T1 `(80–88)` and chop arenas.
- `fill` grass at y=64, clear y=65..80.
- No pre-placed cobble — inventory only.
- `max_turns`: 55 prose, 60 coarse; `mc_cli_invocations_max`: 90.

## Escalation — Pro on W6-T1

**Recommendation: skip** for decision-making. All Flash arms **3/3** with prose at
median **10** mc — the task was not binding. Pro vs Flash on W6-T1 only answers
“does a stronger model pay ritual tax on a trivial pillar,” not whether playbooks
help on work that actually stresses the worker.

Re-run Pro when **W6-T3** (or W6-T2) shows Flash **<2/3** completion on prose-skilled
or medians **>40** mc with partial failures — compare Pro prose vs coarse **n=2** there.

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

## Decisions after W6-T1

- **Option C confirmed.** Steward templates for `[BUILD] vertical tower` should
  be **prose-skilled bodies** (`minecraft-building + minecraft-navigation` skill
  stack), not `playbook: build.tower_vertical`. `build.tower_vertical` stays as
  test harness, not Steward template.
- **Stage 3 broad catalog: stays paused.** No 25-id expansion until either (a)
  ritual cost is reduced or (b) a stronger model reverses the result.
- **Playbooks remain in scope for:** A2 (preflight discipline), A3 (resume),
  A4 (composition + sub-play telemetry — both still verified). These are
  scenarios where prose can't easily express the discipline; not "harder tasks."

## Next steps

1. **Run W6-T3 matrix** — record § W6-T3 Results; Pro n=2 only if Flash binds (<2/3 pass or mc median >40).
2. **W6-T2 mine** — after T3 pass rates.
3. **Predicate audit** — `entity_in_bbox` fixed; scan remaining `expect` for chat bridges.

## Related docs

- Registry: `data/playbooks/registry.yaml` → `build.tower_vertical`
- Playbook doc: [`playbooks/build-tower-vertical.md`](playbooks/build-tower-vertical.md)
- Baseline A1/A4: [`baseline-turns-fixture.md`](baseline-turns-fixture.md)
- Test procedure: [`playbook-pass-test-procedure.md`](playbook-pass-test-procedure.md) § Wave 6

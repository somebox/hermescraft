# Terrain-shaping context suite — improvement pass closure

**Status:** closed (context layer). **Subject model:** `deepseek/deepseek-v4-flash`. **Suite:** `data/context-tests/suites/terrain-shaping.yaml` (11 scenarios).

## Problem

Workers chose nav retries, chat, or empty replies instead of shaping verbs (`clear_strip`, `level_ground`, `deck`, `move` outside protect) on synthetic observe fixtures. Needed a repeatable batch loop and a promotion path from failures → fixtures/skills → re-run.

## What shipped

| Area | Change |
|------|--------|
| Suite + matchers | 11 terrain scenarios, patterns in `scripts/context-tests/lib/patterns.mjs`, fix-backlog on every run |
| Batch | `./scripts/terrain-shaping-batch.sh` (`baseline`, `ab`, `summary`, `gate`, `doctor`) |
| Observation lever | `next_action_hints[]` in shared observe JSON; surfaced in `scripts/context-tests/lib/prompt-builder.mjs` |
| Fixtures | Hints on apron, pad, protect, tree corridor, ravine, two-block lip; `tree_corridor` loads `minecraft-roadbuilding.md`; ravine prior `next_action_hint` |
| Doctrine | Roadbuilding obstacle table + kanban-worker protect/apron/pad bullets; nav `target_standable` hint path (bot); [`docs/reference/minecraft-gameplay-mechanics.md`](../../reference/minecraft-gameplay-mechanics.md) |
| Grading | `extractMcLines` strips copied hint commentary (`` ` `` / ` — `) |

## Evidence (runs)

| Run id | n | Stable pass | Notes |
|--------|---|-------------|--------|
| `r_2026-06-17T12-34-04-920Z` | 3 | 6/11 | First baseline |
| `r_2026-06-17T14-49-35-719Z` | 5 | 5/11 | Many empty outputs before observe hints |
| **`r_2026-06-17T15-02-08-890Z`** | 3 | **9/11** | **Best after observe hints** — only apron (67%) + lip parse noise |
| `r_2026-06-17T15-09-24-922Z` | 3 | 8/11 | Variance on pad/step-up; lip stable after grading fix |

Post-closure (2026-06-19): apron/lip fixture edits; baseline **9–10/11** @ n=3; hint A/B **null** on step-up prior; embodied **6/6**; gate smoke ran (mixed with goals-gap). See [2026-06-19 status](./2026-06-19-terrain-shaping-status.md).

Re-check without spend:

```bash
./scripts/terrain-shaping-batch.sh summary --run r_2026-06-17T15-02-08-890Z
```

## Promotion decision

**Promote (keep in repo):**

- **`next_action_hints` observation fixture pattern** — primary lift for this suite; aligns with methodology rule 4 (observation over prose when both are plausible).
- Skill/roadbuilding + tree scenario skill list + ravine prior hint (supporting doctrine).
- Batch driver + fix-backlog workflow for future terrain regressions.

**Do not treat as production gate:**

- **11/11 stable at n=5** was not demonstrated. Residual flakes: **`base_apron_excludes_shelter`** (∅ outputs on some runs); occasional **`protected_region_no_force_repair`** / **`walkable_step_down_use_move`** variance between back-to-back baselines.
- **`terrain-shaping-hint-promote`** (prior_patch step-up only): **A/B run 2026-06-19** — no lift on step-up (already 1.0); **do not promote** ([learnings 2026-06-19](../learnings-promotion.md)).

**Context pass closed; embodied F_* suite 6/6 on Tester (2026-06-19)** — see [runtime promotion plan](../../planning/terrain-shaping-runtime-promotion.md) and [status rollup](./2026-06-19-terrain-shaping-status.md).

## Regression guard

Before large prompt/skill edits touching nav or shaping:

```bash
./scripts/terrain-shaping-batch.sh doctor
./scripts/terrain-shaping-batch.sh baseline --runs 3 --yes
```

Target: stable ≥ 8/11 on baseline config (same bar as closure best run).

## Next case (recommended order)

1. **Bot P0** — [runtime promotion plan](../../planning/terrain-shaping-runtime-promotion.md) § P0 (nav + region hints); re-run baseline + embodied after.
2. **Gate policy** — `./scripts/terrain-shaping-batch.sh gate --runs 1 --yes` mixes **`goals_gap_not_withdraw`**; decide terrain-only smoke vs full gate before genesis mint (gate ran 2026-06-19 — see [status rollup](./2026-06-19-terrain-shaping-status.md)).
3. **Genesis / fleet mint** — only after P0 + gate policy; embodied **6/6** on Tester is necessary but not sufficient (prompts still coached).

See also: [`learnings-promotion.md`](../learnings-promotion.md) (2026-06-17 + 2026-06-19), [`data/context-tests/fix-backlog/README.md`](../../../../data/context-tests/fix-backlog/README.md), [`test-agent-llm-runbook.md`](../../guides/test-agent-llm-runbook.md) (terrain F_* table).

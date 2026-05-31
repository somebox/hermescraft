# Baseline turns — playbook pass (fixture A1)

Per-run genesis output still lands under `data/genesis-runs/<run_id>/findings/baseline-turns.md` via `nav-telemetry.py --baseline-turns`. This file tracks **fixture A1** medians for Stage 4.

Stage 4 A1 **% improvement target: TBD** until **n≥5 per arm** medians exist below.

## Genesis aggregate (g-2026-05-30-3)

See postmortem under `data/genesis-runs/g-2026-05-30-3/findings/` (local, gitignored) and:

```bash
scripts/nav-telemetry.py g-2026-05-30-3 --baseline-turns g-2026-05-30-3
```

## Fixture A1 — chop-oak-8 (2a-V)

**Arenas:** three 10×10 grass slabs in a row at `z=45..55` (A1 `x=50..60`, A2 `x=62..72`, A3 `x=74..84`). Tree/chest coords in each YAML and `includes/chop-oak-8/goal.txt`. FPV layout without running a test: `scripts/show-arenas.py`.

Run matrix (≥5× per arm):

```bash
for arm in prose-minimal prose-skilled playbook; do
  for i in 1 2 3 4 5; do
    scripts/stress.sh chop-prose-vs-playbook --arm "$arm"
  done
done
```

Archive JSON under `data/agent-tests/runs/` with card-body content hash.

### Pilot run (n=1, `google/gemini-2.5-flash`, 2026-05-31)

Infrastructure fixes in this window: JSONL `HERMESCRAFT_TMP` + profile tag, Hermes playbook hub mirror, contiguous A1 arena, cleanup `fill` from y=65, agent-test kanban facade guidance (see playbook doc).

| Arm | mc CLI calls | ok:false (report) | Notes |
|-----|-------------|-------------------|--------|
| prose-minimal | 11 | — | 12 oak deposited; lowest call count at n=1 |
| prose-skilled | 28 | — | 6 oak deposited (under 8 target) |
| playbook | 38 | — | Phases walked; 6 oak; ~10 calls overhead vs minimal (ritual + mistaken kanban/scene attempts before skill/doc fix) |

**Not a falsified A1 at n=1** — playbook did not beat prose on tool calls. Interpretation: single-tree landfolk-test is too easy for structure to pay off; playbook ritual + agent-test toolset gap inflated playbook arm; need n≥5 and/or harder tasks (branching, resume, handoff) before Stage 4 % target.

**A2 / A3 (n=1, same session):** PASS — preflight `prep_required_unmet:axe` via `scripts/kanban block` (8 mc); A3 resume from `[run_state]` → 8 deposited (9 mc). Usable as **regression** gates independent of A1 medians.

### Medians (fill after n≥5)

| Arm | mc CLI calls (median) | ok:false (median) | turns (median) |
|-----|----------------------|-------------------|----------------|
| prose-minimal | TBD | TBD | TBD |
| prose-skilled | TBD | TBD | TBD |
| playbook | TBD | TBD | TBD |

**Pass (A1):** playbook medians ≤ both prose arms on tool calls and errors.

## Fixture A4 — chop-composition (Stage 2b)

```bash
scripts/regenerate-artifacts.sh   # sync playbook-pillar-up-safe to Hermes hub
scripts/stress.sh chop-composition
scripts/show-arenas.py            # optional: A1–A4 FPV layout
```

**Pass (A4):** sub-play completes; parent resumes; JSONL rows include `playbook_id` + `sub_playbook_id` during ascend; `pillar_up` used. Record n≥1 in agent-test JSON under `data/agent-tests/runs/`.

| Run | mc calls | sub_playbook in JSONL | Notes |
|-----|----------|------------------------|-------|
| TBD | TBD | TBD | Tall trunk arena x=88..98 |

## Follow-ups (not blocking regression)

- Mineflayer position desync after Multiverse `mvtp` + rcon `tp` — keep `verify_after_prep` off until rcon `data get block` probe exists.
- `mc scene` CLI shape — LLMs guess wrong positional forms; documented in playbook skill.
- Production workers have `kanban_*` tools; agent-test uses `scripts/kanban` only.

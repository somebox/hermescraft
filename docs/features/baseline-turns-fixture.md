# Baseline turns — playbook pass (committed stub)

Per-run genesis output still lands under `data/genesis-runs/<run_id>/findings/baseline-turns.md` via `nav-telemetry.py --baseline-turns`. This file tracks the **fixture A1** medians that Stage 4 needs.

Stage 4 A1 **% improvement target: TBD** until the table below is filled from A1 runs.

## Genesis aggregate (g-2026-05-30-3)

See postmortem under `data/genesis-runs/g-2026-05-30-3/findings/` (local, gitignored) and:

```bash
scripts/nav-telemetry.py g-2026-05-30-3 --baseline-turns g-2026-05-30-3
```

## Fixture A1 — chop-oak-8 (2a-V)

Run ≥5× per arm:

```bash
for arm in prose-minimal prose-skilled playbook; do
  for i in 1 2 3 4 5; do
    scripts/stress.sh chop-prose-vs-playbook --arm "$arm"
  done
done
```

Archive JSON reports under `data/agent-tests/runs/` (or a local `a1-chop-prose-vs-playbook/` folder) with card-body content hash.

| Arm | mc CLI calls (median) | ok:false (median) | turns (median) |
|-----|----------------------|-------------------|----------------|
| prose-minimal | TBD | TBD | TBD |
| prose-skilled | TBD | TBD | TBD |
| playbook | TBD | TBD | TBD |

**Pass (A1):** playbook medians ≤ both prose arms on tool calls and errors.

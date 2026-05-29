# Genesis validation — observation package 1

Post-deploy checklist for same-seed A/B (operator-run).

## Watch (first 15 min)

- Workers read `situation` / use `mc scene` when blocked (not only repeat `goto`/`move`).
- Equip-before-collect when `hand_vs_inventory` appears on status.
- Site survey / shelter cards still complete (scene-first doctrine).

## Scripts (after run)

```bash
scripts/mc-call-survey.py      # status vs inventory call mix
scripts/analyze-mc-failures.py # NO_VISIBLE_BLOCKS, refusing_to_dig
scripts/agent-context.py       # session size
scripts/genesis.sh diff <run_a> <run_b>
```

Record deltas in this file under **Results**.

## Results

_(fill after A/B)_

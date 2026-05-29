# Context tests — observation package 1

Scenarios added:

- `equip_before_collect` — expects `equip` before `collect` when observe reflects `hand_vs_inventory`.
- `boxed_in_recovery` — expects dig/escape/move/standing, not repeat `goto`, after boxed-in `situation`.

Run (operator):

```bash
# baseline + variant n=5 per project harness; example suite:
node scripts/context-tests/run.mjs --suite examples --runs 5
```

Record pass rates here after run.

## Results

_(pending operator run)_

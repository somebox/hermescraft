# gv2 short pinned-site pilot

Use after scoring/capture fixes land and unit tests pass. gv2 emergent runs always
**fresh reset** the world (no `--keep-world` path).

## Preconditions

- `python3 -m unittest discover -s scripts/tests -p 'test_gv2*.py'`
- `scripts/kanban validate-board` (or poller) reports `gv2_invalid=0` on open worker cards
- ADR fixture policy + `fixture_policy` scorecard field enabled

## Commands

```bash
# New world + kanban, pinned spawn (adjust anchor to your scout pin)
scripts/genesis.sh new-run --seed=N --no-confirm \
  --anchor X,Y,Z --max-runtime-h=1

# After stop: offline score + fixture audit
python3 scripts/gv2-score-run.py --run-id <run_id> --no-llm
```

## Expected signals

- `establishment.milestones.shell` matches physical shell in `base-snapshot.json`
- `base_viability.coverage_complete` true when footprint forceload succeeded at stop
- `fixture_policy.ok` true when `chest_*` marks match depot policy (or lists violations only)
- Remaining score caps are genuine food capture gaps or incomplete L0 coverage, not false `bad_l0`

## Full emergent (unpinned `base_anchor`)

Run only after this pilot and unpinned `score_site` / `rank_candidate_pads` tests stay green
(`scripts/tests/test_genesis2_lib.py`).

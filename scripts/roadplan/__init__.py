"""roadplan — planner-side survey/route powertool (adaptive road planning).

Package layout (docs/planning/adaptive-road-planning.md §6, §8.0):
  spec.py     — walkability spec loader (single source: data/walkability-spec.json)
  fixtures.py — synthetic terrain fixture builders (Track F)
  solver.py   — K2 route solver kernel (pure: samples -> Route)
  refine.py   — K3 refine-targeting kernel (pure: route + samples -> requests)
  ledger.py   — survey ledger IO (§5: samples.jsonl + state.json)
  cli.py      — `roadplan` powertool (§6): ingest / solve / render
"""

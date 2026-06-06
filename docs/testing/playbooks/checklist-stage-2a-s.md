# 2a-S substrate checklist

- [x] `data/playbooks/registry.yaml` with `phases[]` verb lists
- [x] `mc playbook phase set` / `phase clear` → `ctx.runtime.playbook_context`
- [x] Auto-clear on `task_context` card_id change
- [x] JSONL chokepoint (`logNavEvent`) on sync POST
- [x] `scripts/kanban` rejects unknown `playbook:` in card body
- [x] `scripts/nav-telemetry.py --live --compliance`
- [x] `regenerate-artifacts.sh` playbook → skills sync (run after doc edits)
- [x] Live Waves 1–4 gate ([playbook-pass-test-procedure.md](test-procedure.md)) — JSONL profile fix in `c82e882`
- [x] Worker SOUL + kanban-worker doctrine (**2a-V**)
- [x] `includes/chop-oak-8/` + A1/A2/A3 agent-test specs
- [x] [baseline-turns-fixture.md](fixture-baseline-turns.md) — pilot n=1 recorded; medians n≥5 open
- [x] Wave 5 pilot: **A2/A3 PASS** (n=1); A1 matrix still open
- [x] **Stage 2b:** `pillar_up_safe` + `wood.chop` ascend phases; A4 `chop-composition.yaml`

**Test procedure:** [playbook-pass-test-procedure.md](test-procedure.md)

Exit: A2/A3/A4 regressions; A1 medians (n≥5); Stage 4 % or genesis.

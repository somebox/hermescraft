# 2a-S substrate checklist

- [x] `data/playbooks/registry.yaml` with `phases[]` verb lists
- [x] `mc playbook phase set` / `phase clear` → `ctx.runtime.playbook_context`
- [x] Auto-clear on `task_context` card_id change
- [x] JSONL chokepoint (`logNavEvent`) on sync POST
- [x] `scripts/kanban` rejects unknown `playbook:` in card body
- [x] `scripts/nav-telemetry.py --live --compliance`
- [x] `regenerate-artifacts.sh` playbook → skills sync (run after doc edits)
- [x] Live Waves 1–4 gate ([playbook-pass-test-procedure.md](playbook-pass-test-procedure.md)) — JSONL profile fix in `c82e882`
- [x] Worker SOUL + kanban-worker doctrine (**2a-V**)
- [x] `includes/chop-oak-8/` + A1/A2/A3 agent-test specs
- [x] [baseline-turns-fixture.md](baseline-turns-fixture.md) stub (fill medians after A1 matrix)

**Test procedure:** [playbook-pass-test-procedure.md](playbook-pass-test-procedure.md)

Exit: run A1 matrix (≥5× per arm), fill baseline-turns § fixture, then treat Wave 5 as gate.

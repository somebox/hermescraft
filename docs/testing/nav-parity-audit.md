# Nav parity audit (lean arena)

Node coverage for reachability enrichment lives in
[`bot/test/runtime/nav-brief-repair.test.js`](../../bot/test/runtime/nav-brief-repair.test.js)
(`walkable_to_target`, `next_hop_suggestion` on blocked GoalNear paths).

## Arena modules removed or shrunk (2026-06-24)

| Former module | Action |
|---------------|--------|
| `test_stall_reachability.py` | **Deleted** — F74 fields covered in nav-brief-repair |
| `test_nav_reachable.py` | **Deleted** — head_blocked / standable hints in Node + one goto_near smoke |
| `test_goto_near_reachability.py` | **Shrunk** — kept reachable `walkable_to_target=true` smoke only |
| `test_movement_precondition.py` | **Kept** — live intercept/precondition flag still integration-only |

## Safe future cuts

- `test_movement_precondition.py` — drop `test_status_clears_precondition_flag` if status shape gets Node contract tests.
- `test_goto_near_los.py` — compare with interact/through LOS modules before further cuts.

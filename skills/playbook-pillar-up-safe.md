---
playbook: pillar_up_safe
subplay: true
---

# pillar_up_safe (sub-play)

Pillar up `count` blocks using `block`, with a lateral walkability check each step. Used via **`use_playbook:`** from parent phases (e.g. `wood.chop_tall_tree` **ascend**). References `skills/minecraft-navigation.md` / kanban-worker escape primitives for `BOT_ON_PILLAR`.

| Phase | Goal | Preflight | Verify | Allowed verbs (summary) |
|---|---|---|---|---|
| check_lateral | Walkable side cell at planned height | scene | `safe_side` set | scene, inspect, nearby, status |
| place_then_step | Place + climb one block | block in inv | Y += 1; lateral exit still open | pillar_up, place, scene, inspect |
| loop_until_target | Repeat until count | placed < count | placed == count | (same as place_then_step) |

**Invocation (parent worker):**

```bash
mc playbook phase set wood.chop_tall_tree ascend --sub-playbook pillar_up_safe --sub-phase check_lateral
# … run sub phases …
mc playbook phase set wood.chop_tall_tree ascend   # clear sub_* when sub completes
```

**Branches:** `BOT_ON_PILLAR` → re-run `check_lateral` one cell laterally; if still blocked after one retry, checkpoint `SUBPLAY_FAILED` on parent. Do not bubble to parent until sub-play exhausts lateral retry.

**Checkpoint (nested under parent `[run_state]`):**

```yaml
sub:
  playbook: pillar_up_safe
  phase: place_then_step
  completed: [check_lateral]
  context:
    placed: 2
    target: 4
```

Agent-test: use `scripts/kanban comment` for `[run_state]`; bind sub telemetry with `--sub-playbook` / `--sub-phase` on `mc playbook phase set`.

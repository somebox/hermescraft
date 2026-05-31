---
playbook: wood.chop_tall_tree
---

# wood.chop_tall_tree

Procedure detail: `references_skill: minecraft-mining` (§ Surface strip / wood SUPPLY). **Stage 2a** uses the flat path below; **Stage 2b** adds survey + **ascend** (`use_playbook: pillar_up_safe`) for tall trunks.

## Flat path (Stage 2a — A1/A2/A3 fixtures)

Skip **tree_survey** and **ascend** when the trunk is reachable from the ground (single-tree landfolk-test arenas).

| Phase | Goal | Preflight | Verify | Allowed verbs (summary) |
|---|---|---|---|---|
| preflight | Tools + plan | inventory, craft_plan, equip, chest_search | axe + scaffold ready | read-only prep verbs |
| approach | Reach trunk base | status | at tree footprint | move, status, scene, inspect |
| chop_loop | Fill quota | — | log count in inv/chest | dig, collect, pillar_down, move, place |
| closeout | Deposit + close | — | chest snapshot | move, deposit, list_container, status |

## Composition path (Stage 2b — A4+)

When `inputs.tree` height exceeds reach from ground, run **tree_survey** then **ascend** before **chop_loop**.

| Phase | Goal | Preflight | Act | Verify |
|---|---|---|---|---|
| preflight | Ready | inventory (axe + scaffold ≥ height) | equip / craft_plan | axe held |
| approach | At trunk base | status | move to tree | inspect trunk log |
| tree_survey | Measure trunk | — | scene, find_blocks, inspect column | `trunk_logs_seen`, `scaffold_side` |
| ascend | Reach canopy | scaffold in inv | **`use_playbook: pillar_up_safe`** `{ count, block, side_check: every_block }` | Y high enough to dig top logs; not standing on trunk |
| chop_loop | Collect quota | — | dig/collect top-down | count ≥ target |
| closeout | Deposit | — | move, deposit | chest delta |

**Ascend act row (documentation — worker interprets):**

```
use_playbook: pillar_up_safe
inputs: { count: trunk_logs_seen - 1, block: scaffold_block, side_check: every_block }
```

While inside the sub-play, set telemetry:

`mc playbook phase set wood.chop_tall_tree ascend --sub-playbook pillar_up_safe --sub-phase <sub_phase>`

## Ritual

`mc task_context set … --card $HERMES_KANBAN_TASK` → `mc playbook phase set wood.chop_tall_tree preflight` → walk phases → `[run_state]` at boundaries → `mc playbook phase clear` on complete/block.

**Kanban / board:** Production: `kanban_comment`, `kanban_block`, `kanban_complete`. Agent-test: **`scripts/kanban`** (no `kanban_*` tools).

**`mc scene`:** `mc scene [range]` only — no coordinate positionals.

## Checkpoints

Parent:

```yaml
[run_state]
playbook: wood.chop_tall_tree
phase: chop_loop
completed: [preflight, approach, tree_survey, ascend]
context:
  chopped: 0
  target_logs: 8
  tree: { x: 55, y: 65, z: 50 }
  trunk_logs_seen: 8
```

Nested sub (during ascend):

```yaml
sub:
  playbook: pillar_up_safe
  phase: place_then_step
  context:
    placed: 3
    target: 4
```

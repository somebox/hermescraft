---
playbook: wood.chop_tall_tree
---

# wood.chop_tall_tree (flat v1)

Procedure lives in `references_skill: minecraft-mining`. This doc is routing + verify + checkpoint only.

| Phase | Goal | Preflight | Verify | Allowed verbs (summary) |
|---|---|---|---|---|
| preflight | Tools + plan | inventory, craft_plan, equip, chest_search | axe + scaffold ready | read-only prep verbs |
| approach | Reach trunk base | status | at tree footprint | move, status, scene, inspect |
| chop_loop | Fill quota | — | log count in inv/chest | dig, collect, pillar_down, move, place |
| closeout | Deposit + close | — | chest snapshot | move, deposit, list_container, status |

Run ritual: `mc task_context set …` → `mc playbook phase set wood.chop_tall_tree preflight` → walk phases → `mc playbook phase clear` on complete/block.

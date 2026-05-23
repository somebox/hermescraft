# Goal profile exercises (schema coverage)

These profiles are **design references** for future presets. They validate that the goal schema (id, metric, targets, priority, constraints, strategies) can express defender, builder, and miner roles without new primitive commands.

## Shared schema notes

- **metric** — must be computable from bot state (inventory, nearby, chest snapshots, marks). Some metrics may require new evaluators in `bot/lib/goals/engine.js` before a preset ships.
- **preempt_class** — `critical` for defense/survival; `normal` for logistics.
- **strategies_available** — hints for the LLM, not automatic planners.

## Archer / defender

| id | metric (concept) | target | priority | preempt | strategies (examples) |
|----|-------------------|--------|----------|---------|------------------------|
| `defend_base` | threat_score → 0 | min 0, ok 0 | 95 | critical | kite, hold_high_ground, retreat_indoors |
| `keep_arrows_stocked` | arrow count (inv + cache) | min 192, ok 256 | 75 | normal | craft_fletcher, gather_flint_feather, withdraw |
| `maintain_food` | food_score | min 48, ok 64 | 70 | high | hunt, cook, withdraw |
| `maintain_bow` | best bow durability % | min 20%, ok 40% | 65 | normal | repair, craft_spare, withdraw |

## Builder

| id | metric (concept) | target | priority | preempt | strategies (examples) |
|----|-------------------|--------|----------|---------|------------------------|
| `base_integrity` | damage/issue count from assess | min 0, ok 0 | 85 | high | repair_plan, replace_blocks |
| `expand_structure` | blueprint progress % | min 100, ok 100 | 60 | normal | place_scaffold, batch_craft |
| `maintain_materials` | composite: planks, glass, concrete powder | per-material mins | 55 | normal | bulk_smelt, quarry_mark |
| `beautify` | decorative score / checklist | low urgency | 35 | normal | optional trim, lighting |

*Note: `expand_structure` / `beautify` assume long-lived task leases and optional player-defined blueprints.*

## Miner

| id | metric (concept) | target | priority | preempt | strategies (examples) |
|----|-------------------|--------|----------|---------|------------------------|
| `supply_iron` | iron_ingot in base chest | min 32, ok 64 | 80 | normal | branch_mine, smelt, deposit |
| `supply_coal` | coal + charcoal proxy | min 64, ok 128 | 65 | normal | strip_branch, wood_charcoal |
| `supply_diamond` | diamond in chest | min 8, ok 16 | 70 | normal | deep_mine, fortune_path |
| `maintain_tools` | pickaxe durability % | min 35%, ok 60% | 75 | normal | craft_repair, spare_pick |
| `explore_caves` | new ore marks / chunk novelty | qualitative | 40 | normal | map_cave, mark_veins |

## Relation to `gatherer` preset

The shipped `data/goal-presets/gatherer.json` covers **logs, food, stone, tools, survival, and threat**. The tables above extend the same pattern with chest-bound and role-specific metrics; add evaluators before freezing JSON presets.

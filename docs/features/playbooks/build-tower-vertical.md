---
playbook: build.tower_vertical
---

# build.tower_vertical (Wave 6 lab — not Steward default)

Raise vertical structure at fixed anchors using **`pillar_up_safe`** where needed.
**W6-T1 (2026-05-31):** Flash prose-skilled wins on cost for single-column task —
Steward should use **prose-skilled** card bodies for simple build, not this id.
Registry + doc remain for agent-tests and future ritual-cost experiments.

## Modes

| mode | Task | Agent-test |
|------|------|------------|
| `column` | One anchor, `count` blocks up | `tower-reuses-pillar-up-safe` |
| `platform_coarse` | Four corner pillars + 3×3 floor | `tower-platform-3x3` (coarse arm) |

## Phases (registry)

| Phase | Goal | Preflight | Verify | Allowed verbs (summary) |
|---|---|---|---|---|
| preflight | Cobble in inv, clear feet | inventory | cobble ≥ count | inventory, equip, status, playbook_phase_set |
| approach | Adjacent to anchor base | status | within 2 blocks of anchor | move, goto, goto_near, status, scene, playbook_phase_set |
| raise | Sub-play pillar to target height | scene | sub-play complete | pillar_up, place, scene, playbook_phase_set (+ sub-play) |
| verify | On top block, column full | scene | Y ≥ target; block at column top | scene, inspect, status, playbook_phase_set |
| closeout | Task done, phase clear | — | playbook cleared | status, playbook_phase_clear |

**Coarse card (3 phases):** merge approach into raise; skip explicit verify
(use closeout + agent-test predicates only).

**Platform coarse (W6-T3):** preflight → **build** (four corners via sub-play, then floor) → closeout.

**Sub-play invocation (raise / per corner):**

```bash
mc playbook phase set build.tower_vertical raise \
  --sub-playbook pillar_up_safe --sub-phase check_lateral
# … run sub phases (count=6, block=cobblestone) …
mc playbook phase set build.tower_vertical raise
```

**Inputs:** `anchor` (x,y,z base cell), `count`, `block` (default cobblestone).

**References:** `skills/playbook-pillar-up-safe.md`, `skills/minecraft-building.md`,
`skills/minecraft-navigation.md`.

**Checkpoint `[run_state]`:** A3-style resume on platform — see `prose-skilled-resume` arm in `tower-platform-3x3.yaml`.

# `scripts/kanban` — board write facade

The `scripts/kanban` wrapper is the canonical write surface for the `landfolk-ops` kanban board. SOULs, skills, and operator scripts target it instead of raw `hermes kanban`.

## Why it exists

The `hermes kanban` CLI's `--parent` flag overloads two semantically distinct relationships:

1. **Real prerequisite** — "child cannot start until parent is done" (`[CRAFT] iron pickaxe` waiting on `[SUPPLY] iron`).
2. **Epic membership** — "this card is part of phase P2's work."

The dispatcher's promote check (`_undone_parents_exist` in `plugins/landfolk/landfolk/orchestrator/promote.py`) treats every link as case (1). When Steward filed `[SCOUT]` children with `--parent t_<epic_id>`, the SCOUTs stayed in `todo` because the P2 epic was `ready` (forever — it's an orchestrator-continuous card). Dispatcher idled; bots sat at base. Observed multiple times in genesis runs through 2026-05-27.

The facade splits the flag in two:

| Flag | Storage | Promotion effect |
|---|---|---|
| `--epic <id>` | Body trailer (`\n---\nepic: <id>\n`) | None. Child promotes immediately. |
| `--depends-on <id>` | `task_links` edge | Child stays `todo` until `<id>` is `done` or `archived`. |

`--parent` is not exposed by the facade — the failure mode is architecturally inexpressible.

## Verb reference

```
scripts/kanban create "<title>" --assignee X
                       [--epic <id>]              # body-trailer membership tag
                       [--depends-on <id>]...     # real prereq, repeatable
                       [--body "..."]
                       [--priority N]
                       [--skill <name>]...
                       [--triage]
                       [--max-retries N]
                       [--idempotency-key K]
                       [--json]
scripts/kanban list [--status X] [--assignee Y] [--epic Z]
scripts/kanban show <id> [--json]
scripts/kanban complete <id> [--result "..."]
scripts/kanban block <id> "<reason>"
scripts/kanban unblock <id>
scripts/kanban reassign <id> <profile>
scripts/kanban assign <id> <profile>              # alias of reassign
scripts/kanban comment <id> "<text>"
scripts/kanban archive <id> [<id>...]
scripts/kanban depends-add <child> <parent>
scripts/kanban depends-remove <child> <parent>
scripts/kanban dependencies <id> [--json]
scripts/kanban epic-of <id>
scripts/kanban epic <epic_id> [--json]
scripts/kanban list-epics [--json]
```

## When to use each create flag

| Situation | Right flag | Wrong flag (and why) |
|---|---|---|
| `[SCOUT]` child of `[EPIC] [GENESIS:P2]` | `--epic t_<P2_id>` | `--depends-on t_<P2_id>` would wedge the SCOUT — the epic stays `ready` for the whole phase. |
| `[SUPPLY] 64 oak` after a scout registered `lt_wood_ne` | `--depends-on t_<scout_id>` | `--epic` only would let the supply start before the scout marks the location. |
| `[CRAFT] iron pickaxe` needing 3 iron ingots from a supply | `--depends-on t_<supply_id>` | (and probably also `--epic` if the craft is part of a phase) |
| `[RESCUE_DISPATCH]` triggered by a `[RESCUE_REQUEST]` | `--depends-on t_<request_id>` | |
| Splitting a 120-unit `[SUPPLY]` into 4 chunks of 32 | Neither — chunks are sibling-independent; the plugin's mutex park keeps them serial on the same bot. | `--depends-on` between siblings is unnecessary and slows recovery if one chunk fails. |
| A `[BUG]` filed during a passback | `--depends-on t_<passback_id>` | The passback can't resume until the bug is fixed. |

## Examples

```bash
# Default board read (lean) — see scripts/board for the dashboard view
scripts/kanban list --status ready,running

# Steward filing a SCOUT under P2
scripts/kanban create "[SCOUT] Locate wood source near base" \
  --assignee flint --epic t_e7547df1 --priority 50 \
  --body "Find oak >=32 logs within 200 blocks of base. Mark lt_wood_DIR. Chat findings."

# Then filing the SUPPLY that depends on the scout's mark
scripts/kanban create "[SUPPLY] 64 oak from lt_wood_ne" \
  --assignee flint --epic t_e7547df1 --depends-on t_<scout_id> --priority 40

# Inspect the wedge state of a card (what's blocking promotion?)
scripts/kanban dependencies t_<card_id>

# Which epic does this card belong to?
scripts/kanban epic-of t_<card_id>

# Show an epic + all its members + dep-children
scripts/kanban epic t_e7547df1

# Fix a misfiled card after the fact (the recovery path for tonight's bug):
scripts/kanban depends-remove t_<wedged_child> t_<epic_id>
scripts/kanban comment t_<wedged_child> "removed epic-as-dep; promotes next tick"
```

## Implementation notes

- **Writes** shell out to `hermes kanban` so events table, claim_lock, and `recompute_ready` cascades stay consistent.
- **Reads** open `~/.hermes/kanban/boards/landfolk-ops/kanban.db` read-only via SQLite. Faster, and lets dep+status be joined in one query.
- **Epic membership is greppable from the body** — the trailer survives Hermes upgrades, partial migrations, and operator hand-editing.
- The facade `create` always sets `--json` on the underlying `hermes kanban create` so the new task id can be returned even when calling without `--json` ourselves.

## Coexistence with raw `hermes kanban`

Raw `hermes kanban` remains callable for verbs the facade doesn't wrap (`specify`, `decompose`, `dispatch --dry-run`, `tail`, `runs`, `stats`) and for incident response. SOULs and skills reference the facade by default — see `prompts/landfolk/steward.md` and `skills/kanban-worker.md`. A future move (not yet shipped) would PATH-stub `hermes kanban create --parent` to make the failure mode impossible even from raw shells.

## Tests

```bash
uv run --with pytest --with pyyaml python -m pytest scripts/tests/test_kanban_facade.py -v
```

21 tests cover trailer parse/attach round-trips, DB query helpers, and the substring-avoidance behavior of `_scan_epic_children` (`epic: t_epic` must not match `epic: t_epic_extended`).

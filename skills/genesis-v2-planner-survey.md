# genesis-v2-planner-survey

Read-only planning/orchestration guidance for `colony-planner` and
`colony-overseer` on board `genesis-v2`.

## Scope

- You are bodiless. Do not run mutating world verbs.
- Use board state + worker comments as primary truth.
- Decompose and supervise; workers execute.

## Canonical board surface

Use these commands only:

- `scripts/kanban board`
- `scripts/kanban epic <id>`
- `scripts/kanban card <id>`
- `scripts/kanban add ...` (or `kanban_create`)
- `kanban_comment`, `kanban_block`, `kanban_complete`

Do not use raw SQL / `sqlite3` against kanban DB.

## Assignee routing (genesis-v2)

Route worker cards only to:

- `colony-scout`
- `colony-gatherer`
- `colony-builder`
- `colony-farmer`
- `colony-miner`
- `colony-road`

Never route genesis-v2 work to landfolk roles (`flint`, `mason`, `steward`, etc.).

## Planner hard rules

0. Before filing worker cards, `skill_view genesis-v2-worker-card-schema` — v1 fields
   are mandatory for body-using cards (see skill for kind taxonomy vs `card_kinds.py`).
   For **`[SUPPLY]`**, paste the SUPPLY template from that skill and edit placeholders only.
1. Worker cards must contain literal `mc <verb> <args>` lines.
2. Do not set a `skills` field on worker cards.
3. Every body-using worker card starts with `mc bot checkout ...` and ends with
   `mc bot release`.
4. Do not complete worker cards yourself; complete only planner-owned cards
   (`[MISSION]`, `[GENESIS2:SUPERVISE]`, planner `[FEEDBACK]` turns).
5. Before filing a new card, check for existing same-purpose cards to prevent duplicates.
6. Before `kanban_complete` on a mission turn, run
   `HERMES_KANBAN_BOARD=genesis-v2 scripts/kanban validate-board --status ready,todo`
   and fix failing worker cards.

Card kinds: prefer `CONSTRUCT`, `MINE`, `TILL`, `SUPPLY`, `SURVEY` from
`scripts/lib/card_kinds.py`; classify mining intent by body/title even when kind is
`SUPPLY`. Details: `genesis-v2-worker-card-schema`.

## Handoff and continuity

When creating a card that depends on a prior sibling card, place this first line
in the new card body:

`Continues from <prior_id>: run scripts/kanban card <prior_id> and read HANDOFF before acting.`

## Stuck worker handling

If a worker appears stuck:

1. Read the worker card via `scripts/kanban card <id>`.
2. If progressing, comment why and complete the supervise card.
3. If blocked, `kanban_block` the worker with a precise reason and file one smaller
   replacement card (same assignee family).

Avoid live-debugging via ad-hoc terminal command loops on active bodies; use board
comments and run artifacts for evidence.

# Worker board proxy + Steward kanban redesign

Status: **Commit A shipped 2026-05-29.** Commit B (Steward verbs + read views +
chat→comment + Steward SOUL rewrite + replay test) is queued.

Companion files: `/Users/foz/hermescraft/scripts/wb`,
`/Users/foz/hermescraft/scripts/migrations/add_card_meta_cols.py`,
`/Users/foz/hermescraft/scripts/tests/test_board_environment.sh`. Plan of
record: `~/.claude/plans/investigate-the-open-points-wondrous-karp.md`.

## Problem

The current kanban surface conflates three vocabularies — **kanban**
(todo/ready/running/done), **dependency-graph** (real prereq edges), and
**product-management** (epic membership) — onto a single `hermes kanban
create --parent` flag. Steward and worker SOULs both have to remember which
meaning is in play at the moment they write the flag.

The conflation has wedged the dispatcher in three observed genesis runs:

- `g-2026-05-27-10`
- `g-2026-05-27-N`
- `g-2026-05-28-4 round 9`

Each followed the same shape: Steward (or a worker) called `hermes kanban
create --parent <epic_id>`, the dispatcher then refused to promote the new
card because the parent epic was in a state that gated the child, and the
operator had to manually unstuck the board.

Smoking-gun fact: today's Steward SOUL (`prompts/landfolk/steward.md:68`)
carries a dedicated warning section titled

> `### NEVER type hermes kanban create --parent from your terminal`

…followed by 14 lines of "if you're about to type this, stop and use the
facade instead". **The warning's existence IS the bug.** If a CLI surface
needs an in-prose interdiction to be safely usable by an LLM, the surface
is wrong, not the LLM. Worker SOULs carry parallel warnings; `skills/
kanban-worker.md:590` repeats it.

The redesign removes the warning's reason for existing by removing the
flag from the worker surface entirely, and by re-shaping the Steward
surface around state transitions (verbs that describe what is happening)
rather than around `create + flags`.

## Solution: split by role

The kanban surface is now split by **who is using it**, not by syntax:

| Role | CLI | Scope |
|---|---|---|
| Workers (flint, mason, future profiles) | `scripts/wb` | Five verbs scoped to the active card. Cannot create cards, cannot edit titles or priorities, cannot wire dependencies. The wedge bug becomes structurally unreachable. |
| Steward | `scripts/kanban` (action-verb redesign in Commit B) | Full board authority — create, decompose, assign, promote, complete, block, unblock, archive, edit graph edges. |
| Operators / scripts | `scripts/kanban` | Same as Steward. |
| Hermes plugins, dispatcher | direct DB via `hermes_cli.kanban_db` | Unchanged. |

Workers see only what their card needs to do its job: card body + epic
title + sibling titles/status. They never see another card's body, never
see the epic's full description beyond a 3-line summary, never see the
full event log. This is a scope-lock, not a permission boundary — the DB
allows more, the CLI just refuses to expose it.

**Architectural invariant: no patches to Hermes.** All extensions live
under `scripts/`, `plugins/landfolk/`, and the bot layer. The kanban DB
schema is extended additively (nullable columns) via a migration script
under `scripts/migrations/`. If Hermes upstream changes its CLI, the
worst case is `scripts/wb`'s write verbs (which shell out to
`hermes kanban`) break — reads stay healthy because they go straight to
sqlite.

## Worker verbs

`scripts/wb` (Python, paralleling `scripts/kanban` shape). Active card id
is read from `$HERMES_KANBAN_TASK` (set by Hermes when the dispatcher
spawns the worker); `--task <id>` overrides for ad-hoc invocation.

```
wb context [--json]              # active card + epic + siblings + (best-effort bot pose)
wb comment "<text>"              # append a comment
wb close   [--result "..."]      # mark the card done
wb block   "<reason>"            # park the card; status stays running, lane → blocked
wb escalate "<reason>"           # like block but prefixes "[!ESCALATED] " for Steward review
```

### `wb context` — the orient command

One call replaces three legacy steps (`kanban_show` + `mc status` +
`kanban list-epics --epic <id>`). It returns:

- The active card: title, body, status, assignee, priority, size, location
- The parent epic: title + status + 3-line body summary
- Up to 12 sibling cards in the same epic: id, title, status, assignee
  (titles/status only — bodies deliberately not selected)
- Last 5 comments on the active card
- Best-effort bot pose from the local Steve API at `:3001/status` (degrades
  silently to `None` if the bot isn't running yet)

Epic membership is resolved from the body trailer (`epic: <id>`); falls
back to the first `[EPIC]`-marked parent in `task_links`. Both resolution
paths are read-only against the DB.

Output is rendered to text by default, or JSON with `--json` for piping
into other tools (e.g. a worker's first turn could pipe `wb context --json`
into a brief-state summarizer).

### `wb comment "<text>"`

Appends a comment. Author is set by `hermes kanban` to the worker profile
running the call. Use it for narration (what you're about to do, what you
saw, why you're picking option B over A) and for handoffs.

### `wb close [--result "..."]`

Marks the card `done`. Optional `--result` is short prose attached as the
closing event payload — Steward's `kanban board` (Commit B) renders it
inline in the RECENT lane.

### `wb block "<reason>"`

Parks the card with a structured reason. The dashboard maps `kanban_block`
events to a BLOCKED lane (mapping at `dashboard/lib/kanban.js:24`); the DB
status stays `running`. Workers use the same reason prefixes documented in
the kanban-worker SKILL: `region_blocked:…`, `task_spec_invalid:…`,
`review-required:…`, etc.

### `wb escalate "<reason>"`

The new verb. Records a `kanban_block` event whose reason is prefixed
`[!ESCALATED] `. No schema change required — Steward's forthcoming
`kanban board` view scans block events for the prefix and surfaces them
in a NEEDS REVIEW lane separately from ordinary blocks.

Workers prefer `escalate` over plain `block` when they want Steward's
attention rather than the dispatcher's retry loop: mis-specified card,
world doesn't match the body (bedrock under the build pad, no trees in
the named scout site), asking for reassign or re-decompose.

## Schema additions

Migration: `scripts/migrations/add_card_meta_cols.py`. Idempotent. Adds
four nullable columns to the `tasks` table:

| Column | Type | Source | Purpose |
|---|---|---|---|
| `location_x` | `INTEGER NULL` | Steward sets on card creation | Locality-aware dispatch — pick the nearest idle worker |
| `location_y` | `INTEGER NULL` | Steward | as above |
| `location_z` | `INTEGER NULL` | Steward | as above |
| `size` | `TEXT NULL` | Steward; CLI validates `S|M|L|XL` | T-shirt sizing for effort calibration |

All four are nullable; existing reads/writes are unaffected by the
migration. The CLI validates the `size` enum at write time; the DB
deliberately does not constrain the column so future sizes (or freeform
notes) don't require a schema change.

**Why size is text, not minutes.** Time estimates are LEARNED from actual
`created_at` → `completed_at` deltas, not from a hardcoded minute mapping.
A rolling median over the last 20 closures at the same size is the right
ballpark; the live data adapts to the world (overworld mining is slower
than nether mining, etc.) without anyone having to maintain a lookup
table. The `size` column is just the grouping key.

**Default size is M.** When Steward forgets `--size` on `kanban add`, the
CLI defaults to M and logs `(size defaulted to M)` to stderr. Steward
soul guidance (Commit B) will encourage breakdown to S over time —
smaller cards make the rolling-median estimate more reliable.

## Escalation pattern

`wb escalate "<reason>"` reuses the existing `kanban_block` event
mechanism with a marker prefix:

```
event.body = "[!ESCALATED] " + reason
```

This avoids a new event type or a new column. The marker scans cheaply
(`LIKE '[!ESCALATED]%'`) and Steward's `kanban board` (Commit B) splits
the BLOCKED lane into BLOCKED proper and NEEDS REVIEW based on the
prefix. Steward's response verbs (Commit B):

- `kanban resolve <id>` — clear the escalation; card returns to `ready`
  or `running` depending on prior state
- `kanban comment <id> "<text>"` — answer the worker without unblocking

The pattern is similar to how `[SUPPLY]`, `[SCOUT]`, `[BUG]`, `[EPIC]`,
`[GENESIS:Pn]` title prefixes already segment the board. Same instinct,
just at the event-body level instead of the title.

## Chat → comment auto-capture

Shipping in parallel (P4) under a separate agent. Design summary:

When a worker references a card id in chat (regex `\bt_[a-f0-9]{8}\b`),
the bot layer auto-records the chat line as a comment on that card.
Filters:

- Message must be ≥5 words (drops error-message-quoting noise)
- Sender must be the bot itself, not an overheard line being relayed
- Card id must exist in the same board (cheap sqlite SELECT)

On match, insert a comment with `author=<bot_user>` and body prefixed
`[via:chat]`. Wired into `bot/server.js` near the existing chat hook;
the DB write is delegated to `scripts/lib/kanban_chat_comment.py`
(child_process spawn, fire-and-forget so chat handling never blocks).

Effect: cross-bot coordination ("flint i'm at the chest if you need axe
handover") that happens to reference a card id gets attached to that
card automatically. Steward can read back later without trawling chat
logs.

## Pre-flight verification harness

`scripts/tests/test_board_environment.sh`. Runs in ~1.3s on a clean
checkout. Designed to be called by `scripts/genesis.sh` before bots
come up, so a fresh genesis doesn't waste a cycle discovering the CLI
is broken or the DB is missing a column.

Eight checks (commit-A scope — Steward-side checks arrive in Commit B):

1. `scripts/wb --help` exits 0 and shows the docstring
2. `wb context` with no `HERMES_KANBAN_TASK` fails with an error that
   mentions the env var name
3. `wb --task <bogus> context` against the live DB fails with a clear
   "no card" message
4. The live landfolk-ops DB has the four card-meta columns
5. The migration is idempotent: rerunning adds nothing
6. `scripts/kanban --help` exits 0 (legacy Steward CLI still operational
   during the transition)
7. `scripts/tests/test_wb_environment.py` passes
8. `scripts/tests/test_card_meta_migration.py` passes

Exit 0 = ready. Exit 1 = at least one check failed, with the failing
check identified in the output.

## Open work (Commit B)

- **P2 — Steward action-verb redesign in `scripts/kanban`.** Verbs renamed
  around state transitions (`promote`, `complete`, `block`, `unblock`,
  `resolve`, `archive`, `assign`, `set-after` / `unset-after`, `edit`,
  `comment`). Cuts `list-epics`, `epic-of`, `dependencies`,
  `depends-add`/`depends-remove` (replaced by `set-after`). `add` defaults
  `--size` to M with a stderr note; new `--at X,Y,Z` writes the location
  columns.
- **P3 — Consolidated read views.** Three read commands fold today's
  `board` + `fleet-status.py` + `base-inventory.py` orient pass into one
  screen each:
  - `kanban board` (single-screen orient): IN-FLIGHT, READY, NEEDS REVIEW,
    BLOCKED, EPICS OPEN, RECENT. Output budget ~30 lines.
  - `kanban epic <id>`: epic body + member roll-up with size + runtime +
    learned `done est_avg` from past closures.
  - `kanban card <id>`: full card view including comment history and
    worker cognition tail.
- **P4 — Chat → comment auto-capture.** See "Chat → comment" above.
  Shipping in parallel under a separate agent.
- **P5 (Steward) — SOUL rewrite.** Swap to action-oriented verbs from P2;
  add t-shirt size guidance ("default M, aim for S over time"); add
  locality-aware dispatch hint; add an "escalation handling" section
  around the NEEDS REVIEW lane. Delete the wedge-warning section at
  `prompts/landfolk/steward.md:68-82`.
- **P7 — Genesis replay test.** Translate the kanban-related actions from
  a historical genesis run (e.g. first 30 min of `g-2026-05-28-N`) into
  the new `wb` + `kanban` verbs; replay against a clean DB; assert 0
  `--parent` errors, 0 unknown-verb errors, board state matching at each
  checkpoint.

## Skills audit

`grep -rn "hermes kanban\|--parent" skills/` results, classified. The
skill files themselves are **not edited here** — Commit B's SOUL+skill
cleanup pass does that. This audit just enumerates the surface area.

| file:line | classification | note |
|---|---|---|
| `skills/kanban-worker.md:71` | worker direction (heading) | "Read your card with `kanban_show` (tool) — not `hermes kanban show`" — heading is correct in spirit; needs reword to mention `wb context` as the primary worker path |
| `skills/kanban-worker.md:75` | worker direction | recommends `scripts/board show $HERMES_KANBAN_TASK` for cheap re-reads — replace with `wb context` |
| `skills/kanban-worker.md:236` | doc example | mentions `hermes kanban unblock <id>` in the review-required handoff flow — Steward-side action, fine to leave until P2 |
| `skills/kanban-worker.md:288` | comment/aside | "**No `--parent` chaining required for mutex.**" — true and useful context, keep |
| `skills/kanban-worker.md:573` | worker direction | warns CLI fails in containerized backends — wider scope than this redesign; keep as-is |
| `skills/kanban-worker.md:579` | doc example (mapping table) | `kanban_show ↔ scripts/kanban show <id>` table — update to add `wb` equivalents for worker rows |
| `skills/kanban-worker.md:590` | comment/aside | the canonical "`--parent` overloads both meanings, don't call it" warning — workers no longer have any path to the raw CLI, so this becomes background context rather than active interdiction |
| `skills/minecraft-steward-blueprint-plan.md:65` | Steward direction | "link via `--parent` so the dispatcher waits" — Steward-side, rewrite as `--after <id>` (P2 verb) in Commit B |
| `skills/minecraft-steward-blueprint-plan.md:158` | Steward direction | same flag in the "wrong" anti-example — rewrite alongside line 65 |
| `skills/minecraft-steward-survey.md:141` | Steward direction | `hermes kanban assignees` listing — Steward-side, fine to leave; consider `kanban assignees` alias in P2 |

Eight of ten hits are Steward-direction or doc-example; only two are
worker direction proper (`kanban-worker.md:71, 75`). Both will be rewritten
in Commit B's SOUL+skill pass.

## Constraints and non-goals

- **No patches to Hermes.** All extensions live under `scripts/`,
  `plugins/landfolk/`, and the bot layer. Schema changes are additive
  nullable columns via a migration script.
- **Workers don't see other cards' bodies.** Sibling fetch deliberately
  selects only `id, title, status, assignee`. Scope-lock by CLI, not by
  permission boundary.
- **`scripts/kanban` keeps working during the transition.** Workers
  switch to `wb` in Commit A; Steward stays on the current `scripts/
  kanban` until Commit B lands. Both surfaces share the same DB and the
  same `hermes_cli.kanban_db.connect` access path; they don't deadlock.
- **Hermes upstream CLI changes are a known risk.** `wb`'s write verbs
  shell out to `hermes kanban` for event/lock cascade consistency with
  the dispatcher. Read verbs go straight to sqlite (read-only URI) and
  are immune. If Hermes renames a state or a subcommand, the write verbs
  break but reads keep working.
- **Not in scope here**: a chat → DM bridge for workers to ask Steward
  questions, a `wb history` view of past cards, learned-time-estimate
  rendering. All deferred.

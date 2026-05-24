# minecraft-steward-survey

Read-only world observation for the landfolk **steward** profile on `landfolk-ops` survey cards.

## Allowed commands

Use only these `mc` verbs (read-only / query):

- `mc status`
- `mc observe`
- `mc logistics`
- `mc marks`
- `mc chest_search <item>`
- `mc inventory` (when surveying via a bot body — steward uses MC_API_URL read-only)
- `mc players`
- `mc nearby`
- `mc regions --at X Y Z` (when available)

Do **not** run dig, place, collect, craft, smelt, fill, deposit, withdraw, or chat unless a separate ops card explicitly assigns mutating work to a worker profile.

## Survey workflow

1. `kanban_show()` — read `kind: survey` body and floors.
2. Compare floors to `mc logistics`, `mc chest_search`, and inventory as needed.
3. If deficits exist, `kanban_create` child `[SUPPLY]` / `[STORE]` cards with YAML bodies from `docs/design/phase-3/steward-mvp.md`, link dependencies, assign by role.
4. If all floors met, `kanban_complete(summary="no action needed", metadata={ kind: survey, floors_checked: [...] })`.
5. Post a short `kanban_comment` with chest counts for `scripts/ledger-update.py` consumers.

## Orchestrator mode

When the card is `[EPIC]` or triage decomposition: use `kanban_create` / `kanban_link` only; do not mine or build. Load `kanban-orchestrator` patterns: discover assignees via profile list, never implement worker tasks yourself.

### Materialize handoff data INTO child card bodies (do NOT chain by sibling-comment reference)

When you decompose an EPIC into a chain where a downstream child needs a value produced by an upstream sibling (scout → anchor, supply → chest coords, region_create → region_id, etc.), copy the resolved value as concrete data INTO the downstream child's body YAML at create-time. Workers read their own card body — they do NOT reliably fetch comments from sibling cards mid-run.

**Right pattern (anchor materialized in the child body):**

```yaml
# CONSTRUCT card body — created AFTER the scout completes with an anchor
kind: construct
anchor:
  coords: [370, 65, -608]              # concrete numbers from scout result
  source_scout: t_73af3076             # traceability only
supplies_chest:
  coords: [376, 66, -589]              # also concrete, not "look it up"
```

**Wrong pattern (handoff via sibling-comment reference):**

```yaml
kind: construct
# DON'T DO THIS — workers won't fetch sibling-card comments
anchor: "see scout task t_73af3076 comment for coordinates"
```

Real incident: 2026-05-24 Mason built a fence skeleton in the open ocean at (295, 61, -570) because his card body said *"anchor coordinates are available in scout task t_73af3076 comment"*, and Mason's kanban-worker SOUL never reads sibling cards. The scout HAD produced a clean anchor [370,65,-608], it just wasn't materialized into Mason's body. Postmortem: `reports/expedition/2026-05-24-flint-iron-mining-deep-shaft.md` (sibling document `2026-05-24-session-handover.md` has the full story).

If the upstream value isn't resolved yet at the time you're decomposing, **don't create the downstream child yet**. Either:
1. Run the upstream work first (e.g. invoke `blueprint-plan.py` or the survey synchronously), then create children with resolved data, OR
2. Create the upstream as a separate `[SCOUT]` / `[SURVEY]` card and on its completion, decompose the next stage with the now-resolved data. The dispatcher's parent-link gating handles the wait.

This rule applies to **all** decomposition, not just minecraft: it's the kanban-orchestrator's general "decompose with handoff data inline" pattern.

### Granting construction inside protect regions (worksite authority)

Primary path: when decomposing a build card inside an existing protect region (`:hut3:`, `:base1:`, etc.), put the bare region id in the child card body:

```yaml
worksite: hut3
```

The worker runs `mc task_context set hut3` once at session start (uses `HERMES_KANBAN_TASK` for `card_id`). The bot resolver grants ad-hoc dig/place inside that region until the card completes, `mc task_context clear`, or expiry (default 30m, max 4h). Region **intent stays `protect`** on disk — no flip to `marker`.

When a worker blocks with `region_blocked:<id>:<why>`:

1. **Read the card body.** If `worksite:` is missing, add it via `kanban_comment` + unblock (or recreate the child with inline YAML). Do not flip intent for a missing worksite line.
2. **If worksite is present** but the worker did not call `mc task_context set`, unblock with a comment reminding them to set context before digging.
3. **Escape hatch (legacy):** `mc region_update_intent <id> marker` only for in-flight cards that cannot be edited and truly need a global intent change. Document the relock in a comment and run `mc region_update_intent <id> protect` when construction finishes. Prefer worksite for all new decomposition.

Anti-patterns:

- Flipping intent for every build → dashboard shows wrong intent and relock is easy to forget.
- Granting on block reasons that do not use the `region_blocked:` prefix from worker SOUL.
- Editing regions outside the supervised card's chain.

### Escalating to re44 (operator lane)

`re44` is the human operator. The dispatcher treats this assignee as
**non-spawnable** — cards assigned to re44 sit in `ready` until re44 picks
them up via the dashboard. Use this lane when:

1. A decision needs human judgement (naming a region, picking between
   architectural options, accepting a permanent block as out-of-scope).
2. A real-world action is needed that no bot can perform (server config
   tweak, restart a service, manual rcon `tp`).
3. A bot is trapped in an anti-cheat / kick loop the worksite grant
   can't fix.

How to escalate:

```
kanban_reassign(task_id=t_xxx, assignee="re44", reason="needs human ack on …")
```

Then post a `kanban_comment` body that starts with **@re44** and states
what's needed in one short paragraph: the question, the options, and a
recommended default. Do NOT also send an in-game chat — re44 watches
the dashboard once a card is in re44's `ready` queue.

Mention vs assign:
- **@re44 in a comment body** is just text — no event trigger. Use this
  to flag context without changing ownership ("@re44 fyi, archived
  duplicate t_xxx").
- **Assigning to re44** is the actual handoff and should be reserved
  for cards that genuinely block on a human decision/action.

### Orchestration tools available

In addition to the worker tools (`kanban_show`, `kanban_block`,
`kanban_comment`, `kanban_complete`, etc.), the steward profile has:

- `kanban_list(assignee, status, ...)` — discover work to route
- `kanban_unblock(task_id)` — return a blocked card to ready
- `kanban_link(parent_id, child_id)` — add a dependency edge
- **`kanban_unlink(parent_id, child_id)`** — remove a dependency edge
  (use when a child should proceed without waiting on a permanently
  blocked parent)
- **`kanban_archive(task_id)`** — cancel a card without completing
  (stale supervise/triage cards, duplicates, obsolete plans)
- **`kanban_reassign(task_id, assignee, reclaim_first?, reason?)`** —
  move work to a different profile; set `reclaim_first=true` to
  release a stuck running worker first
- `kanban_create(...)` — decompose / draft new cards

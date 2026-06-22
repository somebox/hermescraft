# Scheduled operations: orchestrator-owned cron, role-assigned work

This document captures the production-side architecture for any
ongoing operation that needs to be checked on schedule — farming,
animal husbandry, infrastructure inspection, perimeter sweeps,
shop restocking. The wheat capstone tested a single
plant→harvest cycle; that's the narrowest possible instance of
this pattern. This doc generalizes it.

If you're reading this looking for the trial-time wheat setup,
that's documented in
[`wheat-capstone-runbook.md`](../../reports/agent-arch/wheat-capstone-runbook.md)
and is intentionally simpler.

## The pattern in one paragraph

A long-running **orchestrator** profile owns one or more cron jobs
that periodically scan a registry of known operational concerns
(fields, pens, posts, shops). For each entry, it decides whether
the entry needs attention based on the entry's state, how recently
it was last checked, and any standing policy. If yes, the
orchestrator posts a card to the appropriate role's board with
priority and context attached. The dispatcher picks the card up
when a matching worker is free. The worker does the in-world
check, updates the registry, and — when appropriate — posts
follow-up cards (harvest, repair, restock). The cron itself does
no in-world work. The role-specialist does no scheduling.

## The roles

| Role | Owns | Doesn't own |
|---|---|---|
| **Orchestrator** | The registry of known concerns. The cron schedule. The priority calculation. The decision *whether* to dispatch a check. | Doing the in-world check. Visiting the field. Knowing how wheat grows. |
| **@farmer** | The in-world check: navigate to the field, observe state, harvest mature crops, replant. Updating the registry entry when done. | Knowing when next to check the field. Knowing about *other* fields. |
| **Field registry** | The persistent state of all known fields: location, type, last_checked_at, last_observed_state, current_assignee, priority hints. | Triggering anything. It's just a database the orchestrator + farmers read and write. |

Animal husbandry, shop restocking, and perimeter inspection follow
the same shape — orchestrator + role-specialist + registry — with
different registries and different worker roles.

## Why split it this way

Two reasons.

**First, narrow scope.** A farmer planting wheat at one plot
shouldn't have to know about the seven other plots, the cron
schedule, or the dispatcher's load. That violates the per-card
narrow-scope claim the architecture is built on. Conversely, an
orchestrator that scans the world to decide where to send workers
shouldn't be expected to *also* know how to till efficiently or
recognise pillaged farmland — that's the specialist's job. Keeping
each role single-domain keeps each role's context small and its
skill bundle predictable.

**Second, priority emerges from data, not from guesswork.** When
the registry tracks `last_checked_at` per field, the orchestrator
can compute priority deterministically: a field unchecked for two
days outweighs a field checked yesterday, regardless of any
individual agent's intuitions. Aging this way is how a real
operation prevents starvation of low-traffic concerns.

## The data the registry needs

Per field (and analogous per pen, per shop, etc.):

- **Location** — raw coords (`x, y, z`), dimension, and the corner
  box of the field. Raw coords, not mark names — marks can be
  renamed or removed; the field is what's durable.
- **Type** — `wheat`, `carrots`, `melon`, etc. The role bundle the
  farmer needs to load depends on this.
- **Owner** — which @-role is responsible (defaults to @farmer for
  crop fields).
- **Last checked at** — wall-clock timestamp of the last successful
  check.
- **Last observed state** — a small structured summary written by
  the most recent check: maturity counts, water present, fence
  intact, etc. The orchestrator uses this to decide whether the
  next check is urgent or routine.
- **Standing priority hint** — base importance for this field
  (manually set when the field is registered; e.g. a high-traffic
  food field outranks a decorative one).
- **Current assignment** — task id of any in-flight check, or null.
  Prevents duplicate dispatch when a cron tick happens while a
  worker is still en route.

The registry is durable and lives outside any single agent's
memory. Most likely a kanban tenant or a sqlite under the
orchestrator's HERMES_HOME — the choice is an implementation
detail. The contract is just that any orchestrator can read and
write any entry.

## Priority and aging

**Not dispatcher bind priority.** Weighted `standing_hint + aging_term + state_urgency` here applies only to the **cron orchestrator's field registry** — which check cards to file. Kanban **body bind** at MVP uses the lexicographic tick in [`board-dynamics.md`](board-dynamics.md) § MVP (no weighted scorer). Card `priority` numbers sort the ready queue within a bot lane; they do not feed the orchestrator formula above.

The orchestrator computes a check-priority for every registry entry
at every cron tick. The form is roughly:

```
priority = standing_hint + aging_term + state_urgency
```

- **`standing_hint`** comes from the entry. Food fields > decorative.
- **`aging_term`** scales with time-since-last-check. Linear is fine
  to start; the point is just that ignored fields keep climbing.
- **`state_urgency`** comes from the last observed state. A field
  that was 60/80 mature an hour ago is more urgent than one that
  was 5/80 mature an hour ago — wheat will be ready *now* in the
  first case and not for another hour in the second.

Above some threshold the orchestrator dispatches a check card.
Below it, the entry waits for the next tick. The threshold tunes
the load on the worker fleet: too low → too many check cards
pile up. Too high → fields starve and rot.

A check card carries the registry entry's coords, type, role
binding, and the priority value. The dispatcher orders ready cards
by priority among the matching role, so urgent checks naturally
preempt routine ones.

## The flow end to end

1. Cron fires every N minutes on the orchestrator profile.
2. Orchestrator reads the registry, computes priority for each
   entry, picks the entries above threshold, and creates check
   cards for them on the appropriate role's board.
3. Check cards sit `ready` until the dispatcher picks them up;
   higher-priority cards go first.
4. A worker matching the role (e.g. an @farmer) claims a card.
5. The worker navigates to the field's recorded coords, observes,
   and writes a structured summary back to the registry entry
   (`last_observed_state`, `last_checked_at`, possibly
   `current_assignment` cleared).
6. If the observation reveals follow-up work — harvest, replant,
   repair fence — the worker creates the follow-up card on the
   appropriate board (could be its own role's board for
   in-domain work, or another role's for cross-domain).
7. The cron continues to fire on its own schedule. It doesn't know
   or care what the workers did between ticks.

The orchestrator is decoupled from the worker. The worker is
decoupled from scheduling. The registry is the only thing they
share.

## Failure modes worth designing for

A few that come up immediately and need explicit handling rather
than being left to the agent to guess at:

- **The field disappears.** The check arrives at the recorded coords
  and finds no wheat blocks at all. The worker writes
  `last_observed_state.field_gone = true` and creates a clarifier
  card on the orchestrator's board with the situation. The
  orchestrator decides whether to re-plant, re-survey, or
  delete the registry entry.
- **The worker can't reach the field.** Navigation fails. Worker
  blocks with `reason="route_blocked:field-N"`. The registry
  entry's `current_assignment` stays set until the block is
  resolved, so another tick doesn't dispatch a duplicate.
- **Multiple check cards stack up if no worker is available.**
  The orchestrator should refuse to create a new check card if
  the registry's `current_assignment` field is already populated.
  This is the idempotency primitive at the orchestrator level.
- **A worker crashes mid-check.** The registry entry's
  `current_assignment` would point at a stale task id. The
  orchestrator's cron should check whether the assignment's task
  is still live; if not, clear the assignment and dispatch fresh.
- **Cron itself stops firing.** All fields age toward "needs
  check" but nothing triggers. The dashboard should surface
  oldest-unchecked-age as a health signal; a separate liveness
  cron (single line, just `date` to local) is cheap insurance.

## What this means for the wheat capstone

The capstone trial proves the narrow-scope claim at the worker
level: one body can run nav, build, plant, harvest, deposit as
distinct narrow cards. The architecture described here is the
*next layer up* — operating that worker, at scale, over time,
across many concerns.

The capstone planter could become the first entry in a real wheat
registry: when x003 completes, it writes the new field into the
registry, sets `last_observed_state = {planted: true, mature: 0}`,
and sets `current_assignment = null`. The orchestrator's cron
takes over from there. The next time the cron ticks, it sees the
new entry, computes priority based on its assumed maturity timeline
plus aging, dispatches a check card when appropriate, and the
flow described above runs against that field.

The wheat capstone runbook will reference this doc once we run
the orchestrator-side trial. For now it stays out of the test
scope — too many moving parts to add at the same time as the
worker-side validation.

## Open questions to settle when we build this

These don't need answering today, but they need answering before
the first orchestrator profile ships.

- **Where does the registry live?** A dedicated kanban tenant
  (cards with structured metadata) is cheapest; a separate sqlite
  is more flexible. Probably start with kanban-as-registry and
  promote to sqlite if the metadata gets fiddly.
- **How does the orchestrator know about new fields?** Either the
  planter writes the registry entry directly at end of plant card,
  or the planter posts a "new field" notification card that the
  orchestrator picks up and adds. The direct write is simpler;
  the notification path is more auditable.
- **How does the check actually happen?** Three sub-options:
  the worker walks to the field (expensive, definitive); a remote
  observer (Tester-style) runs `mc verify` from chunk-loaded range
  (cheap, can fail outside range); or the registry just trusts
  the last bot to have visited (cheapest, can lie). Probably a
  mix: trust the cached state for low-priority routine ticks, send
  a real worker when priority crosses a threshold.
- **What's the priority threshold?** Tuning question; defaults
  come out of running the trial fleet for a week and seeing
  which fields rot.
- **Is the orchestrator a chat-facing profile or just a cron-driver
  daemon?** Two valid shapes — interactive (steward-like, you can
  talk to it about field status) vs autonomous (purely
  cron-driven, no chat surface). Probably both end up existing,
  one steward visible to users and one or more autonomous
  workers behind it.
- **What about multi-tenant fleets?** Each tenant has its own
  registry; the orchestrator instance is per-tenant. Cross-tenant
  field handoff is a separate concern.

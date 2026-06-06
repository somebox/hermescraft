# `mc verify` — predicate verb for card done-ness

**Status:** initial implementation, Session 2 of the [colony validation plan](../../reports/agent-arch/2026-06-06-colony-validation-plan.md).

## Why

The architecture distinguishes three vocabularies for "is this card done":

| Where | Vocabulary | Audience |
|---|---|---|
| Card body | `success_when:` clause | Operator / `@planner` reading what to do |
| Bot HTTP | `mc verify <predicate>` | Worker self-checking before `kanban_complete` |
| Epic metadata | `metadata.acceptance` items | `@overseer` reviewing epic completion |

`success_when` and `acceptance` are text — they sit in card bodies. `mc verify` is the verb that turns those text predicates into observable world state via the bot's HTTP API. The worker can self-evaluate; the overseer can re-evaluate.

Without `mc verify`, workers fall back to vague predicates ("complete when done") that trigger auto-stuck-check on no-state-change. The colony validation plan's Concern 2 is fundamentally "does `mc verify` close that gap."

## Grammar

```
mc verify <kind> <args...>
```

Predicate kinds for Session 2:

| Kind | Args | Returns satisfied when |
|---|---|---|
| `chest_contains` | `<mark> <item> [min_count=1]` | Chest at `:mark:` contains ≥ `min_count` of `item` |
| `inventory_contains` | `<item> [min_count=1]` | Bot's own inventory contains ≥ `min_count` of `item` |

Later sessions add: `at_mark <mark> [radius]`, `region_empty <bounds>`, `region_filled <bounds> <item>`, `chest_delta <mark> <item> <count> <since_marker>`.

## Response shape

`ok=true` means "we evaluated"; the `satisfied` field is the predicate result.

```json
{
  "ok": true,
  "data": {
    "kind": "chest_contains",
    "satisfied": true,
    "observed": {
      "mark": "storage",
      "coords": { "x": 4, "y": 65, "z": 0 },
      "item": "cobblestone",
      "count": 4
    },
    "expected": {
      "item": "cobblestone",
      "min_count": 4
    }
  }
}
```

`ok=false` is reserved for cases where the predicate cannot be evaluated:

```json
{
  "ok": false,
  "error": {
    "code": "MARK_NOT_FOUND",
    "message": "mark 'storage' not found via /marks",
    "retry_safe": false
  }
}
```

Distinguishing "we evaluated, answer is no" (`ok:true, satisfied:false`) from "we couldn't evaluate" (`ok:false`) lets workers and overseers handle each cleanly: the former is a card-state issue, the latter is a tooling/world issue.

## Error codes

| Code | When | retry_safe |
|---|---|---|
| `UNKNOWN_KIND` | Predicate kind not recognized | false (caller bug) |
| `MISSING_ARG` | Required arg missing | false |
| `MARK_NOT_FOUND` | Mark name not in `/marks` | false |
| `BLOCK_NOT_CHEST` | Block at mark coords is not a chest/container | false |
| `READ_FAILED` | Underlying world read failed (chunk unloaded, etc.) | true |

## Worker usage

A miner card with body `extract 4 cobblestone at :test_mine: and deposit at :storage:` would, before `kanban_complete`:

```bash
mc verify chest_contains storage cobblestone 4
```

If `satisfied:true`, the worker calls `kanban_complete` with the response's `observed` block as `metadata.acceptance_evidence`. If `satisfied:false`, the worker either continues working or `kanban_block`s with the predicate state in the reason.

## Overseer usage

The capstone's epic has `metadata.acceptance` listing predicates:

```yaml
metadata:
  acceptance:
    - kind: chest_contains
      mark: storage
      item: cobblestone
      min_count: 4
    - kind: inventory_contains
      item: oak_log
      min_count: 3
```

`@overseer` calls `mc verify` once per acceptance item against a worker bot, files `[BUG]` on any `satisfied:false`, approves the epic on all-satisfied.

## Implementation layering

The verb dispatches by kind into existing primitives where possible:

- `chest_contains` → reads `/marks` to resolve, then `data get block` via the bot's existing chest-read path (mirrors `mc inspect`)
- `inventory_contains` → reads bot inventory
- `region_empty`/`region_filled` → call existing `mc is_empty`/`mc is_filled`

This keeps `mc verify` thin — it's a uniform predicate surface, not a re-implementation of every primitive.

## What `mc verify` is NOT

- Not a replacement for `mc inspect` or `mc inventory` — those give full state; verify gives a yes/no with the observed slice.
- Not an LLM call — it's deterministic predicate evaluation.
- Not a card-state check — it only sees the world. The kanban DB and worker context aren't queryable through it.
- Not a substitute for AUTO_STUCK / progress checks — it's about *completion*, not *progress*.

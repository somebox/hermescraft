---
name: minecraft-perception-advise
description: "Intent-biased perception digest when stuck, starting a new gather sub-goal, or locating something. Load when mc find/scene are not enough."
triggers:
  - stuck
  - where is
  - can't find
  - blocked collecting
  - mc advise
version: 1.0.0
---

# Perception advise (`mc advise`)

Runs a **slow** (~10–35 s) LLM digest over a bundled snapshot (observe, **status=self**, **scene=world**, nearby, map). Use **sparingly** — not every round.

## When to call

Call **`mc advise --reason="<your sub-goal>"`** before acting when:

1. You are **stuck** or a path/collect failed twice for the same target.
2. You start a **new gather sub-goal** (e.g. "find oak wood", "collect grass seeds").
3. You need to **locate** something and `mc find` / `mc scene` are ambiguous.

Do **not** call advise every tick. Typical session: a few times total.

## Command

```
mc advise --reason="find oak wood"
mc advise --reason="blocked collecting wood"
mc advise --json --reason="collect grass seeds"
mc advise --dry-run --reason="test"    # HTTP bundle only, no LLM
```

`--reason` is **required**. Phrase it as the sub-goal you are trying to satisfy.

## Response (`perception_answer_v1`)

The tool returns JSON with:

- `summary` — one or two sentences
- `recommendations[]` — `kind`, `block_or_entity`, `position`, `confidence`, `rationale`
- `caveats[]`
- `nothing_actionable`

Follow the recommendations with normal `mc` commands (`move`, `dig`, `collect`, etc.). Only cite blocks/entities that appear in the digest.

## Logging

Each call is appended to `$LOG_DIR/mc-advise.jsonl` (default `/tmp/hermescraft/mc-advise.jsonl`) with reason, timing, and summary.

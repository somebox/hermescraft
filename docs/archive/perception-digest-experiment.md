# Perception digest — experiment summary and in-game MVP path

This document captures what we learned from the perception-digest integration tests (D1 mixed scene, D2 stuck pit), timing benchmarks, and how that informs an in-game “advise the main agent” layer.

See also: [perception-digest.md](../guides/perception-digest.md) (how to run tests), [tests/integration/test_perception_digest.py](../../tests/integration/test_perception_digest.py).

---

## What we tried

1. **Fixed scenes** in `landfolk-test` (rich biome vs bot in a dirt pit trying to reach nearby wood).
2. **Raw bot HTTP payloads** — typically `observe` (lean), `status`, `scene`, and for harder cases `nearby`, `map`, plus sometimes the last failed action JSON (e.g. `NAV_BLOCKED` from `goto`).
3. **External intent string** — e.g. `find oak wood`, `collect grass seeds`, `blocked collecting wood` — passed only to the summarizer, not to the bot server yet.
4. **One-shot LLM digest** (OpenRouter, `deepseek/deepseek-v4-flash`) → small JSON: `summary`, `recommendations[]`, `caveats[]`.

Same world, different intents produced different summaries (oak vs grass vs “blocked”), which is the core hypothesis.

---

## What we learned

### Raw perception is uneven

| Source | Strength | Weakness |
|--------|----------|----------|
| **lean `observe`** | Goals, task, alerts, `recent_actions`, idle reason | Little spatial detail; noisy history (chat, marks) |
| **`status` + embedded scene** | Block hits, entities, position | Large; `notableBlocks` often empty; fair-play FOV gaps |
| **lean `scene`** | Short text summary | Can miss trees/ores (D2: “grass only” while wood exists in status) |
| **`map`** | Layout, confinement (`#` around `P`), direction to `T` | No exact craft semantics; legend learning |
| **`nearby`** | Aggregates + nearest coords | Loses wall material; counts dominate |
| **Last action JSON** | Clear failure (`NAV_BLOCKED`, next-hop hint) | Not on `/status` today unless test attaches it |

**Takeaway:** No single `mc` read is enough. A **steward-style bundle** (map + nearby + status + observe) plus an explicit **reason** matches how agents already think; digest collapses that bundle for the main brain.

### Summarization works for intent filtering

- **D1 / find oak wood:** Picked `oak_log` at a plausible coord; ignored birch decoy.
- **D1 / collect grass seeds:** Shifted to grass/seeds; did not send the bot to chop oak.
- **D2 / blocked collecting wood:** Identified visible wood + path failure; with **map**, inferred enclosure/obstacle better than scene alone. Still tended to suggest more `goto` rather than `dig` / `pillar_step` / `escape` — a prompt/product gap, not a data gap.

### Cost and latency (local Tester, ~15 KB input)

- **HTTP bundle** (5 calls): ~20 ms mean.
- **Digest:** ~10–35 s per call (provider variance; reasoning tokens dominate).
- **Full pytest** (scene prep + digest): ~90 s for three cases — acceptable for regression, not per-turn in production without caching and cheaper models for sub-calls.

### Parallel sub-analysis (later)

Hermes 0.14 auxiliary calls could split map / inventory / goals into parallel digests and merge. **Deferred for MVP** — a single digest with `reason=` was enough to separate intents on D1/D2. Revisit if in-game logs show one advise answer is routinely too coarse.

---

## Why this matters for the main agent

Today the Hermes brain often:

- Polls `mc observe` / `mc status` and carries **thousands of tokens** of state, or
- Skips reads and guesses from stale context.

**Perception digest** (or **advise**) is a compression layer:

```text
Main agent: "I need to collect wood" (high level)
     │
     ▼
Advise layer (cheap model, 1–3 s target with flash + smaller bundles)
     │  parallel: map | find | inventory | goals
     ▼
Short answer: "Oak at (-10,66,4) 10m west; you're in a pit; last goto
               failed — try mc escape or dig east wall before goto."
     │
     ▼
Main agent: one or two mc verbs with clear coords (low token, fewer loops)
```

Value:

1. **Clearer context** — intent-shaped answers instead of raw JSON archaeology.
2. **Fewer wrong tools** — e.g. birch vs oak, grass_block vs short_grass.
3. **Stuck/obstacle visibility** — map + last error + position Y vs target.
4. **Main agent stays strategic** — plan and social; sub-agents or auxiliary handle “where is X?” and “what do I lack?”

---

## Possible `mc` surface (high vs low level)

We should not replace primitives (`goto`, `dig`, `collect`). Add a **query/advisory** tier:

| Style | Example | Behavior |
|-------|---------|----------|
| **Low-level** (unchanged) | `mc goto 5 64 0` | Executes; full JSON result |
| **Read** (unchanged) | `mc map 12`, `mc find oak_log` | Returns server truth |
| **Advisory** (new) | `mc advise --reason="find oak wood"` | Client-side bundle + digest; returns **perception_answer_v1 JSON** only |

### `reason=` — one place only (MVP)

- **Required** on `mc advise --reason="..."` only.
- Do **not** retrofit `--reason` onto `mc map`, `mc find`, etc. yet — extra churn for unclear win; reads stay as today.
- Models already phrase goals naturally; the advise call is where reason becomes a logged, digest-facing contract.

### Suggested digest response shape (stable contract)

Same as tests today — `perception_answer_v1`:

- `summary` (1–2 sentences)
- `recommendations[]` (`kind`, `block_or_entity`, `position`, `confidence`, `rationale`)
- `caveats[]`
- `nothing_actionable`

Main agent sees **only this** in tool result, not the 15 KB raw bundle.

---

## MVP plan (revised): ship `mc advise` first — one implementation, two callers

**Do not** ship a Hermes-only skill (old “Phase A”) and add `mc advise` later. That creates two APIs and a skill you would retire. **Collapse A + B:** build the digest pipeline once, expose it as **`mc advise --reason="..."`** from day one; the Hermes plugin tool calls the **same Python module** (import or thin subprocess to the shared helper used by the CLI).

### Why start at the CLI

1. **Unified surface** — Main-agent rule is one line: when stuck, starting a new gather sub-goal, or locating something, call `mc advise --reason=<sub-goal>` before acting. No “use this skill except when you’d use mc…”
2. **Same code path** — Bundle 4–5 HTTP reads → digest (OpenRouter today; `ctx.llm.complete_structured` when inside Hermes plugin) → `perception_answer_v1` JSON. [tests/_lib/openrouter.py](../tests/_lib/openrouter.py) + capture logic from [tests/integration/test_perception_digest.py](../tests/integration/test_perception_digest.py) move into e.g. `bot/lib/advise/` or `scripts/_lib/perception_advise.py` imported by both `bin/mc` and the plugin.
3. **`reason=` in one place** — mandatory on `mc advise` only (see above).

### Latency (10–35 s) — gating issue, not API shape

| Mode | MVP? | Notes |
|------|------|--------|
| **Synchronous + rare** | **Yes** | Agent calls advise only on stuck / new sub-goal / “where is X?”. Accept pause; **log every call** (reason, duration, summary) so you can verify it stays rare. |
| Fire-and-forget + chat / `lastAdvice` on observe | No (yet) | Better for production; harder to evaluate in a single session. Revisit after synchronous trial. |

Start synchronous so in-game behavior is legible: logs show exactly when advise ran and what the agent did next.

### Defer until there is evidence

| Item | Why wait |
|------|----------|
| **Parallel specialists** (old D) | Single digest with `reason=` already split oak vs grass on D1; add parallel only if one digest is too coarse. |
| **Caching** by (cell, reason hash) (old C) | Matters when logs show duplicate advises; not before. |
| **`mc answer` alias** | Pick `advise`; one name. |
| **Server `POST /advise`** (old C) | Keeps digest out of bot deploy until shape is proven; client-side bundle is enough for MVP. |
| **`--reason` on `mc map` / `mc find`** | Optional later; not MVP. |

### Concrete MVP cut (~1 day)

1. **`mc advise --reason="..."`** — register in [bot/cli/registry.mjs](../bot/cli/registry.mjs); implementation calls shared `perception_advise(reason)` → prints `perception_answer_v1` JSON (human-readable + `--json`).
2. **Hermes plugin tool** `perception_advise(reason)` — same function; when running in-process, prefer `ctx.llm.complete_structured` + `auxiliary.hermescraft_digest`; CLI may keep direct OpenRouter until plugin lands.
3. **One prompt line** (Landfolk/Steve): “On stuck, on a new gather sub-goal, or to locate something, call `mc advise --reason=<your sub-goal>` before acting on the recommendations.”
4. **One Landfolk session** vs no-advise baseline; log every reason string ([scripts/perception-digest-bench.py](../scripts/perception-digest-bench.py) for timing).

**Success:** advise called **2–6 times** per session, each followed by a more targeted `mc goto` / `mc dig` / etc.

**Failure:** never called, or called every tick (prompt or guardrails need tuning).

Regression unchanged: [tests/integration/test_perception_digest.py](../tests/integration/test_perception_digest.py) for bundle + JSON shape.

---

## What not to do in MVP

- Do not replace `mc find` or `mc scout` — advise **complements** them.
- Do not run advise every ReAct turn.
- Do not add server-side advise or parallel merge until the synchronous trial says so.

# Resolver semantic aliases — expand UNKNOWN_BLOCK tolerance

Status: draft / planning. No implementation yet.

## Problem

`mc find_blocks` / `mc collect` / `mc scout` reject ~91 invocations over a
5-day window with `UNKNOWN_BLOCK`. The names aren't typos — they're
**semantic mismatches** between how agents reason about the world and
the mcData id schema:

| Agent typed | What they meant | mcData reality |
|-------------|-----------------|----------------|
| `sticks` | `stick` | plural drift |
| `tree` | `*_log` (any) | concept ≠ block id |
| `village` | "go to the village" | not a block at all |
| `grass` | `short_grass` (1.20+) | renamed in newer mcData |
| `grass_path` | `dirt_path` | renamed across MC versions |
| `wheat_crop` | `wheat` | suffix drift |

Empirical evidence: see `scripts/analyze-mc-name-shapes.py` and
`scripts/analyze-mc-name-failures.py`. Of 4,587 `mc <verb> <material>`
invocations, 99.74% used canonical mcData ids — case/whitespace
normalization (the previously-considered "Path A" from the agent-
forgivingness survey) would fix exactly 0 observed failures. The
91 `UNKNOWN_BLOCK` errors all fall into the categories above.

The dominant cost is **wasted agent iterations**: a `find_blocks`
returns UNKNOWN_BLOCK → agent retries with a slightly different name
→ same failure → agent calls `mc advise` → consumes context for what
could have been a 1-line table lookup.

## Concept

Extend `bot/lib/shared/resolver.js`'s existing `QUERY_ALIASES` /
`RESOURCE_GROUPS` infrastructure to cover the observed semantic
mismatches. The resolver already handles tool/resource group concepts
(`axe`, `pick`, `wood`, `log`, `stone`) — this is the same shape of
fix applied to a wider concept set.

Three layers, in order of effort and confidence:

### Layer 1 — direct aliases for observed misses

Add to `QUERY_ALIASES`:

```js
const QUERY_ALIASES = Object.freeze({
  // ... existing entries ...

  // Pluralization (literal singular):
  sticks: { kind: 'literal_alias', target: 'stick' },

  // mcData version drift:
  grass:       { kind: 'literal_alias', target: 'short_grass' },
  grass_path:  { kind: 'literal_alias', target: 'dirt_path' },
  wheat_crop:  { kind: 'literal_alias', target: 'wheat' },

  // Concept aliases (resource_group style — first-match semantics
  // already supported by resolveBlockQuery):
  tree: { kind: 'resource_group', group: 'logs' },
});
```

Plus a **new rejection bucket** for "concept agents reach for but no
block matches":

```js
const NOT_A_BLOCK_CONCEPTS = new Set([
  'village', 'animal', 'mob', 'creature', 'monster',
  'tool', 'food', 'weapon',
]);
```

`resolveBlockQuery` short-circuits these with a clearer error than
`UNKNOWN_BLOCK`:

```
NOT_A_BLOCK: "village" is a region concept, not a block. Use
`mc scene` for spatial awareness, `mc find_entities` for villagers,
or `mc go_site :village:` if a village region is mapped.
```

### Layer 2 — auto-pluralization tolerance

When a lookup misses, try stripping a trailing `s` and re-running:

```js
if (!isKnownBlock(mcData, q) && q.endsWith('s')) {
  const singular = q.slice(0, -1);
  if (isKnownBlock(mcData, singular)) {
    return { ok: true, selected: { name: singular, reason: 'depluralized' }, ... };
  }
}
```

Conservative — only fires on miss-then-singular-hits. Doesn't change
the canonical lookup path.

### Layer 3 — mcData-version-aware aliases

`grass`/`short_grass` and `grass_path`/`dirt_path` are version-specific
renames. Long-term, a small table `MCDATA_VERSION_ALIASES` keyed by
mcData major version would resolve both forms based on what's loaded.

Defer until we either (a) actually run multiple MC versions, or (b)
see more rename pairs.

## Where this DOES NOT belong

This work is squarely in `bot/lib/shared/resolver.js` (action layer,
runs on the bot with mcData loaded). It is NOT a CLI-layer
normalization (the empirical data killed that scope — see
`docs/planning/session-devlog.md` 2026-05-28 entry on the B3 analysis if it
gets written).

## Acceptance

1. The 91 observed UNKNOWN_BLOCK cases reduce to either:
   - successful resolution (Layer 1 + Layer 2), or
   - a clearer NOT_A_BLOCK error envelope (Layer 1).
2. Existing `QUERY_ALIASES` behaviour preserved (no regression on
   `axe`/`pick`/`wood`/`log`/`planks`/`stone`).
3. The literal_alias kind survives policy=exact_required — i.e., an
   agent that explicitly wanted `grass` (the literal old id) gets
   `short_grass` back, which is the right answer for any current
   mcData version. Document the trade-off in the resolver docstring.
4. `scripts/analyze-mc-name-failures.py` rerun after deployment shows
   the UNKNOWN_BLOCK count drop substantially (target: ≤20% of the
   91-case baseline).

## Tests

- `bot/test/runtime/resolver-aliases.test.js` (new file, if not extant)
  - Layer 1: each new alias resolves to its target name.
  - Layer 1: `village` returns NOT_A_BLOCK with a hint string.
  - Layer 2: `pickaxes` (plural of unknown id) hits depluralized lookup.
  - Layer 2: `dirts` would NOT resolve to `dirt` (dirt is already
    canonical; the lookup hits first and depluralization never runs).
    Lock the precedence.
  - Compat: existing `axe`/`pick`/`wood`/`log` tests pass unchanged.
- Re-run `scripts/analyze-mc-name-failures.py` against fresh
  cognition logs from a post-deploy session and capture the delta
  in `docs/planning/session-devlog.md`.

## Effort

Layer 1: ~20 LOC + ~6 tests. ~half day with the analysis already done.
Layer 2: ~10 LOC + ~3 tests. Another hour.
Layer 3: defer — no current need.

## Out of scope (call-out)

- **Auto-completion / fuzzy matching** (`stoen` → `stone`). Levenshtein
  distance opens up false positives at name length 4-6 (e.g. `stone`
  → `bone`). Don't ship until there's evidence the typo class
  actually occurs; the data shows it doesn't.
- **mcData fuzzy search** at the CLI layer. The CLI doesn't have mcData
  loaded — alias resolution belongs on the server.
- **CLI-layer case/whitespace norm** (the previously-shelved Path A).
  Empirical data shows 99.74% of agent invocations already use
  canonical form. Not worth the ~15 LOC surface area.

## Related

- `bot/lib/shared/resolver.js` — existing resolver
- `scripts/analyze-mc-name-shapes.py` — empirical evidence the data
- `scripts/analyze-mc-name-failures.py` — failure-pattern triage
- `scripts/analyze-mc-failures.py` — prior failure analysis (broader
  surface; documented that material naming was ~98% canonical)
- CLI forgivingness survey: commits `36240fa`, `7589799`, `1f9ded5`
  (the work this ticket descends from)

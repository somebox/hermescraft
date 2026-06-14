# Consistent drop / edge / falloff warnings (shared classifier)

Status: PROPOSED — scoped for a small standalone refactor session.
Owner: TBD (spun out of the mining-agent work, 2026-06-14).
Prereq: none. Self-contained bot-side change.

---

## 1. Problem

Several `mc` action verbs warn about vertical drops ("cliff edge", "fully air",
"would drop the bot", "fall through"). They each roll their own message with
their own (or no) threshold, and the language is **alarming for what is usually
a benign 1–2 block step-down**. A weak agent reads "cliff edge" and abandons the
task to hunt for "solid ground" instead of just stepping down or placing a tread.

**Concrete evidence (M2 mining run, 2026-06-13).** The agent stood on a stone
*hilltop peak* (entrance y=80; neighbours y=78–79, steepest to the north y=76).
It chose to descend north; `stair_down` hit *"target column … is fully air —
you're at a cliff edge … Move to solid ground first"* — for a **2-block
falloff**. It then ran `inspect×8` then `inspect×7` (front-loaded, ~15 wasted
ops) diagnosing the terrain to find footing. It recovered and finished a clean
descent afterward, but those ~15 ops were exactly the budget that would have
covered the climb-out. The warning, not the terrain, derailed it.

The fall facts: a drop of **1–3 blocks does no fall damage** and is a normal
walk-down; **4+** starts to hurt; only a deep/blocked drop is a real hazard.

## 2. What's already there (and why it's inconsistent)

The classification logic exists — twice, with different thresholds — but the
action verbs don't use it:

| Place | Role | Threshold | Notes |
|---|---|---|---|
| `bot/lib/actions/_nav-helpers.js` `neighborStatus` (~L358–410) | nav preflight: is a direction walkable? | **≤3 = `step_down` (safe)**, else `no_support` | Matches pathfinder `MAX_CUMULATIVE_DROP_DOWN_DEFAULT` (`manager.js`). Docstring already calls out the bug: *"the old 'any air at by-1 is a cliff' rule misclassified 1-block bumps."* Requires a clean (air, no water/lava) fall column. |
| `bot/lib/shared/scene-landscape.js` (~L218–270) | scene perception terrain_kind | **`cliff_below` at delta ≤ −6** | A *visual* cliff bar (6), distinct from the walkable bar (3). |
| `data/walkability-spec.json` | road walkability | `max_unguarded_drop: 2` | Stricter, road-shoulder specific. |

Action verbs that emit drop warnings with **no shared threshold / alarming tone**:

| Site | Trigger | Current message (paraphrased) |
|---|---|---|
| `bot/lib/actions/excavation.js` `stair_down` (~L736–741) | forward dig column all `already_air` | "fully air — you're at a **cliff edge** … Move to solid ground first" |
| `bot/lib/actions/excavation.js` `cave_below` guard (~L786–790) | floor under next stand cell is air | "bot would **fall through** … bridge OR pick another direction" |
| `bot/lib/runtime/dig-tools.js` `checkFallHazard` (~L189–205) → surfaced in `bot/lib/actions/mining/dig.js` `safe_dig` `HAZARD_FALL` (~L519) | digging the floor block under the bot | "would **drop the bot N blocks**. Step away first" |
| `bot/lib/shared/perception.js` (~L161–162) | standing near a ledge | "**Ledge nearby** — mind drops before moving" |

Net effect: a 2-block step-down can read identically to a 20-block chasm, and
the thresholds (2 / 3 / 6) are scattered with no single source of truth.

## 3. Suggested solution

Add **one shared routine** and route the action-verb drop warnings through it,
so a drop is classified once and described consistently.

### 3.1 `measureDrop()` + `dropPhrase()`

Home: `bot/lib/runtime/dig-tools.js` (already holds `checkFallHazard` /
`detectDigHazards` / `detectPostDigBreach` — the hazard family).

```js
// Scan straight down from a cell to the first solid floor; classify the drop.
measureDrop(b, x, y, z, { maxScan = 8, safeDrop = 3 }) => {
  depth,            // blocks from the cell's feet to the solid floor (0 = solid here)
  floorY,           // y of the solid floor, or null if none within maxScan
  fallColumnClear,  // true if every cell fallen-through is air (no water/lava/leaves)
  kind,             // 'flat' | 'step' | 'drop' | 'void'
}
//   flat : depth 0 (solid floor present)
//   step : 1..safeDrop, fallColumnClear  -> benign walk-down, NOT a cliff
//   drop : > safeDrop with a floor        -> fall damage; bridge or descend deliberately
//   void : no floor within maxScan, OR fall column blocked -> real chasm/edge

// Calm, accurate, ACTIONABLE text for an action error envelope.
dropPhrase(drop, { dir }) => string
//   step -> "the surface steps down N block(s) here (a minor falloff, not a cliff) — move into it and continue <dir>"
//   drop -> "an N-block drop to solid ground at y=… — mc place to bridge, or step down and continue"
//   void -> "opens over a deep drop (no floor within M) — a chasm or hill edge; shift to solid ground"
```

`safeDrop` defaults to **3** to match `_nav-helpers` / pathfinder. Keep it a
parameter so a stricter caller (e.g. road work) can pass 2.

### 3.2 Apply at the action sites

Refactor these to call `measureDrop` and phrase via `dropPhrase`, with
calibrated severity (a `step` is informational/recoverable, not a scary error):

- `excavation.js` `stair_down` "fully air" branch → measure the drop; for `step`
  say "minor falloff — `mc move` into it and retry `stair_down <dir>`"; only
  `void` keeps a real "pick another direction" tone.
- `excavation.js` `cave_below` guard → same classifier; `step`/`drop` → "bridge
  (`mc place`) or step down and continue the SAME direction"; reserve alarm for
  `void`.
- `dig.js` `safe_dig` `HAZARD_FALL` message → a 1–2 block drop is "you'll step
  down N blocks (harmless)"; only `drop`/`void` warns about fall damage.

### 3.3 Leave as-is (but cite the shared threshold)

- `_nav-helpers.neighborStatus` and `scene-landscape` are working classifiers for
  their domains (nav walkability, visual scene). Don't rewire them; just add a
  comment that `safeDrop = 3` is the shared "benign step-down" bar so the numbers
  don't drift. (Optional stretch: have `neighborStatus` consume `measureDrop`.)

## 4. Scope / non-goals

- **In scope:** the shared classifier + re-phrasing the three action-verb sites;
  consistent threshold + calm/actionable language.
- **Non-goal (this session):** changing *behavior* — e.g. `stair_down`
  auto-stepping into a minor falloff and continuing without an agent round-trip.
  That's a worthwhile follow-up but a bigger change to the descent loop; note it,
  don't do it here.
- **Note:** the mining doctrine (`skills/minecraft-mining.md`) already says
  "commit to ONE descent direction; bridge caves, don't spiral." Once the verb
  messages are calm + actionable, re-check that doctrine row reads consistently
  (and remember `scripts/sync-skills.sh ~/.hermes/skills/gaming` after any edit —
  agents load skills from the hub, not the repo).

## 5. Acceptance

- A single `measureDrop`/`dropPhrase` in `dig-tools.js` with unit tests over
  fixtures: flat, 1-block step, 3-block step, 5-block drop, no-floor void,
  water-blocked fall column (→ void/blocked).
- `stair_down`, `cave_below`, and `safe_dig` fall-hazard all phrase drops via the
  shared helper; a 1–2 block falloff no longer contains the word "cliff".
- Existing bot suite stays green (`cd bot && npm test`); update any test that
  pinned the old "cliff edge" / "fully air" strings.
- (Optional) a functional check: `stair_down` toward a 2-block surface step
  returns a `step`-class message, not a cliff warning.

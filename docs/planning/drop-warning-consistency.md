# Consistent drop / edge / falloff warnings (shared classifier)

Status: IMPLEMENTED — shared classifier in dig-tools (2026-06-14).
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
- `excavation.js` `dig_area` hazard abort → same `dropPhrase` for `fall` (today
  only `${hazard.kind}` in the message).

### 3.3 Leave as-is (but cite the shared threshold)

- `_nav-helpers.neighborStatus` and `scene-landscape` are working classifiers for
  their domains (nav walkability, visual scene). Don't rewire them; just add a
  comment that `safeDrop = 3` is the shared "benign step-down" bar so the numbers
  don't drift. (Optional stretch: have `neighborStatus` consume `measureDrop`.)

## 4. Scope / non-goals

- **In scope:** the shared classifier + re-phrasing **`stair_down`**, **`cave_below`**,
  **`safe_dig` `HAZARD_FALL`**, and **`dig_area`** fall abort messages; consistent
  threshold + calm/actionable language.
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

---

## 6. Codebase audit (2026-06-14)

Subagent + manual pass over `bot/`. **Plan assumptions validated**; expand scope
slightly so the taxonomy stays consistent.

### 6.1 Validated

| Claim in §2 | Verdict |
|---|---|
| `neighborStatus` uses 1–3 block safe step-down (`dy` 2..4) | **Correct** — `_nav-helpers.js` L393–409; pinned by `nav-helpers.test.js` |
| `scene-landscape` cliff at ±6 | **Correct in code** (L269–270); JSDoc still says ≥4 — fix comment only |
| `stair_down` / `cave_below` strings | **Correct** — `excavation.js` L736–740, L760–765 |
| `checkFallHazard` → `safe_dig` `HAZARD_FALL` | **Correct** — `dig-tools.js` L189–205, `dig.js` L585–593 |
| No shared classifier on action verbs | **Correct** — `checkFallHazard` counts depth but does not classify step vs damage vs void |
| M2 failure mode (fully air column ≠ chasm) | **Plausible** — `already_air === targets.length` fires before any step; no depth probe today |

### 6.2 Taxonomy: who speaks about drops (agent-facing)

| Layer | Signal | Threshold today | Refactor? |
|---|---|---|---|
| **Action errors (alarm-prone)** | `stair_down` fully-air, `cave_below` | Binary air / no depth | **Yes — §3.2** |
| **Action errors** | `safe_dig` / `dig_area` `HAZARD_FALL` | Any `drop > 0` same tone | **Yes — add `dig_area`** (generic message at `excavation.js` L345–353) |
| **Action errors** | `mc dig` `DIG_UNDER_FEET` | Always refuse under-foot | **No** — stranding guard, not drop-depth taxonomy |
| **Nav preflight** | `BOT_ON_PILLAR` “every direction is a cliff” | 4× `no_support` | **No** — real 4+ drops on all sides |
| **Nav standing** | `mc standing` `cliff:` / `cliff_dirs` | `no_support` only (excludes `step_down`) | **No** — already aligned with safeDrop=3 |
| **Post-nav** | `⚠ FELL N blocks` (`goto`, `goto_near`) | `fellBy >= 4` | **No** — already damage-aligned |
| **Observation** | `formatStandingSituation` “Ledge nearby … mind drops” | `edge` + any `cliff_dirs` | **Optional follow-up** — only names true cliffs (`no_support`), but ignores adjacent `step_down_dirs` as safe exits; calmer copy possible, not blocking |
| **Scene / planning** | `terrain_kind` cliff_*, `survey_line` drop/drop_hazard, path `ravine/cliff` | 6 / 2 / 16 respectively | **Out of scope** — different domains (visual relief, road spec, corridor planning) |

**Collect gap (document only):** `mc collect` calls `b.dig()` with no
`detectDigHazards` — intentional or not, leave unchanged this session.

### 6.3 Implementation notes for `measureDrop`

1. **Probe origin must match nav.** For cardinal descent, prefer the same geometry
   as `neighborStatus(b, bx, by, bz, dx, dz)`: foot at `(bx, by, bz)`, scan landing
   at `by - dy` for `dy ∈ [2..4]` with fall-column air check (reuse `AIR_NAMES` /
   fluid-leaf rules from `_nav-helpers.js` or export one helper). For `stair_down`
   “fully air” branch, probe from the **forward stand cell** `(fx, fy-1, fz)` (or
   equivalent neighbor step), not from the bot’s current cell only.

2. **`cave_below` is stricter than pathfinder today.** It treats any passable block
   at `(fx, fy-2, fz)` as “fall through”, even when solid is 2–3 blocks below
   (pathfinder would allow). Refactor should **replace the binary check** with
   `measureDrop`; abort only when kind is `void`, or `drop` if product policy
   says 4+ under next stand is still too risky for auto-step (keep abort, calm
   phrase). For `step`, message should match §3.2 even if behavior still stops
   the loop (non-goal §4).

3. **`checkFallHazard` should delegate** to `measureDrop` at the under-foot cell
   so `hazard.drop` and `kind` stay consistent; `detectDigHazards` can attach
   `kind` on the fall hazard object for callers.

4. **Export `SAFE_STEP_DOWN_BLOCKS = 3`** (or import from one place) referenced
   in comments in `_nav-helpers.js` and `manager.js` `MAX_CUMULATIVE_DROP_DOWN_DEFAULT`.

### 6.4 Preserve real danger (do not soften)

- **`void`**: no floor within `maxScan`, or fall column blocked by water/lava/leaves
  (same as `no_support` / water test in `nav-helpers.test.js`).
- **`drop` (4+ to solid floor)**: fall-damage band; keep explicit bridge / deliberate
  descent wording.
- **`on_pillar` / `BOT_ON_PILLAR`**: four true cliffs — keep strong language.
- **`cave_below` with deep air column** (original flint kick scenario): still abort;
  distinguish from 2-block hillside air column via depth, not by removing the guard.
- **Post-dig fluid breach** (`detectPostDigBreach`): unrelated; no change.

### 6.5 Test contract (gaps vs §5)

**Already enforces safe-drop=3:** `nav-helpers.test.js`, `bot-manager.test.js`
(pathfinder landing cap).

**Missing (add in this refactor):**

| Test file | What to add |
|---|---|
| `bot/test/dig-tools.test.js` | `measureDrop` + `dropPhrase` matrix (§5 fixtures); water-blocked column |
| `bot/test/dig-tools.test.js` | `checkFallHazard` / `detectDigHazards` for step vs drop depths (currently untested) |
| `bot/test/actions/excavation-contract.test.js` | Mock world: `stair_down` north with 2-block air column → message has no `cliff`, includes step phrasing; deep void → still alarming |
| `bot/test/actions/excavation-contract.test.js` | `cave_below`: solid 3 blocks below stand → step/drop phrasing, not “fall through” for 2-block case |
| `bot/test/actions/mining-dig.test.js` (or dig-tools) | `safe_dig` `HAZARD_FALL`: drop=2 calm vs drop=10 damage wording |

**Fixture not wired:** `data/test-fixtures/L3/L6.3_dig_floor_under_self.yaml` documents
10-block `HAZARD_FALL` — optional pytest hook later; unit mocks suffice for CI.

**Optional:** `perception-standing.test.js` for `edge` ledge line; lower priority.

### 6.6 Revised in-scope list (§4)

- Shared `measureDrop` / `dropPhrase` + tests.
- Message routing: `stair_down` (fully air), `cave_below`, `safe_dig` **`HAZARD_FALL`**, and **`dig_area`** fall branch (same phrases, generic envelope today).
- Comments tying `safeDrop=3` to nav/pathfinder.
- **Not in scope:** perception ledge line, `collect` hazards, behavior auto-continue on `step`, road/survey thresholds.

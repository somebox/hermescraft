# Run-8 — live fix log

Observations + fixes captured during the run (2026-06-03). Bootstrap clean
on attempt 2 (chest-shift fix from commit `6995312` verified live at
Y=78). This file is appended to as the run progresses; postmortem
synthesis happens after `landfolk stop`.

Run-7 (phase9) baseline carryover:
[`THOROUGH-POSTMORTEM.md`](../establish-2026-06-03-phase9/THOROUGH-POSTMORTEM.md).

---

## 10-min check (14:24 local) — fleet HEALTHY

| Signal | Status | Detail |
|---|---|---|
| PR-J `terrain=` render | ✅ live-verified | CLI: `Surface at 20,79,40 — open (2 exits) — terrain=unknown (feet_vs_local_ground=-9) ← suggested: S` |
| PR-S watchdog AUTO_STUCK | ✅ armed | 0 fires (healthy run; nothing to escalate yet) |
| PR-K stash hygiene | ✅ | no `task-body-coord.json` (EXPLORE-only phase) |
| PR-F pillar guards | ✅ | 0 hits |
| Phase 7.0 sessions | ✅ | 0 steward sessions |
| failure events | ✅ | 0 in last 12 min |
| board | ✅ | NE+NW EXPLORE archived; SE (gatherer), SW (mason), SCOUT (flint) running |
| Steward agency | ✅ | reassigned cards, created Flint SCOUT, kept fleet HEALTHY |

---

## Fix 1 — Kanban seed cards still encoded catalog Y

**Symptom.** Probe substituted spawn Y 96 → 79 in the world prep step,
but `establish-seed-cards.py` read the unmodified catalog Y from
`data/runtime/last-establish-map.json`. The EPIC body said `Spawn:
4,96,24`; NE and NW EXPLORE cards referenced `muster (4,96,24)`.

**Live evidence.**
- `bot-gatherer.log:[4:17:20] Took 13.0 damage (HP: 7.0)` — Flint fell
  ~17 blocks on his first muster TP.
- `[Chat] <Steward> Zombie worker killed on flint, muster Y corrected.`
- NE and NW were `archived` by 10-min; SE/SW/SCOUT cards (later) all
  use `(4,79,24)` because Steward manually rewrote them.
- Kanban dump:
  ```
  t_877ff657|NE quadrant from muster (4,96,24)  ← stale
  t_20a90530|NW quadrant from muster (4,96,24)  ← stale
  t_9b0ef1ad|SE quadrant from muster (4,79,24)  ← Steward-fixed
  ```

**Root cause.** `establish-rcon-prep.py --mode world` mutated `card`
in-memory for `prep_commands` but never wrote the resolved coords back
to disk. `establish-seed-cards.py`, `--mode tp_workers`, and the bash
`placements.spawn` echo all re-read the file → all saw the stale Y.

**Fix (applied this run).** New helper
`apply_spawn_y_override(card, resolved_sy)` mutates `spawn`, `muster`,
and `starter_chest` in both top-level and `placements.*` shapes,
preserving the catalog `chest_y = spawn_y − 1` relationship. `main()`
writes `card` back to `args.map` whenever a substitution fires.

Diff lands in `scripts/establish-rcon-prep.py`; six new tests in
`scripts/tests/test_establish_rcon_prep.py::ApplySpawnYOverrideTest`
(spawn-patch / muster-collapse / chest-delta / minus-one-invariant /
xz-untouched / JSON roundtrip). 20 / 20 tests green.

**Next-run predicate.** EPIC body and all four seeded EXPLORE cards
reference the probed Y (not 96) on the first dispatch. Measure:
```bash
sqlite3 ~/.hermes/kanban/boards/landfolk-ops/kanban.db \
  "SELECT body FROM tasks WHERE title LIKE '%EPIC%' OR title LIKE '%EXPLORE%';" \
  | grep -E "4,(79|96),24"
```
Expect all matches to be `4,<probed>,24`.

**Status.** Code + tests in working tree. Commit pending. Active run-8b
is unaffected (Steward already routed around it); the fix takes effect
on run-9.

---

## Open — terrain.kind="unknown" fleet-wide

**Symptom.** Every worker's `/status` returns
`nav_header.terrain.kind = "unknown"` and `feet_vs_local_ground = -9`.
Renderer emits the suffix correctly (PR-J working), but the classifier
is in fallback mode — the SOUL (PR-F) is supposed to ignore `unknown`
labels, so workers don't act on it, but it also means PR-E's whole
value (Steward reading the label) is suppressed.

**Hypothesis (not yet verified).**
- `surfaceYAt` may be hitting the canopy guard or returning a column-air
  value far above the bot's feet, producing the `-9` delta.
- `establish-rcon-prep.py` lays a grass-block slab at `sy-1` and air at
  `sy..sy+3` over a 25×25 rect. If the natural surface 12+ blocks out
  (where `cardinalReliefDeltas` samples) is forest canopy or thick
  leaves, the classifier sees inconsistent altitudes → `unknown`.
- The PR-E known-false-positive list specifically flags `tree canopy /
  partial chunks → surfaceYAt may return canopy Y → bogus underground`
  with a fallback to `unknown`. This is the same path.

**Live data.**
```json
{"terrain":{"kind":"unknown","feet_vs_local_ground":-9},
 "suggested_hint":"suggested: S (unknown, Y mid (72-95))",
 "standing_on":{"name":"grass_block","coord":{"x":20,"y":78,"z":40}}}
```
Bot at Y=79 on grass at Y=78 — clearly on natural surface. The
classifier should label this `flat` or `slope_*`. `-9` is the
smoking-gun number.

**Cost during run-8.** None — workers ignore `unknown`. But Steward's
PR-F whispers (the whole point of `terrain_kind`) can't fire either,
so we lose the run as a PR-F validation surface.

**Next step.** During run-8 postmortem, sample 10 worker poses + the
raw `cardinalReliefDeltas` output and reverse the classifier's
condition tree to see which branch returns `unknown`. Likely fix is a
canopy-aware fallback that recognizes `grass_block` underfoot as a
strong "feet are on surface" prior.

**Status.** Investigation. No code change yet — wait for postmortem
data before patching the classifier blind.

---

## 30-min check — pending

Scheduled at 16:47. Predicates of interest:
- Marks accumulating (`scripts/reconcile-marks.py`).
- Pad anchor candidate selected by Steward.
- `mc collect`/`mc dig` activity from Gatherer/Flint (transition to
  resource-gathering phase).
- Fleet error rate < run-7 baseline (~25%).
- Any AUTO_STUCK fires (would be the first run with PR-S exercised on a
  real stuck condition).

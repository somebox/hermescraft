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

## Fix 2 — Starter chest flush with grass instead of sitting on it

**Symptom.** Live run-8 observation: chest is "positioned in the ground
Y-1" — accessible but visually sunk. Standing at spawn (Y=79), bot sees
the chest one block east at the SAME Y level as their feet, its top
flush with the grass surface. A standard placed chest should sit ON
the grass with its top sticking up one block above the bot's feet.

**Root cause.** `establish-scenario.sh` auto-patch line 106 (pre-fix)
wrote `starter_chest = [sx+1, sy-1, sz]`. Comment said "surface-y
(sy-1)" — author conflated "Y of the surface BLOCK" with "Y at which a
player stands on the surface." Setblock at `cy = sy-1` places the
chest BLOCK in the same row as the grass slab the prep just laid; the
chest visually replaces one grass block instead of sitting on top.

**Live evidence.**
- World prep at Y=79: `fill ... 78 ... grass_block`, `setblock 5 78 24 chest`
- Bot feet at Y=79, chest block occupies Y=78→79
- Chest top at Y=79 = bot feet level → flush, not raised

**Fix (applied this run).** Auto-patch now writes
`starter_chest = [sx+1, sy, sz]` (chest sits AT spawn-feet level —
block bottom at Y=sy, top at Y=sy+1, sticking up one block above the
grass). `prep_commands` and `apply_spawn_y_override` are
convention-agnostic — they preserve whatever spawn↔chest delta is in
the input — so existing legacy-convention test cases stay valid.

Test `test_chest_at_spawn_level_convention_preserved` covers the new
convention end-to-end: card with `chest_y = catalog_sy`, override to
resolved_sy → chest setblock at Y=resolved_sy (no off-by-one drift).
**21/21 tests green** (up from 20).

**Next-run predicate.** Bot at spawn looking east sees a chest with
its top sticking up one block above the grass plane (not flush). Quick
rcon probe:
```bash
ssh ubuntu-host sudo docker exec -i minecraft rcon-cli \
  'execute in proc-lab if block 5 79 24 minecraft:chest'   # expect: Test passed
ssh ubuntu-host sudo docker exec -i minecraft rcon-cli \
  'execute in proc-lab if block 5 78 24 minecraft:grass_block'  # expect: Test passed
```

**Status.** Code + tests committed. Active run-8b chest stays at Y=78
(no in-flight world re-prep); the fix takes effect on run-9.

---

## Fix 3 — Per-bot hermes MEMORY.md leaked stale coords across runs

**Symptom.** Workers reasoned about coordinates that don't exist on the
current world disc. Gatherer's current-run reasoning anchored on
`muster (4,96,24)` even though `mc status` would have told her the
muster is at Y=79. Mason mentioned `cabin on 9x9 pad — cobble walls 3
tall (Y97-99)` — a structure from a prior run that doesn't exist on
the fresh seed=1001 disc.

**Root cause.** Hermes per-profile `MEMORY.md` files at
`~/.hermes/profiles/<bot>/memories/MEMORY.md` and
`~/.hermes-landfolk-<bot>/memories/MEMORY.md` are auto-injected into
every system prompt (visible as a `MEMORY (your personal notes)`
section at ~2.2K char budget). These files accumulate per-task
summaries the agent writes between cycles — useful within a run, but
the `establish-scenario.sh` wipe only cleared `data/locations-*.json`
(marks) and legacy session JSONs, NOT the memories. Each new bootstrap
inherited the prior run's mark coords, task summaries, and base
structure references.

**Live evidence.** Reading
`~/.hermes/profiles/gatherer/memories/MEMORY.md` (2141 bytes, modified
16:40) shows 4 entries, all referencing `muster (4,96,24)` and marks
from prior worlds (`candidate_pad_se_1@(19,99,43)`, `lt_coal_sw at
(-30,86,51)`, etc.) — Y values from prior seeds that don't match the
current seed=1001 surface at Y≈79. Mason's memory (2158 bytes) has an
entry: `cabin on 9x9 pad — cobble walls 3 tall (Y97-99)` from yet
another world. Flint's (2179 bytes) references `base anchor
(-238,65,561)` from a third world's coords. Each bot has TWO memory
files (kanban-worker home + landfolk-loop home), both leaking.

**Sessions are NOT chained.** `parent_session_id` is NULL on all new
sessions (verified via `SELECT id, parent_session_id FROM sessions
ORDER BY started_at DESC LIMIT 3` per bot). The cross-run leak channel
is only `MEMORY.md`, not the messages table.

**Fix (applied this run).** Extended the per-bot memory wipe in
`establish-scenario.sh:44-79` to archive `MEMORY.md` from both
candidate locations:

```
$HOME/.hermes/profiles/${wk}/memories/MEMORY.md
$HOME/.hermes-landfolk-${wk}/memories/MEMORY.md
```

Each file moved to `MEMORY.md.bak-<YYYYMMDD-HHMMSS>` (archive, not
delete — postmortems can review what the bot remembered from prior
runs). `USER.md` (user identity, ~100 bytes) and `MEMORY.md.lock`
(hermes-managed lockfile) are untouched.

**Next-run predicate.** After `bash scripts/establish-scenario.sh`:
```bash
for bot in steward gatherer flint mason; do
  for h in ~/.hermes/profiles/$bot/memories ~/.hermes-landfolk-$bot/memories; do
    [ -d "$h" ] || continue
    echo "$bot @ $h: $(ls $h/MEMORY.md 2>&1 | head -1) | bak: $(ls $h/MEMORY.md.bak-* 2>/dev/null | tail -1)"
  done
done
```
Expect: `MEMORY.md` either absent (will be created fresh by the bot
runtime on first session) or empty; at least one `MEMORY.md.bak-*`
archive per location.

**Status.** Bash patch in working tree. Active run-8b is unaffected
(memories already polluted; Steward routed around it via in-game chat
whispers). Fix takes effect on run-9.

---

## Investigation 1 — "Workers idle, Steward digging dirt" (operator report)

**Symptom (operator, ~17:00).** In-game: Steward's body mining dirt;
Flint/Gatherer bodies appear to stand still; Flint/Gatherer logs show
mc-command activity but no visible movement. Suspected wiring crossover
(agent → wrong port).

**Diagnosis sequence + correction.**

1. **First hypothesis (wrong): "workers spawned but did 0 work."**
   I queried `~/.hermes/profiles/<bot>/state.db` at 17:00 and saw
   `message_count=0, tool_call_count=0` for the most recent worker
   sessions. Concluded workers were silently failing.

2. **Re-query at 17:04 corrected the picture.** State.db WAL had not
   flushed when I queried at 17:00. After the fleet was stopped
   (forcing WAL checkpoint), the same sessions show full activity:
   - Mason `20260603_164344_fc0f87` (t_9d5c92b0 — clear pad): 152
     messages, 97 tool calls
   - Flint `20260603_165655_64ac48` (t_fee02ec2 — supply cobble): 69
     messages, 40 tool calls
   - Gatherer `20260603_164445_f8dd1e` (t_b74b7645 — coal): 171
     messages, 91 tool calls

3. **Wiring verified correct.** lsof on TCP ports 3001/3002/3003/3005
   maps each port to a distinct mineflayer node process. /status
   nearby_entities at each port lists OTHER bots by IGN (port 3001 sees
   Flint+Steward = port 3001 is Gatherer; etc.), matching the
   WORKER_PORTS mapping in establish-scenario.sh. agent-{bot}.log
   headers confirm each agent uses its own api=http://localhost:300X.

**What the operator actually saw.**

- **"Steward digging dirt"** — TRUE bug. `bot-steward.log` recorded
  `[collect] No dirt visible; mining grass_block as source (drops
  dirt)`. Steward's continuous-loop agent called `mc tunnel`, `mc
  level`, `mc collect`, `mc dig`, `mc move` — all mutating verbs
  forbidden by her read-only role.

- **"Flint/Gatherer logs show activity but bodies idle"** — the
  worker hermes sessions WERE generating tool calls; the
  "standing-still" snapshots correspond to reasoning gaps between tool
  calls (the LLM thinks for 5-15s between actions, and bots that just
  finished a `dig` look stationary).

- **Mason's body far from target** — his session shows him trapped at
  (-3, 68, 53), 18 blocks west and 9 below base_anchor (15, 77, 56).
  Sequence: `mc goto_near 15 77 55 range=2 → BOT_TRAPPED at -3,68,53`,
  then `mc escape` partially succeeded (`pillar_up Y 68 → 71`) but the
  navigator couldn't rejoin the anchor. Pattern A (vertical-traversal
  NAV_BLOCKED, issue #38a) at full force.

**Confirmed bugs to fix.**

1. **Steward's read-only role isn't enforced.** SOUL prose
   ("read-only mc observation") + her own self-description ("Never
   start bot bodies for yourself or other profiles") didn't prevent
   her from calling `mc tunnel`, `mc level`, etc. Per operator
   decision (run-8 audit): keep prose-only enforcement, don't add
   server-side deny — Steward's drift is treated as a prompt-quality
   issue, not an API guard issue. **Action**: harden Steward's SOUL
   to explicitly forbid the verbs she invoked this run.

2. **Worker dig→trap cascade.** When a card asks Mason to clear a pad
   at a Y=77 anchor on a Y=79 surface (the anchor is 2 below
   surface), the navigator tunnels down → traps the bot at the dug
   floor → escape pillars up but loses position. **Action**: track as
   #38a follow-up; not in scope for the run-9 bootstrap.

**My misdiagnosis (notable, for future loop discipline).** I claimed
"workers spawned but did 0 work" based on a state.db query at 17:00
that showed message_count=0. **A WAL-flush check (`PRAGMA
wal_checkpoint(PASSIVE)` or stopping the live writer) before drawing
inferences from a hot DB would have surfaced the real data.** Adding
to operational notes: queries against a live hermes state.db lag by
the WAL flush interval — always cross-check with the hermes session
JSON dumps or wait for fleet stop.

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

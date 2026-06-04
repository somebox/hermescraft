Continue (orchestrator cycle).

Checklist:
1. `scripts/kanban board`
2. `hermes kanban diagnostics`
3. `scripts/fleet-status.py`
4. `scripts/roster.py --assignable`
5. `mc observe`
6. If `[ESTABLISH:BASE]` is open: `scripts/reconcile-marks.py --auto`
7. If `[MAP:ARENA]` is open: `scripts/poi-graph.py --pretty --muster <mx> <my> <mz>` — read named_frontier + quadrants_covered + longest_path
8. Classify each bot: HEALTHY_WORKING / PHYSICALLY_STUCK / IDLE_AVAILABLE / BLOCKED_WAITING
   - **A worker without a `[MAP-PATH]` claim while `[MAP:ARENA]` is open is IDLE_AVAILABLE for mapping purposes, even if their continuous SOUL loop is running** — that loop is NOT a kanban task. Mason placing "perimeter torches" without a card = IDLE_AVAILABLE, NOT HEALTHY_WORKING.
   - **A worker on a non-mapping card (`[RESCUE]`, `[SUPPLY]`, etc.) is BLOCKED_WAITING from the mapping epic's perspective** — they'll come back, but right now they don't count toward mapping coverage.
   - A worker who is mobile (position changed in the last cycle) is NOT PHYSICALLY_STUCK, even if the watchdog flagged AUTO_STUCK. PHYSICALLY_STUCK requires: position frozen + HP dropping OR position frozen + same error repeating 4+ rounds.
9. Rank top 3 issues: stuck > blocked > **mapping_idle (no [MAP-PATH] claim while [MAP:ARENA] open)** > idle > imbalance
10. Execute up to 3 actions (one per issue). Do not undo prior action without new evidence.

**`[MAP:ARENA]` completion is NOT measured by kanban card-counter.** A mapping epic shows "N/N done" the moment Flint closes the root card — that does NOT mean the mission is complete. The epic is complete only when the POI GRAPH clears all thresholds:

- `named_count ≥ 6` (in `personal-pois-shared.json` via `poi-graph.py`)
- `longest_path_len ≥ 80`
- `quadrants_covered` contains all 4 of NE/NW/SE/SW
- `named_frontier_count ≤ 3`

If any threshold is short, the mission is OPEN regardless of card count. Read `scripts/poi-graph.py --pretty` each cycle and compare against these numbers; "1/1 done" on the epic is a red herring.

**`[MAP:ARENA]` open + any IDLE_AVAILABLE worker → MUST create a new `[MAP-PATH]` card this cycle.** Never report "fleet watching" while a mapping epic has unfinished thresholds AND idle workers. One card per IDLE worker per cycle. Card target should specifically push toward the missing thresholds — if `quadrants_covered` is missing NW, the next card targets `(-x, -z)` from a frontier landmark.

Card-create form (mandatory `--skill` flags or worker spawns without the mapping verbs):
```
scripts/kanban add "[MAP-PATH] <startName> → (<x>,<y>,<z>)" \
  --for <epic_id> --assignee <worker> --size S \
  --skill minecraft-mapping --skill minecraft-navigation \
  --body "<protocol body — match the root card template>"
```

Pick start from `named_frontier`; pick target ~40-60 blocks toward an under-represented quadrant. Bias toward NW/SW if missing from `quadrants_covered`.

Review all in-flight `[MAP-PATH]` cards for new `SIGN_PROPOSAL:` comments — reply on the same card with `APPROVED: <name> at (X,Y,Z)` / `REJECTED: <reason>; try <suggestion>` / `SUGGEST: <better name>`.

PHYSICALLY_STUCK → rescue (whisper escape primitive / [RESCUE] for re44 / reassign to another assignable bot). Never decompose work to unstick a bot. Never reassign to 'default'. **Exception for `[MAP-PATH]` cards: a self-reported PHYSICALLY_STUCK is almost always a goto that hit terrain — comment "@<bot>: place a sign at your current position and pick a different bearing" before escalating.**

For prior-cycle context, use `session_search` — not memory.

End with `mc chat "<summary>"`. Stay at base; never mine/place.

# Proc-nav scout — operator runbook

Kanban board **`proc-nav-lab`** (Hermes namespace only). Minecraft arena **`proc-nav`** only — **not** `proc-lab` or genesis. Execute bot **Mox** on `:3007`.

**Trial reference:** `proc-nav-1780956289` — Core **PASS** (5/5, scorecard + `spatial-map.html`). Baseline **soft-pass**. Self-improve loop closed once; see [proc-nav-scout-plan.md](proc-nav-scout-plan.md) § Operational status for tier table and W2-NAV-001…006.

## Env block

```bash
export HERMES_HOME=~/.hermes
export HERMESCRAFT_REPO=/path/to/hermescraft
export RUN_ID=proc-nav-$(date +%s)
export BOARD=proc-nav-lab
export BOT_URL=http://127.0.0.1:3007
export MC_API_URL=$BOT_URL
export MC_USERNAME=Mox
export PROC_WORLD=proc-nav
```

Add **Mox** to `world.evac.bot_players` in gitignored `server.local.yaml` (`world.name: proc-nav`).

## MV / mapcatalog spike (before live Phase B)

```bash
# Dry or one-shot materialize into proc-nav (not proc-lab):
python3 -m mapcatalog try \
  -r requirements/scenario_scout_overlook.yaml \
  -s server.local.yaml --seed <N> --json-full
# Or: scripts/reset-proc-lab.py --world proc-nav --seed <N>
```

Confirm bot dimension is `proc-nav` (`mc status` or `mv list`).

## Phase B — Baseline (scouting.overlook)

**Preflight:** `scripts/proc-nav-preflight.sh` → `MC_HOST=… scripts/colony start mox`

**Run:**

```bash
AGENT_SPEC=data/agent-tests/topics/scouting/overlook-survey-proc-nav.yaml \
  scripts/scenario-agent-test.sh scouting.overlook -- \
  --bot-url "$BOT_URL" --model "${AGENT_TEST_MODEL:-deepseek/deepseek-v4-flash:exacto}"
```

**Post:** JSON under `data/agent-tests/runs/`; pin seed in `calibration/seeds.yaml` (`proc-nav-baseline`). Spec cleanup mvtp to `landfolk-test` — no genesis.

## Phase C — Core (`proc-scout`)

1. `scripts/proc-nav-trial.sh prep-board`
2. `PROC_NAV_START_DISPATCHER=1 scripts/proc-nav-trial.sh dispatcher`
3. `python3 scripts/prep-proc-scout-marks.py` (ports 3007 + 3004)
4. `scripts/proc-nav-trial.sh run-core` with `RUN_ID`

Handoff gate: `pn-observe` **`verify_results`** metadata (pytest `test_proc_nav_handoff`).

**Tester (optional stretch):** `PROC_NAV_EVALUATE_TESTER=1 scripts/proc-nav-trial.sh evaluate` runs `mc verify` at marks.

**Spatial map:** `data/postmortems/proc-nav-lab/<RUN_ID>/spatial-map.html` — best-effort on Core; required on Stress.

## Phase C-stress

Same seed family as Baseline until `proc-nav-stress` pinned. `PROC_NAV_GRAPH=proc-scout-stress scripts/proc-nav-trial.sh run-stress`.

Stress scorecard fields: `nav_escape_count`, `mc_build_stairs_count`, `mc_dig_count` — numeric caps in `calibration/proc-nav-thresholds.yaml` after first Core PASS.

**A6 telemetry:** `run_proc_nav.py --watch` emits `position_snapshot` every 30s from Mox `/status`. Do not gate `nav_stuck_minutes` until time series is validated in ops.

## Phase D — forest

```bash
scripts/scenario-agent-test.sh farming.forest_clearing -- \
  --bot-url "$BOT_URL"
```

Spec: `data/agent-tests/topics/farming/forest-clearing-nav-proc-nav.yaml`.

## Phase E — self-improve

Mirror W2: `feedback1` → `synthesize1` (registry `data/postmortems/proc-nav-lab/_known_issues.json`) → `improve1` → promote → re-run stress.

**IMPROVE cards (AUTO issues):**

```bash
export RUN_ID=proc-nav-1780956289 BOARD=proc-nav-lab
scripts/seed-w2-improve-cards.sh W2-NAV-001 "$RUN_ID"
scripts/seed-w2-improve-cards.sh W2-NAV-004 "$RUN_ID"
scripts/seed-w2-improve-cards.sh W2-NAV-005 "$RUN_ID"
scripts/seed-w2-improve-cards.sh W2-NAV-006 "$RUN_ID"
```

Verifier: `scripts/proc-nav-verify-anchor.sh <promoted-script>` parses output coords against `last-scenario-map.json` golden — not grep-only.

**After first Core PASS:** measured verbs live in `calibration/proc-nav-thresholds.yaml` (`reference_run_id` above). Stress run still required with `proc-scout-stress` graph.

## Anchor playbook

Seed and anchor coordinates from `data/runtime/last-scenario-map.json` (materialized by `scenario-agent-test.sh` / `agent-test-from-map.py`).

| Field | Value |
|-------|-------|
| **Seed** | `1001` |
| **Requirements** | `scenario_scout_overlook` |
| **Arena center** | `(0, 0)` |
| **Arena radius** | 48 blocks |
| **World** | `proc-lab` (materialized as `proc-nav` per world policy) |

### Anchors

| Anchor | Coordinates | Role |
|--------|-------------|------|
| **spawn** | `(-25, 90, 28)` | Bot entry point — safe flat foot at ground level. First `mc status` / `mc scene` here. |
| **muster** | `(-19, 90, 28)` | Assembly point 6 blocks east of spawn. Used as intermediate waypoint on the overlook approach. |
| **overlook** | `(0, 96, 0)` | Vantage column at arena center, 6 blocks above ground. Primary scout target — `mc scene` from here reveals the arena. |
| **return_post** | `(0, 96, 6)` | 6 blocks north of overlook at same elevation. Secondary anchor — marks the return leg after scouting. |

### Playbook flow

```
spawn → muster → overlook → return_post
```

1. **spawn** — bot materialises here. Run `mc status` to confirm dimension and position.
2. **muster** — short eastward move. Optional waypoint; `mc go_mark muster` or raw coords.
3. **overlook** — primary scout target. Must reach within 4 blocks. Run `mc scene` ≥ 1 before completing. Metadata: `anchors_reached: [overlook]`.
4. **return_post** — secondary anchor. Must reach within 4 blocks. Must use `go_mark` or `move` from overlook (not chat-only teleport).

### Seed pinning

After a successful Baseline PASS, pin seed `1001` in `calibration/seeds.yaml` under key `proc-nav-baseline`. Stress tier may pin a second seed (`proc-nav-stress`) from pool `scouting.steep_slope`.

### Verifier fixture

`scripts/proc-nav-verify-anchor.sh` parses output coords against `last-scenario-map.json` placements as golden reference — not grep-only.

### Live verification (bot mox)

Results from `pn-observe` verify stage (kanban `t_1e0cc1e4`): inspected all four anchors in-world and ran `mc verify` predicates on bot **mox**.

**Anchor blocks observed (`mc inspect` at y=96):**

| Anchor | Coordinates | Observed block | Notes |
|--------|-------------|----------------|-------|
| **overlook** | `(0, 96, 0)` | `air` | Column top; bot stands **on** this block (standable block below at y=95) |
| **return_post** | `(0, 96, 6)` | `snow` | Ground-level snow cover at y=96; not a column |

**Predicates (both satisfied):**

| Predicate | Args | Observed count | Threshold | Result |
|-----------|------|----------------|-----------|--------|
| `inventory_contains` | `dirt`, 1 | 11 | ≥1 | ✓ |
| `inventory_contains` | `spruce_sapling`, 1 | 3 | ≥1 | ✓ |

**Position at complete:** `(0.6, 96, 6.5)` — at return_post (y=96 ground, not column).

**Known issue:** `mc inspect --mark NAME` returns `INVALID_COORD` on this backend. Workers must use numeric coords (`mc inspect 0 96 0`) instead of `--mark return_post`. See also the verifier fixture above which uses `last-scenario-map.json` coords.

## Teardown

`scripts/proc-nav-trial.sh teardown` — kills dispatcher, `reset-proc-nav-lab.sh`. **Do not** `reset-wheat-capstone.sh` or `establish-run.sh`.

## Collision list

| Do not | Use instead |
|--------|-------------|
| `world.name: proc-lab` for proc-nav | `proc-nav` |
| `preflight-wheat.sh` for scout | `proc-nav-preflight.sh` |
| Flint `:3001` default for proc-nav trials | Mox `:3007` |
| Raw `agent-test.py` on templates with `procedural_map` | `scenario-agent-test.sh` / `agent-test-from-map.py` |

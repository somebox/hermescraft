# Base establishment runbook (exploration-first)

Operators run the **establishment.explore** proc-lab scenario: Steward decomposes sector patrols on kanban; workers use `mc scene` + marks; Mason builds a 9×9 cobble pad at Steward’s chosen `base_anchor`. Site quality is judged in-game; `establish-check.py` only checks process compliance.

Related: [procedural-testing-model.md](../features/procedural-testing-model.md), [procedural-bench-ops.md](procedural-bench-ops.md), `prompts/landfolk/establish-epic.md`, `skills/minecraft-scouting-site.md`.

---

## Prerequisites

- Live Minecraft server + `server.local.yaml` (proc-lab MV world).
- Hermes kanban board **`landfolk-ops`** (default for landfolk).
- `hermes` CLI and landfolk profiles: steward, gatherer, flint, mason.
- Optional: catalog maps under `catalog/topics/establishment/explore/` (bootstrap refreshes if empty).

---

## PR-1 gate — scene perception (before trusting full scenario)

Validate `mc scene` cues on the existing scouting bench (no establishment bootstrap required):

```bash
BOT_URL=http://localhost:3002 scripts/proc-lab-ops.sh agent-only
```

Run **2–3 rounds**. After each round, read the agent transcript / in-game chat and decide whether a worker could pick a base from the one-line scene output (biome, Y-band, cardinal relief, trees, nav suggested direction). Iterate on scene wording in `bot/lib/runtime/fair-play.js` until satisfied. This is a **human sign-off**, not an automated CI gate.

---

## Run-8 preflight (run before any long establish replay)

Run-7 evidence: every hermetic test passed but the live runtime didn't carry `terrain=` on `mc status`, `auto-stuck-check.py` was never invoked, an EXPLORE coord landed in the stash, and a floating-slab platform sat above the natural surface. Each is testable in <5 minutes — don't burn 60 min on a replay until all five are green.

### A. Hermetic test suite

```bash
node --test \
  bot/test/runtime/nav-brief-render.test.js \
  bot/test/cli/output.test.js \
  bot/test/runtime/observation-status-shape.test.js \
  bot/test/actions/pillar-tracking.test.js
python3 -m unittest \
  scripts.tests.test_auto_stuck_check \
  scripts.tests.test_wb_stash_side_effect \
  scripts.tests.test_card_body_linter \
  scripts.tests.test_kanban_retry_policy \
  scripts.tests.test_establish_rcon_prep \
  scripts.tests.test_reset_proc_lab
```

All green → proceed. Any red → stop and diagnose.

### B. Deploy freshness + fleet diagnostics

```bash
scripts/landfolk deploy        # sync repo SOULs/skills/config to runtime
scripts/landfolk diagnostics   # gateway + dispatcher + daemon health
```

`diagnostics` exits non-zero on any failed phase; this is the canonical "is the fleet bootable" check. There is no `landfolk doctor` subcommand.

### C. Live `mc status` carries `terrain=` (Step 1 contract)

After bringing up at least one worker bot, run a manual `mc status` and verify the rendered output line contains `terrain=`:

```bash
# Substitute the bot's port (Steward 3005, Gatherer 3001, Flint 3002, Mason 3003).
BOT_URL=http://localhost:3005 mc status | grep -E '^(Surface|Underground) at .* — terrain='
```

The expected shape is one line:
```
Surface at 4,96,24 — open (4 exits) — terrain=flat (feet_vs_local_ground=0)
```

If `terrain=` is missing, **stop** — the run will reproduce the run-7 Pattern E (Flint reading raw Y as "underground" while standing on the spawn floor).

### D. AUTO_STUCK is invoked by the watchdog (Step 2 contract)

The watchdog writes a per-tick progress line to `progress-<bot>.log` and invokes `auto-stuck-check.py` once a task is running. After a worker has claimed at least one card, tail the watchdog log and confirm:

```bash
tail -20 /tmp/hermescraft/watchdog-<bot>.log    # look for auto-stuck-check invocations
ls -la /tmp/hermescraft/progress-<bot>.log     # file should be growing
```

If the progress file isn't growing or the watchdog log shows no AUTO_STUCK lines, the wiring didn't deploy — re-run `landfolk deploy` and restart the bot.

### E. Stash-file hygiene

A stale `~/.hermes-landfolk-*/task-body-coord.json` from a prior mid-card crash will misdirect the next run's `MARK_COORD_VS_CARD_DRIFT` warnings:

```bash
rm -f ~/.hermes-landfolk-*/task-body-coord.json
```

### F. Fresh world (recommended if re-using a contaminated disc)

Run-5 and run-6 left residual oak_doors and shelters that bit run-7. Before a long replay, reset proc-lab to a fresh disc:

```bash
python3 scripts/reset-proc-lab.py --seed 1001
```

The script handles the Multiverse OTP confirm + auto-evacuates online humans to the hub. See `phase10-plan.md` Step 4 for the surface-probe rationale — `establish-rcon-prep.py` now probes the live surface Y and fails closed rather than building a slab at a stale catalog Y.

---

## One-shot bootstrap

```bash
scripts/establish-scenario.sh
```

What it does:

1. Lints `establishment.explore` requirements.
2. Picks a map (`scripts/scenario-pools.sh map establishment.explore`); refreshes pool if empty.
3. Materializes proc-lab via `mapcatalog try` (honors `AUTO_REUSE=1` when seed already loaded).
4. RCON: peaceful, no mob spawn, day, **starter chest** at map `starter_chest` (iron pick/axe/shovel + bread).
5. Wipes kanban DB for `HERMES_KANBAN_BOARD` (default `landfolk-ops`) and seeds `[ESTABLISH:BASE]` epic + four `[EXPLORE]` cards.
6. `scripts/landfolk-control.sh start --profiles steward,gatherer,flint,mason`.

Map snapshot: `data/runtime/last-establish-map.json`.

Environment:

| Variable | Default | Meaning |
|----------|---------|---------|
| `HERMES_KANBAN_BOARD` | `landfolk-ops` | Board slug for reset/seed |
| `AUTO_REUSE` | `1` | Skip materialize when proc-lab already has same seed |
| `MATERIALIZE` | `1` | Set `0` to skip mapcatalog try |
| `VARIANT` | `establishment.explore` | Registry variant id |

---

## Observe while the fleet runs

Separate terminals:

```bash
scripts/kanban board
tail -F logs/landfolk-*/steward.log
tail -F logs/landfolk-*/gatherer.log
tail -F logs/landfolk-*/flint.log
tail -F logs/landfolk-*/mason.log
scripts/fleet-status.py    # optional v1 fleet snapshot
```

Steward should run `scripts/reconcile-marks.py --auto` each wake (see `steward.wake-minimal.md`).

**Stop when done or enough data:**

```bash
scripts/landfolk stop
```

---

## Grade (process only)

```bash
scripts/establish-check.py
```

Checks:

- `base_anchor` mark present (shared locations after reconcile).
- ≥ **80** cobble cells in the 9×9 pad at anchor surface (y = foot_y − 1; threshold **80/81** per genesis pad quirk #49).
- ≥ **4** `[EXPLORE]` cards `done` under the epic.
- `[ESTABLISH:BASE]` epic `done`.

Offline / no rcon: `scripts/establish-check.py --skip-rcon`.

**Site quality:** teleport to `base_anchor` in-game and judge flatness, defense, and centrality to `lt_*` marks yourself.

---

## Rerun semantics

- **Kanban:** wiped every bootstrap (comparable Steward decomposition from the same epic template).
- **World:** `reuse_seed` / `AUTO_REUSE` keeps proc-lab seed stable between runs when materialize is skipped.
- **Catalog:** `scripts/scenario-pools.sh refresh --only establishment.explore` after changing `requirements/scenario_establish_explore.yaml`.

---

## Known friction (exercise, don’t pre-fix)

| Issue | Symptom during explore |
|-------|-------------------------|
| #38a NAV lip stall | Sector cards stuck mid-patrol |
| #41 chunk visibility | Partial sector coverage |
| #42 `goto_near` 8s cap | Wallclock timeout on precise positioning |
| #36 fleet-status | Steward may duplicate cards without richer worker context |

Record card id, leg length, and error code for each stall — that is the intended PR-2 learning signal.

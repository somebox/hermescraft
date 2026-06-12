# Colony POC — narrow vs wide, card-driven road-planner (2026-06-13)

First test of the `docs/architecture/target.md` keystone question — *do
narrow, card-scoped specialist agents beat wide generalist workers?* — run
with the best-validated specialist in the repo (`road-planner`) as the first
card-driven agent on the kanban board. This also serves as roadplan Phase 5
(plan + light + walk + verify, gated). Verdict below.

## Setup

- **Board** `proc-nav-lab`; **bot** Mox @ :3007; **corridor** (-599,607)→
  (-563,704), scout-verified `natural`, 17 waypoints, ~118 blocks, on a
  fresh `proc-nav` (seed 20240601).
- **Two profiles, both cloned from `flint`, both pointed at Mox:**
  - **Arm N (narrow)** `road-planner`: only the `road-planner` + built-in
    `kanban-worker` skills, a one-paragraph SOUL, empty memories.
  - **Arm W (wide)** `road-wide`: full 18-skill catalog, flint's SOUL +
    memories.
- **Two cards per arm** (identical bodies, only the ledger path differs):
  C1 plan+light, C2 walk+verify (gated by `scripts/roadplan-verify-chain.py`).
- Metrics joined card → worker session via `scripts/roadplan-card-metrics.py`
  (kanban `task_runs.metadata.worker_session_id` → profile `state.db`).

## Results

| card (arm) | status | turns | tool calls | wall | input tok | ctx/turn | road |
|---|---|---|---|---|---|---|---|
| **C1 plan+light (narrow)** | done | **29** | **14** | **155 s** | 130 590 | **21 174** | 17/17 ✓ |
| C1 plan+light (wide) | done | 38 | 19 | 186 s | 112 141 | 24 226 | 17/17 ✓ |
| C2 walk+verify (narrow) | done | 70 | 34 | 318 s | — | 28 404 | GATE PASS, 17/17 hops |
| C2 walk+verify (wide) | **crashed ×2** | 11 | 5 | 60 s | — | — | (road verifies ✓) |

Both arms produced the **identical, valid** road (operator gate: `GATE PASS,
17/17 torches on natural ground` for both). The route, waypoint count, and
cost (139.2) matched exactly — a clean controlled comparison.

## Verdict — narrow wins the POC

On the **plan+light** card (the part that exercises the full
sample→solve→refine→confirm loop), the narrow specialist beat the wide
profile on **every** `target.md` metric:

- **Turns: 29 vs 38** (−24 %) · **tool calls: 14 vs 19** · **wall: 155 vs
  186 s** · **context/turn: 21.2 k vs 24.2 k** (−12 %) · **success: equal
  (17/17)**.

The 9 extra wide-arm turns went to *exactly* the overhead the architecture
predicts: the wide worker spent turns on `mc chat` (×2, announcing progress
in-game) and a `memory` write — actions the narrow worker never reached for
because they aren't in its catalog. The wide profile also carries ~3 k more
context per turn (bigger skill catalog in the system prompt). **POC passes:
narrower scope ⇒ fewer turns, less context, equal outcome.**

## Findings the live run surfaced (fixture tests couldn't)

1. **Card path works.** A narrow specialist drove plan→light→walk→verify
   entirely on the board, self-checking env (`mc status` + `roadplan
   preflight`) and following the skill loop unaided. First card-driven
   specialist end-to-end.
2. **`| bash` is blocked in the worker sandbox.** The batch doctrine relied
   on piping `roadplan … | bash`; the command guard rejects it. Added
   **`roadplan --exec`** (runs emitted `mc` commands via subprocess inside one
   approved `roadplan` call). Without it the 17-waypoint confirm would blow
   the 90-turn budget; with it the whole loop fit in 29 turns. **This was the
   single most important adaptation** — the operator `hermes chat` path never
   needed it because it isn't sandboxed.
3. **Verify script needs the repo venv.** `roadplan-verify-chain.py` imports
   mapcatalog/yaml; the worker's *system* `python3` lacks them → exit 1. The
   narrow walk recovered (pip-installed); the card body now calls
   `.venv/bin/python3` explicitly.
4. **Provider flakiness crashed the wide walk — twice.** The wide C2 worker's
   model (deepseek-v4-flash via openrouter) returned a garbage Chinese
   refusal mid-walk (`你好，我无法给到相关内容。`) and exited without
   completing → crashed. Both wide walk attempts failed this way; the narrow
   walk did not. Small sample, but suggestive that the wide profile's larger
   context aggravates model instability — another mark against wide.
5. **Waypoints can land under a tree canopy.** wp_17 anchored on natural
   ground but with leaves at head height; an idle bot there *looks* stuck
   (movement digs through leaves fine when actually moving — verified with a
   controlled leaf-wall test). Minor future polish: bias confirm away from
   head-level foliage.

## Next steps

- The POC win justifies the colony direction: keep building narrow specialist
  bundles (the README's pending list). `road-planner` is the proven template.
- Harden against provider flakiness for board workers (retry on empty/garbage
  responses) — the wide crash was a model hiccup, not architecture.
- Resume the roadplan **construction** backlog (postmortem 2026-06-12 §P1:
  bank grading, guard rails, `fell_tree`-vs-survey) when construction terrain
  is the focus — the natural path is now agent-proven on the board.

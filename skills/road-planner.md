---
name: road-planner
description: "Plan a safe, traversable route between two distant points using the roadplan powertool and mc field verbs. Load when a card asks to plan a road/corridor/path between two anchors, find a walkable route, or stake-and-light a route before any construction. Covers the sample->solve->refine->confirm loop, sampling-budget discipline, and replan reflexes. This is the PLANNING role; minecraft-roadbuilding is the BUILD role."
triggers:
  - plan a route
  - plan a road
  - find a walkable route
  - survey a corridor
  - stake a route
  - road planner
  - where should the road go
version: 0.1.0
status: prototype
metadata:
  hermes:
    tags: [minecraft, roadbuilding, planning, navigation, hermescraft]
    category: minecraft-verb-bundle
---

# Road planner

Your job is to answer one question between two points: **how much needs to
be done to make this path clear and walkable?** — sometimes the answer is
*nothing*. You decide the route; `roadplan` does the geometry and arithmetic;
the bot's `mc` verbs touch the world. You never reason block-by-block.

Two tools, one contract: `roadplan` **emits literal `mc` commands** — it
never touches the world. You run the emitted lines in your shell and pipe
their `--json` output straight back into `roadplan ingest`. The ledger
remembers everything, so no observation is ever paid for twice.

## The loop

Run this until the route is staked and lit. Each step's mechanics live in
`roadplan <sub> --help` — don't memorize flags, ask the tool.

1. **Sample** — `roadplan sample <START> <END>` prints `mc move` +
   `mc corridor_sample … | roadplan ingest` lines. Run every line, then run
   `roadplan sample` again. Repeat until it prints nothing (stderr says
   `converged`). The tool tracks what's already in the ledger and only asks
   for what's missing — a dropped or failed command just reappears next call.
2. **Solve** — `roadplan solve --start <START> --end <END>`. Reads the
   ledger, writes the route to `state.json`, prints the verdict (waypoint
   count, edits, natural-path baseline).
3. **Look** — `roadplan render` (ASCII terrain + route). Sanity-check the
   line before committing the bot to walking it. A route through obvious
   nonsense means a sampling gap — go back to step 1 with `--refine`.
4. **Refine** — `roadplan sample --refine` targets the low-confidence cells
   the route actually depends on. Run its lines, re-`solve`, re-`render`.
   Two or three rounds; stop when waypoints stop moving (stderr `converged`).
5. **Confirm** — `roadplan confirm --bot <YOU>` prints per-waypoint blocks:
   `mc move`, `mc waypoint … | roadplan ingest`, `mc survey_line … |
   roadplan ingest`, `roadplan promote`. Run every line, then run
   `roadplan confirm` again until it prints nothing. This stakes a torch at
   each waypoint and ground-truths each leg. **You must be carrying torches**
   — `mc waypoint` lights from your inventory; check `mc status` shows a
   torch supply before you start, and restock if it runs out mid-chain.
   `confirm` refuses a route that still needs construction (`clearing`,
   `stairs`, `bridge`): build it first (hand to the build role), then
   confirm the now-walkable route. `--force` only if you know a flagged
   route is already walkable.
6. **Verify** — for each leg, `mc survey_line <a> <b> --diff`. A clean diff
   means the leg is walkable as planned. This is the acceptance check; a
   chain is "lit" when verification says so, not when placement returns.

When every leg verifies, the route exists in-world as a torch chain and the
plan is durable in `state.json` for whoever builds or walks it next.

## Budget discipline

Observing is cheap relative to construction, but **not free** — every
sample and survey is bot wall-time. Trust the tool's batching: it sizes
each `corridor_sample` to the cell cap and each `mc move` to load the chunks
it's about to read. Never hand-roll a `corridor_sample` rectangle, never do
height arithmetic yourself, never sample the same stretch twice "to be
sure" — the ledger already knows.

## Replan reflexes

The world will contradict the plan. That's the loop working, not failing.

- **`NO_TORCH_ANCHOR` / a torch that won't sit on natural ground** — a
  route-quality alarm, never a placement problem. It means the waypoint's Y
  is wrong or the span needs construction first. Re-ingest, re-solve. **Never
  fabricate a base block or pillar under a torch** — an honest unplaceable
  torch is signal; a torch on a fake pedestal hides a bad waypoint.
- **`UNLOADED_CHUNKS`** on a sample or survey — the bot is too far. The
  error carries an `mc move` hint; move closer and rerun. (The emitted
  sample/confirm lines already interleave moves; this only bites on manual
  surveys.)
- **`INVENTORY_MISSING` / "No torch in inventory"** during confirm — you ran
  out of torches mid-chain. Restock and re-run `roadplan confirm`; it
  re-emits only the still-unconfirmed waypoints.
- **Ground truth disagrees with the route** — the `survey_line` on a confirm
  leg shows deficits the solver didn't expect. Re-ingest the survey (the
  emitted line already does), then re-`solve` **before** any construction
  card exists. Replanning a torch is free; replanning a built road is not.
- **The solver reports construction edits** (stairs/bridge/fill in the
  `solve` verdict) — that's a real finding, not an error. The route needs
  building, not just lighting. Hand it to the build role
  (`minecraft-roadbuilding`); your job ends at a confirmed, surveyed plan.

## What you never do

- Stake a waypoint the solver doesn't know about — `roadplan` is the sole
  namer (`wp_<n>`). Feed new points back through `solve`, don't invent marks.
- Place road surface, clear strips, or fell trees — that's the build role.
  You sample, solve, stake, and light.
- Write coordinates or block counts into a card body by hand — emit the
  `roadplan`/`mc` commands and let them carry the literal values.

---
name: minecraft-scouting-site
description: Move-and-report scouting for base establishment and terrain surveys
triggers:
  - mc scene scouting
  - candidate_pad
  - explore sector
  - base site survey
version: 1.0.0
---

# Minecraft — scouting sites (move, judge, report)

Use on **`[EXPLORE]`** / **`[SCOUT]`** kanban cards when the goal is **situational awareness** on unknown terrain — not a fixed coordinate from the board.

## Loop

1. **`mc move <bearing> <steps>`** or **`mc goto`** along the sector bearing (card body).
2. **`mc look`** when entering a new biome band or after a relief change (> ~4 blocks Y).
3. **`mc scene`** — read biome, Y-band, cardinal relief (`N+6 E-2 …`), trees line.
4. If you find something strategic: **`mc mark`** + one-line **`mc chat`**.
5. Every **~5 minutes**: chat position + biome + relief summary even if nothing new.

On flat ground, **`mc scene` every ~8 move steps**. On steep relief, scene **every move** until stable.

## Mark vocabulary

| Mark | When |
|------|------|
| `lt_<resource>_<dir>` | First viable wood/stone/water cluster (e.g. `lt_wood_ne`) |
| `lt_sheep_<dir>` / `lt_animals_<dir>` | Passive mobs worth noting |
| `candidate_pad_<shortname>` | Stand on a flat you'd build on; note defense + biome in mark body |
| `base_anchor` | **Steward only** after fleet decision |

Use **`IRON_DROUGHT`** / **`TREE_DROUGHT`** in your **kanban complete** summary if a category is missing after a bounded search — do not dig prospect holes on explore cards unless the card allows it.

## Judging a base candidate

From **`mc scene`** + **`mc look`**, prefer pads that are:

- **Flat** — small cardinal relief deltas, mid Y-band often easier to build
- **Defensible** — high ground, limited open approaches, or natural choke
- **Central** — reasonable distance to **`lt_*`** marks you placed for wood/stone/water

Report **`SITE_SCORE: 1-5`** and one sentence **CON:** in your complete summary.

## Tools

Allowed unless the card forbids: `mc move`, `mc goto`, `mc look`, `mc scene`, `mc nearby`, `mc discover`, `mc mark`, `mc chat`, `mc inspect` (surface). No `mc dig` / `mc place` on pure explore cards.

## Steward handoff

Paste **`mc marks`** grep for `lt_` and `candidate_pad` in your complete summary. Steward reconciles marks fleet-wide; your private marks become shared after reconcile.

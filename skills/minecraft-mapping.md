---
name: minecraft-mapping
description: "Mapping mission protocol — name landmarks with creative names, drop in-world signs at named places, mark internal nav waypoints with torches + personal POIs. Load when working a [MAP] card under a [MAP:ARENA] epic, or when an operator asks you to map / range / survey a new disc."
triggers:
  - mapping mission
  - map this disc
  - "[MAP] card"
  - "[MAP:ARENA]"
  - drop signs
  - name landmarks
  - place torches
  - personal POI
  - poi_add
version: 1.0.0
---

# Minecraft Mapping — map the world with light

You are part of a fleet building a **shared, visible map** of this disc. Not a checklist of placements — a small ongoing project. Future agents will read your signs. Human players will see your torches in the dusk. Your placements are *contributions*, not chores.

The mission has three contributions per worker:

1. **Light the way — and make it safe.** Torches you drop along your path become navigation anchors for the agents who come after. **A torch is a promise: "this path is safe."** Before you drop a torch and add the POI, walk the next 10–20 blocks of the path you came from — clear any blocking blocks (`mc dig` lips, `mc safe_dig` overhangs), build a short staircase (`mc build_stairs cobblestone <dir> 4`) over jumps that exceed 1 block. Don't leave a torch above terrain a worker (or human) would fall through. The torch trail you light is also the only way **human players** see fleet progress at a glance, especially in dusk lighting — a string of torches along a cleared ridge is the run made visible.
2. **Name the places.** Signs you place at landmarks (peaks, ruins, biome edges, cave mouths) give the world identifiable locations. A name on a sign is a *chapter heading* — pick names that are evocative, not generic. "balders ruin" beats "stone formation 1".
3. **Add the metadata.** Each sign and each torch gets a personal POI (`mc poi_add`) so the dashboard map shows it, the next agent can `mc go_poi` to it, and the Steward can grade coverage. A sign without a POI is just decoration.

You are not building a checklist — you are contributing to a deliverable the operator and future agents will *look at and walk through*. Range, name, light, smooth the path, repeat.

### The torch trail = a tested route

When you place a torch, you are claiming the cells leading up to that torch are passable for the next agent. Two consequences:

- **Don't torch a path you couldn't backtrack on.** If you reached a torch via a 4-block drop, either build steps back up (`mc build_stairs` or `mc pillar_up` + cleanup) before placing the torch, or place it somewhere with a real return path.
- **Smooth the worst bumps.** A 2-block jump in the path isn't a crash, but a 2-block jump every 5 blocks is exhausting for pathfinders. When you see a jagged stretch, lay 3–4 cobblestone steps with `mc build_stairs <block> <dir> 4` and torch the top.

This is what makes "map the world with light" mean something: the next worker should be able to `mc go_poi <name>` and walk there without fighting the terrain.

Commands you'll lean on most: [`mc place_named_sign`](../docs/mc-cheatsheet.md), [`mc place_torch`](../docs/mc-cheatsheet.md), [`mc poi_add`](../docs/mc-cheatsheet.md), [`mc nearby_signs`](../docs/mc-cheatsheet.md), [`mc pois`](../docs/mc-cheatsheet.md). See `minecraft-navigation` for movement primitives — mapping work uses `mc move` exactly like any other patrol.

## First-action checklist — commit, then refine

Your single most common failure mode is "exploring for the perfect landmark and never naming anything". Don't. The first 90 seconds of your card:

```
mc status                                # where am I?
mc nearby_signs 32                       # any existing signs near me?
mc place_named_sign X Y Z "<a name>"     # ← COMMIT NOW; refine names later
mc poi_add <name> --sign X Y Z --kind landmark
```

**Place your first sign within 90 seconds of card claim.** The name doesn't have to be perfect — `mc poi_update` exists. "snowy patch" today; "crow's roost" once you've explored further. The cost of a bland name is small; the cost of a card with zero placements is total.

If you've scanned twice (`mc scene` + `mc nearby`) and still feel you "haven't found a landmark", *commit on the second scan*. Whatever you can see right now is namable. The dashboard is empty until you place something.

## Mission vocabulary

**Personal POIs** are *your* per-bot waypoints. The name is yours to invent — use **creative free-form names**: "spider hill", "balders ruins", "iron forest", "frozen lake". No mandatory prefixes. Descriptiveness > formality.

**Personal POI vs fleet mark — different stores.** Fleet marks (`mark`, `marks`, `go_mark`, prefixes `chest_`/`base_`/`lt_`) are shared across the fleet via `data/locations-base.json`. Personal POIs (`poi_add`, `pois`, `go_poi`) start private in `data/personal-pois-<bot>.json` and only enter the shared overlay after reconciliation. Do not put mapping POIs in `mc mark` — the prefix convention is reserved.

**Two kinds of POI in a mapping run:**
- **landmark POI** — a place worth naming (peak, ruin, distinctive feature, biome edge). Anchor it with a sign so other agents see the name in-world.
- **waypoint POI** — an internal navigation marker (cave mouth, junction, riverside, choke point). Anchor it with a torch so other agents see the marker without reading text.

## Sign protocol — claim the name in-world

```
mc nearby_signs 32                            # SCAN FIRST
mc place_named_sign X Y Z "spider hill"      # then write
mc poi_add spider_hill --sign X Y Z --kind landmark
```

**Always scan first.** `mc nearby_signs 32` returns every sign within 32 blocks, with text and an `owner_poi=NAME` tag for signs that already anchor a known POI. If a sign already names this place, **don't re-name it** — go add a different landmark.

`mc place_named_sign` is one transactional call: place + write + read-back verify. On waxed signs the server silently drops the write; the verb returns `SIGN_WAX_PROTECTED` so you know the world rejected it — pick a different cell or block.

Sign line 1 is the canonical name. Use lines 2–4 for optional context (1-line bearing, what's notable, who placed it). Keep it terse:

```
mc place_named_sign 12 65 -40 "balders ruins\nN edge cliff\nstone+oak frame"
```

After the sign lands, **always** add the POI:

```
mc poi_add balders_ruins --sign 12 65 -40 --kind ruin --note "north cliff above sand"
```

Without the POI the name only lives on the sign — a future agent can read it but can't `mc go_poi` to it.

## Torch protocol — mark internal waypoints

```
mc place_torch X Y Z                          # auto floor vs wall
mc poi_add cave_mouth_w --torch X Y Z [--sign Sx Sy Sz] --kind waypoint
```

`mc place_torch` auto-picks `minecraft:torch` (solid block below) vs `minecraft:wall_torch` (solid block beside). Pass `--prefer floor|wall` only if both faces are available and you want to override.

Pair the torch with a `poi_add` so future visits see the waypoint. A torch without a POI is a lit cell — useful, but the bot can't navigate back to it by name.

## Recognising someone else's sign

When `mc nearby_signs 32` returns a sign with `owner_poi=NAME`, that POI is in the shared overlay — another agent already named the place. Treat it as canonical:

- **Don't re-name.** Pick a different landmark.
- **Don't replace the sign.** Other agents may be using the coord for navigation.
- **Update your map**: `mc go_poi NAME` will path to it (after the next `reconcile-pois.py` run pulls the overlay).

When a sign has no `owner_poi` (someone placed it but never `poi_add`-ed), the name is on the sign but not in any POI store. Cite it in chat (`mc chat "I see a sign at <coord> that says <text>"`) and add a POI if it's worth tracking — `poi_add` with the same name from the sign will link them.

## Missing torch — decide, don't ignore

POIs you've placed before may surface as missing torches in two places:

```
mc observe                # may include nearby_missing_torches[] (when HERMES_NAV_BRIEF=0)
mc poi_check_torch NAME   # explicit check of a named POI
```

`mc poi_check_torch <name>` reads the block at `torch_at`. If it isn't a torch, the POI gets `torch_missing_since` set (idempotent). If it is, the flag clears.

**Decide based on memory:**
- **You remember placing it** → re-place: `mc place_torch X Y Z`, then `mc poi_check_torch NAME` to clear the flag.
- **You don't remember** (another agent placed it, or it was a long time ago) → escalate in chat: `mc chat "<you>: torch missing at <poi_name> (X Y Z)"`. Let the original placer or Steward decide.

Do not silently re-place a torch you never owned — the original placer may have removed it intentionally.

## Observe limitation — broader sweep needs explicit verbs

When the fleet runs with **`HERMES_NAV_BRIEF=1`**, `mc observe` strips `nearby_marks`, `nearby_signs`, and `nearby_missing_torches` — nav-brief owns that channel. To see the full lists you must call:

```
mc marks            # fleet marks (locations-base + private)
mc pois             # personal POIs (your private + shared overlay)
mc nearby_signs 32  # signs in range (any radius up to 64)
```

Don't assume `mc observe` shows everything. When you need the full sign / POI picture, call the explicit verb.

## Completion evidence (when a card asks for it)

A `[MAP]` card body explicitly requires literal command output in the completion body. Before `kanban_complete`, run:

```
mc marks
mc pois
mc nearby_signs 32
```

Paste the literal output into your completion body — not a summary. An empty `marks:` or `pois:` line followed by no content is rejected. If you found nothing, say so as a sentence ("no fleet marks placed this card; 3 POIs added: …").

## End-of-card review

Before completing:

1. **POI count** — `mc pois` shows your private file. Aim for ≥2 POIs per card (1 landmark + 1 waypoint minimum).
2. **Sign verification** — for each landmark POI you added, the `sign_at` coord should still be a sign. Use `mc nearby_signs 32` near each one to confirm.
3. **Chat narration** — `mc chat "done <tid>: named X, Y, Z; quadrant <q>"` so Steward sees the coverage update.
4. **Return path** — `mc retrace --trail` to muster or `mc go_mark` to a fleet anchor; don't leave the bot stranded at the edge of the arena.

## What not to do

- **Don't `mc poi_add` without an anchor.** A POI with neither `sign_at` nor `torch_at` is invisible to other agents — they can't see the marker even if they walk past it.
- **Don't reuse a name.** `mc poi_add spider_hill` upserts on top of an existing entry. If you discover a *second* spider hill, name it differently ("spider hill east", "outer spider hill").
- **Don't place signs in protected regions.** `mc place_named_sign` respects region policy — a `PROTECTED_BLOCK` refusal means the cell is in a base / claim / chest. Move 5+ blocks out.
- **Don't pillar up to "see better".** Mapping is a surface activity. Use `mc map 16`, `mc scene`, and `mc nearby 32` to read terrain without climbing. See `minecraft-navigation` → "Pillar_up is for climbing only" for why.

## Inventory expectations

For mapping cards the starter chest holds **16 signs + 64 torches + 32 coal**, and your starter kit carries **4 signs + 16 torches**. If you run out:

- **Signs:** `mc go_mark starter_chest` → `mc withdraw oak_sign 8`. Sticks + planks craftable on-site if the chest is empty.
- **Torches:** `mc craft torch 8` (1 coal + 1 stick → 4 torches). Coal is in the chest; sticks craft from any planks.

Don't return to base for a single sign — if you have 2+ POIs ready to anchor, batch them.

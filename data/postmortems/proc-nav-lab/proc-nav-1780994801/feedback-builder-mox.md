# FEEDBACK — builder-mox on proc-nav-1780994801

## Problems hit

1. **`passage=deck` false positive on both segments.** The measurer classified segments 2 and 4 as `deck` (wide shallow dips, tree canopy misread as terrain), but in both cases the real ground was 1–2 blocks below surface — a simple dirt fill sufficed. Segment 2 had max_depth=1 across all its dip_spans; segment 4 was a spruce+snow tree canopy at Y=85–90 that the `terrain_top` pipeline read as solid ground. The pipeline over-classifies shallow terrain variation as requiring structural decking, which cost 1–2 extra evaluation cycles per segment.

2. **`level_ground` hits `no_solid_neighbor` on snow terrain.** In segment 2, `mc level_ground execute=true` failed on snow-covered cells because the collision/neighbor check didn't exclude `snow` and `snow_block` from the standing-surface search. Forced a fallback loop of piecewise `mc place dirt` (7+5+4 cells) to fill these gaps.

3. **No `mc deck` verb exists.** The card body and `passage=deck` classification reference `mc deck` as the primary verb, but the tool doesn't exist (still a planned verb, `minecraft-roadbuilding.md` step 3 option 3 says "Deck (manual, until `mc deck` lands)"). The worker had to manually decide whether to reclassify as fill or hand-place blocks.

4. **`$HERMESCRAFT_REPO` env var assumption.** The card body says `cat $HERMESCRAFT_REPO/data/runtime/proc-nav-road-plan.json` but this var is not injected at spawn — the worker had to discover it or fall back to metadata from the parent measurement card.

5. **Scratch workspace — no cross-segment state.** Each segment card runs in its own scratch workspace, so there's no shared state between segments. The road_plan.json that each card references is ephemeral; the worker depends on parent metadata for ground truth, which works but means a metadata mismatch propagates silently.

## Tooling improvements

1. **`mc level_ground` should handle snow metadata.** A `--ignore-snow` flag or built-in snow exclusion would have saved the fallback loop on segment 2. The verb knows the target Y; if snow blocks are above that Y, they should be treated as air for neighbor/standability checks.

2. **`mc deck` verb needs implementation.** The most-requested subcommand across both segments: a bulk bridge/deck verb that places a flat slab over a gap without requiring the bot to stand at the bank and hand-place each row. Until it lands, the `deck` passage classification forces agents to either reclassify (adding risk) or hand-place (adding time).

3. **`mc clear_strip` feedback on tree removal.** Segment 4 had a known spruce tree at Z=42. The tree was removed, but there was no clear "tree cleared" signal from `mc clear_strip` — the agent had to inspect after the fact. A return value indicating `wood_blocks_removed, leaf_blocks_removed` would close the loop without extra inspection.

## Bundle gaps (skills, SOUL, profile)

1. **`minecraft-roadbuilding.md` step 2 says "Deck (manual, until `mc deck` lands)"** but the card body assumes `mc deck` exists. The skill and card body are out of sync — the skill knows the verb doesn't exist yet, the card instructions assume it does. Either suppress `passage=deck` in the measurement pipeline, or implement `mc deck`.

2. **`agent-builder.md` §7 handoff metadata** is comprehensive for pad/place cards, but doesn't include road-specific fields like `segment_id`, `corridor_profile_diff`, `passage_actual`, or `obstacles_handled`. These had to be manually added to the metadata dict. The bundle should have a road-building metadata template.

3. **Heartbeat notes were empty** across all builder runs. The protocol says "name progress" for heartbeats, but nothing enforced it. Either the skill should explicitly require heartbeat notes, or the heartbeat tool should reject empty notes.

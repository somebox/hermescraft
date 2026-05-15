# G21 findings — 2026-05-13T23:55:38.195041+00:00

## Run metadata
- Spec: `G21_two_bot_house`
- Model: `deepseek/deepseek-v4-flash`
- Started: 2026-05-13T23:55:38.195041+00:00
- Ended: 2026-05-14T00:40:39.775230+00:00
- Wallclock: 2702s
- Verdict: **FAIL**

## Phase summary

| Phase | Mission | Done? | Reason | Start tick | End tick | Δ ticks | Warning fired |
|---|---|---|---|---|---|---|---|
| M0_RADIO_CHECK | M0A | ✓ | keyword | 6050 | 6350 | 300 | yes |
| M0_RADIO_CHECK | M0B | ✓ | keyword | 6050 | 6490 | 440 | yes |
| M1 | M1A | ✓ | timeout | 6550 | 13410 | 6860 | yes |
| M1 | M1B | ✓ | keyword | 6550 | 12490 | 5940 | yes |
| M2 | M2A | ✓ | keyword | 13510 | 16170 | 2660 | yes |
| M2 | M2B | ✓ | predicate | 13510 | 16670 | 3160 | yes |
| M3 | M3 | ✓ | wallclock | 16770 | — | — | no |

## Chat transcript

```
[23:56:31] <STEWARD> @mason please say "RADIO CHECK MASON SPEAKING" via mc chat, then read chat and reply with what @flint just said.
[23:56:32] <STEWARD> emit "M0 OK" once you have repeated @flint's radio-check phrase back to him.
[23:56:32] <STEWARD> @flint please say "RADIO CHECK FLINT SPEAKING" via mc chat, then read chat and reply with what @mason just said.
[23:56:32] <STEWARD> @flint please say "RADIO CHECK FLINT SPEAKING" via mc chat, then read chat and reply with what @mason just said.
[23:56:33] <STEWARD> emit "M0 OK" once you have repeated @mason's radio-check phrase back to him.
[23:56:34] <STEWARD> @mason — reminder: M0A due in 890 ticks, please wrap up. status?
[23:56:34] <STEWARD> @flint — reminder: M0B due in 890 ticks, please wrap up. status?
[23:56:35] <Mason> RADIO CHECK MASON SPEAKING
[23:56:40] <Mason> Flint said: READY: Flint standing by
[23:56:44] <Flint> RADIO CHECK FLINT SPEAKING
[23:56:46] <Mason> M0 OK
[23:56:49] <Flint> RADIO CHECK MASON SPEAKING
[23:56:52] <Flint> M0 OK
[23:56:56] <STEWARD> @mason please mine 60 cobblestone — there is a stone outcrop near MINING_HINT (-12,65,-12). deadline tick 11000. emit "M1A DONE" when finished.
[23:56:56] <STEWARD> @flint please get 16 oak_log from the trees, craft planks, build a chest at (-3,65,10) just west of KEEP_SITE, and put 20 oak_planks in it. deadline tick 11000. emit "M1B DONE" when finished.
[23:59:39] <STEWARD> @mason — reminder: M1A due in 1190 ticks, please wrap up. status?
[23:59:39] <STEWARD> @flint — reminder: M1B due in 1190 ticks, please wrap up. status?
[00:01:53] <Flint> M1B DONE
[00:02:44] <STEWARD> @mason please take cobble to the chest at (-3,65,10) (deposit 16+ cobble there for the platform), then build a 4x4 cobblestone PLATFORM at (-2 to 1, 65, 9 to 12) — that's 16 blocks. emit "SLAB READY" when the platform is done.
[00:02:45] <STEWARD> @flint please craft 1 wooden_door and stockpile 20 more oak_planks in your inventory. deadline tick 17000. emit "M2B DONE" when finished.
[00:02:45] <STEWARD> @flint please craft 1 wooden_door and stockpile 20 more oak_planks in your inventory. deadline tick 17000. emit "M2B DONE" when finished.
[00:04:39] <STEWARD> @mason — reminder: M2A due in 1190 ticks, please wrap up. status?
[00:04:39] <STEWARD> @flint — reminder: M2B due in 1190 ticks, please wrap up. status?
[00:04:56] <Mason> SLAB READY
[00:05:27] <STEWARD> @flint @mason please build a small house ON the platform at (-2 to 1, 65, 9 to 12).
[00:05:27] <STEWARD> @flint @mason please build a small house ON the platform at (-2 to 1, 65, 9 to 12).
[00:05:28] <specs> WALLS 3 high around the perimeter (cobble at y=66, 67, 68). The INTERIOR must be empty so a player can stand inside.
[00:05:28] <STEWARD> add 1 DOOR (wooden, in any wall) and 1 WINDOW (glass or glass_pane, in any wall).
[00:05:28] <STEWARD> add 1 DOOR (wooden, in any wall) and 1 WINDOW (glass or glass_pane, in any wall).
[00:05:29] <STEWARD> sand for glass is at the BEACH mark (12, 64, 12). decide together: smelt glass or use cobble for that wall slot.
[00:05:30] <STEWARD> first DECIDE who does what — chat to claim sub-tasks (e.g. "I will build the south + west walls"). DO NOT duplicate work.
[00:05:31] <STEWARD> BEFORE emitting "HOUSE COMPLETE", one of you MUST stand inside the house and run `mc is_sheltered` to verify it's enclosed.
[00:05:31] <STEWARD> BEFORE emitting "HOUSE COMPLETE", one of you MUST stand inside the house and run `mc is_sheltered` to verify it's enclosed.
[00:05:31] <Flint> M2B DONE
[00:05:31] <STEWARD> deadline tick 29000. emit "HOUSE COMPLETE" only after is_sheltered confirms the structure is sealed.
[00:05:32] <STEWARD> deadline tick 29000. emit "HOUSE COMPLETE" only after is_sheltered confirms the structure is sealed.
[00:17:14] <Mason> Flint, I'm stuck inside the walls. Can you mine 2 cobble at MINING_HINT and place them at 0,68,12 and 1,67,10 (last wall blocks), then put your door at 0,66,12?
```

## Observations (auto-derived)
- Steward broadcasts: 0
- Flint chat lines: 5
- Mason chat lines: 5
- Phases completed via keyword: 4
- Phases completed via predicate fallback: 1
- Phases that hit hard timeout: 1

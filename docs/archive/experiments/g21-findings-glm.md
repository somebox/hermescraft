# G21 findings — 2026-05-12T21:42:03.403059+00:00

## Run metadata
- Spec: `G21_two_bot_house`
- Model: `z-ai/glm-5.1`
- Started: 2026-05-12T21:42:03.403059+00:00
- Ended: 2026-05-12T22:00:20.902966+00:00
- Wallclock: 1097s
- Verdict: **PASS**

## Phase summary

| Phase | Mission | Done? | Reason | Start tick | End tick | Δ ticks | Warning fired |
|---|---|---|---|---|---|---|---|
| M1 | M1A | ✓ | predicate | 5693 | 10553 | 4860 | yes |
| M1 | M1B | ✓ | keyword | 5693 | 10553 | 4860 | yes |
| M2 | M2A | ✓ | keyword | 10653 | 11613 | 960 | no |
| M2 | M2B | ✓ | predicate | 10653 | 10693 | 40 | no |
| M3 | M3 | ✓ | keyword | 11713 | 2853 | -8860 | no |

## Chat transcript

```
[21:42:38] <STEWARD> @mason please mine 60 cobblestone — there is a stone outcrop near MINING_HINT (-12,65,-12). deadline tick 11000. emit "M1A DONE" when finished.
[21:42:39] <STEWARD> @flint please get 16 oak_log from the trees, craft planks, build a chest at (-3,65,10) just west of KEEP_SITE, and put 20 oak_planks in it. deadline tick 11000. emit "M1B DONE" when finished.
[21:46:05] <STEWARD> @mason — reminder: M1A due in 1187 ticks, please wrap up. status?
[21:46:05] <STEWARD> @flint — reminder: M1B due in 1187 ticks, please wrap up. status?
[21:46:05] <STEWARD> @flint — reminder: M1B due in 1187 ticks, please wrap up. status?
[21:46:40] <Flint> M1B DONE
[21:46:47] <STEWARD> @mason please take cobble to the chest at (-3,65,10) (deposit 16+ cobble there for the platform), then build a 4x4 cobblestone PLATFORM at (-2 to 1, 65, 9 to 12) — that's 16 blocks. emit "SLAB READY" when the platform is done.
[21:46:47] <STEWARD> @mason please take cobble to the chest at (-3,65,10) (deposit 16+ cobble there for the platform), then build a 4x4 cobblestone PLATFORM at (-2 to 1, 65, 9 to 12) — that's 16 blocks. emit "SLAB READY" when the platform is done.
[21:46:48] <STEWARD> @flint please craft 1 wooden_door and stockpile 20 more oak_planks in your inventory. deadline tick 17000. emit "M2B DONE" when finished.
[21:46:52] <Mason> M1A DONE
[21:47:32] <Mason> SLAB READY
[21:47:39] <STEWARD> @flint @mason please build a small house ON the platform at (-2 to 1, 65, 9 to 12).
[21:47:40] <spec> 3-block-high WALLS around the perimeter (cobble at y=66, 67, 68), 1 DOOR, and 1 WINDOW.
[21:47:41] <STEWARD> sand is at the BEACH mark (12, 64, 12) if you want glass for the window. decide together.
[21:47:42] <STEWARD> deadline tick 29000. either of you emits "HOUSE COMPLETE" when the house is genuinely finished.
[21:47:43] <Flint> M2B DONE
[22:00:16] <Flint> HOUSE COMPLETE
```

## Observations (auto-derived)
- Steward broadcasts: 0
- Flint chat lines: 3
- Mason chat lines: 2
- Phases completed via keyword: 3
- Phases completed via predicate fallback: 2
- Phases that hit hard timeout: 0

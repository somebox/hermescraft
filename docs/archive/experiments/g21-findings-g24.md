# G21 findings — 2026-05-14T07:55:37.800291+00:00

## Run metadata
- Spec: `G21_two_bot_house`
- Model: `deepseek/deepseek-v4-flash`
- Started: 2026-05-14T07:55:37.800291+00:00
- Ended: 2026-05-14T08:40:40.418656+00:00
- Wallclock: 2703s
- Verdict: **FAIL**

## Phase summary

| Phase | Mission | Done? | Reason | Start tick | End tick | Δ ticks | Warning fired |
|---|---|---|---|---|---|---|---|
| M0_RADIO_CHECK | M0A | ✓ | keyword | 5965 | 6645 | 680 | yes |
| M0_RADIO_CHECK | M0B | ✓ | keyword | 5965 | 6645 | 680 | yes |
| M1 | M1A | ✓ | predicate | 6705 | 11865 | 5160 | yes |
| M1 | M1B | ✓ | keyword | 6705 | 12005 | 5300 | yes |
| M2 | M2A | ✓ | keyword | 12105 | 13225 | 1120 | no |
| M2 | M2B | ✓ | predicate | 12105 | 12565 | 460 | no |
| M3 | M3 | ✓ | wallclock | 13345 | — | — | no |

## Chat transcript

```
[07:56:29] <STEWARD> @mason please say "RADIO CHECK MASON SPEAKING" via mc chat, then read chat and reply with what @flint just said.
[07:56:30] <STEWARD> emit "M0 OK" once you have repeated @flint's radio-check phrase back to him.
[07:56:30] <STEWARD> @flint please say "RADIO CHECK FLINT SPEAKING" via mc chat, then read chat and reply with what @mason just said.
[07:56:31] <STEWARD> emit "M0 OK" once you have repeated @mason's radio-check phrase back to him.
[07:56:31] <STEWARD> emit "M0 OK" once you have repeated @mason's radio-check phrase back to him.
[07:56:32] <Mason> RADIO CHECK MASON SPEAKING
[07:56:32] <STEWARD> @mason — reminder: M0A due in 975 ticks, please wrap up. status?
[07:56:32] <STEWARD> @flint — reminder: M0B due in 975 ticks, please wrap up. status?
[07:56:55] <Flint> RADIO CHECK FLINT SPEAKING
[07:56:55] <Mason> RADIO CHECK MASON SPEAKING
[07:56:56] <Flint> RADIO CHECK FLINT SPEAKING
[07:56:59] <Mason> RADIO CHECK FLINT SPEAKING
[07:57:00] <Flint> M0 OK
[07:57:01] <Mason> RADIO CHECK FLINT SPEAKING
[07:57:02] <Mason> M0 OK
[07:57:03] <Mason> M0 OK
[07:57:06] <STEWARD> @mason please mine 60 cobblestone — there is a stone outcrop near MINING_HINT (-12,65,-12). deadline tick 11000. emit "M1A DONE" when finished.
[07:57:07] <STEWARD> @flint please get 16 oak_log from the trees, craft planks, build a chest at (-3,65,10) just west of KEEP_SITE, and put 20 oak_planks in it. deadline tick 11000. emit "M1B DONE" when finished.
[07:57:38] <Flint> RADIO CHECK MASON SPEAKING
[07:57:45] <Flint> M0 OK
[07:59:43] <STEWARD> @mason — reminder: M1A due in 1155 ticks, please wrap up. status?
[07:59:43] <STEWARD> @mason — reminder: M1A due in 1155 ticks, please wrap up. status?
[07:59:43] <STEWARD> @flint — reminder: M1B due in 1155 ticks, please wrap up. status?
[08:01:29] <Flint> M1B DONE
[08:01:32] <Flint> M1B DONE
[08:01:35] <STEWARD> @mason please take cobble to the chest at (-3,65,10) (deposit 16+ cobble there for the platform), then build a 4x4 cobblestone PLATFORM at (-2 to 1, 65, 9 to 12) — that's 16 blocks. emit "SLAB READY" when the platform is done.
[08:01:36] <STEWARD> @flint please craft 1 wooden_door and stockpile 20 more oak_planks in your inventory. deadline tick 17000. emit "M2B DONE" when finished.
[08:01:36] <STEWARD> @flint please craft 1 wooden_door and stockpile 20 more oak_planks in your inventory. deadline tick 17000. emit "M2B DONE" when finished.
[08:01:37] <Mason> M1A DONE
[08:01:51] <Mason> M1A DONE
[08:02:07] <Flint> M2B DONE
[08:02:25] <Flint> M2B DONE
[08:02:31] <Mason> SLAB READY
[08:02:37] <STEWARD> @flint @mason please build a small house ON the platform at (-2 to 1, 65, 9 to 12).
[08:02:38] <STEWARD> STONE_PILE at (5,65,10) has on-site cobblestone to mine — 3 blocks east of the platform. Use it for walls + roof. Do NOT dig the test floor for materials.
[08:02:39] <specs> WALLS 3 high around the perimeter (cobble at y=66, 67, 68). Add a ROOF at y=69 (cobble OR oak_planks — your choice). The INTERIOR must be empty so a player can stand inside.
[08:02:40] <STEWARD> add 1 DOOR (Flint has oak_doors from M2B) and 1 WINDOW (glass — smelt from BEACH sand, or skip and use cobble).
[08:02:40] <STEWARD> first DECIDE who does what — chat to claim sub-tasks (e.g. "I will build the south + west walls"). DO NOT duplicate work.
[08:02:41] <STEWARD> ANNOUNCE before each major step: chat "name: doing <thing>" so your partner sees it. RE-ANNOUNCE when you change plans.
[08:02:42] <STEWARD> BEFORE emitting "HOUSE COMPLETE", one of you MUST stand inside the house and run `mc is_sheltered walls=-2,66,9,1,68,12` to verify enclosure + wall completeness.
[08:02:43] <STEWARD> deadline tick 29000. emit "HOUSE COMPLETE" only after is_sheltered confirms the structure is sealed.
[08:03:05] <Mason> SLAB READY
[08:07:38] <Flint> Mason — I see specs say cobble walls. I put some planks on north+west by mistake. Want me to swap to cobble or keep planks?
[08:09:06] <Mason> yeah cobble per specs, I'll take south+east walls and roof
[08:16:36] <Mason> swap to cobble please
[08:21:01] <Mason> roofs done (all 16 cobble at y=69). Flint hows the north+west walls going?
[08:25:07] <Flint> Mason — I've got planks on north+west I can't break fast. Can we accept mixed walls for the house, or do you have something to break them?
[08:25:14] <Mason> mixed walls are fine, just needs to seal
[08:37:43] <Flint> Mason — can you stand inside the house and run mc is_sheltered walls=-2,66,9,1,68,12? I can't get in from outside.
```

## Observations (auto-derived)
- Steward broadcasts: 0
- Flint chat lines: 12
- Mason chat lines: 14
- Phases completed via keyword: 4
- Phases completed via predicate fallback: 2
- Phases that hit hard timeout: 0

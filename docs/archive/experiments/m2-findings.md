# G21 findings — 2026-05-14T11:59:27.663712+00:00

## Run metadata
- Spec: `M2_navigate_build`
- Model: `deepseek/deepseek-v4-flash`
- Started: 2026-05-14T11:59:27.663712+00:00
- Ended: 2026-05-14T12:23:01.684972+00:00
- Wallclock: 1414s
- Verdict: **PASS**

## Phase summary

| Phase | Mission | Done? | Reason | Start tick | End tick | Δ ticks | Warning fired |
|---|---|---|---|---|---|---|---|
| M1 | M1 | ✓ | keyword | 5396 | 8016 | 2620 | yes |
| M2 | M2 | ✓ | keyword | 8076 | 10456 | 2380 | yes |
| M3 | M3 | ✓ | keyword | 10516 | 11296 | 780 | no |
| M4 | M4 | ✓ | keyword | 11376 | 12336 | 960 | no |
| M5 | M5 | ✓ | keyword | 12396 | 12876 | 480 | no |
| M6 | M6 | ✓ | keyword | 12956 | 13676 | 720 | no |
| M7 | M7 | ✓ | keyword | 13736 | 14656 | 920 | no |
| M8 | M8 | ✓ | keyword | 14716 | 15256 | 540 | no |
| M9 | M9 | ✓ | keyword | 15316 | 18256 | 2940 | yes |
| M10 | M10 | ✓ | keyword | 18316 | 19716 | 1400 | no |
| M11 | M11 | ✓ | keyword | 19776 | 20376 | 600 | no |
| M12 | M12 | ✓ | keyword | 20436 | 20796 | 360 | no |
| M13 | M13 | ✓ | keyword | 20856 | 21216 | 360 | no |
| M14 | M14 | ✓ | keyword | 21276 | 21636 | 360 | no |
| M15 | M15 | ✓ | keyword | 21716 | 22056 | 340 | no |
| M16 | M16 | ✓ | keyword | 22136 | 22476 | 340 | no |
| M17 | M17 | ✓ | keyword | 22556 | 22956 | 400 | no |
| M18 | M18 | ✓ | keyword | 23036 | 23456 | 420 | no |
| M19 | M19 | ✓ | keyword | 23516 | 23876 | 360 | no |
| M20 | M20 | ✓ | keyword | 23936 | 596 | -23340 | no |
| M21 | M21 | ✓ | keyword | 676 | 1076 | 400 | no |
| M22 | M22 | ✓ | keyword | 1156 | 1696 | 540 | no |
| M23 | M23 | ✓ | keyword | 1756 | 2356 | 600 | no |
| M24 | M24 | ✓ | keyword | 2416 | 3136 | 720 | no |
| M25 | M25 | ✓ | keyword | 3216 | 3616 | 400 | no |
| M26 | M26 | ✓ | keyword | 3696 | 4056 | 360 | no |
| M27 | M27 | ✓ | keyword | 4116 | 4536 | 420 | no |
| M28 | M28 | ✓ | keyword | 4596 | 6356 | 1760 | yes |
| M29 | M29 | ✓ | keyword | 6416 | 7696 | 1280 | no |
| M30 | M30 | ✓ | keyword | 7756 | 8476 | 720 | no |
| M31 | M31 | ✓ | keyword | 8536 | 9196 | 660 | no |

## Chat transcript

```
[11:59:48] <STEWARD> @builder M1: walk to C1 (-9 65 1), `mc list_container -9 65 1`, then `mc withdraw cobblestone 34 -9 65 1`.
[11:59:49] <STEWARD> Then build this wall run: `mc fill cobblestone -12 65 -3 0 66 -3` (13 cells, 26 blocks).
[11:59:50] <STEWARD> DO NOT seal D1 slot at (-4 65 -1). Emit `M1 DONE` when the run is up.
[12:01:10] <STEWARD> @builder — reminder: M1 due in 760 ticks, please wrap up. status?
[12:01:57] <builder> M1 DONE
[12:02:02] <STEWARD> @builder M2: walk to C1 (-9 65 1), `mc list_container -9 65 1`, then `mc withdraw cobblestone 24 -9 65 1`.
[12:02:03] <STEWARD> Then build this wall run: `mc fill cobblestone -12 65 -1 -5 66 -1` (8 cells, 16 blocks).
[12:02:04] <STEWARD> DO NOT seal D1 slot at (-4 65 -1). Emit `M2 DONE` when the run is up.
[12:03:24] <STEWARD> @builder — reminder: M2 due in 760 ticks, please wrap up. status?
[12:04:00] <builder> M2 DONE
[12:04:04] <STEWARD> @builder M3: walk to C1 (-9 65 1), `mc list_container -9 65 1`, then `mc withdraw cobblestone 16 -9 65 1`.
[12:04:05] <STEWARD> Then build this wall run: `mc fill cobblestone -3 65 -1 0 66 -1` (4 cells, 8 blocks).
[12:04:06] <STEWARD> DO NOT seal D1 slot at (-4 65 -1). Emit `M3 DONE` when the run is up.
[12:04:41] <builder> M3 DONE
[12:04:47] <STEWARD> @builder M4: walk to C1 (-9 65 1), `mc list_container -9 65 1`, then `mc withdraw cobblestone 10 -9 65 1`.
[12:04:48] <STEWARD> Then build this wall run: `mc fill cobblestone -12 65 0 -12 66 0` (1 cells, 2 blocks).
[12:04:48] <STEWARD> DO NOT seal D1 slot at (-4 65 -1). Emit `M4 DONE` when the run is up.
[12:05:33] <builder> M4 DONE
[12:05:38] <STEWARD> @builder M5: walk to C1 (-9 65 1), `mc list_container -9 65 1`, then `mc withdraw cobblestone 10 -9 65 1`.
[12:05:39] <STEWARD> Then build this wall run: `mc fill cobblestone -6 65 0 -6 66 0` (1 cells, 2 blocks).
[12:05:40] <STEWARD> DO NOT seal D1 slot at (-4 65 -1). Emit `M5 DONE` when the run is up.
[12:06:01] <builder> M5 DONE
[12:06:06] <STEWARD> @builder M6: walk to C1 (-9 65 1), `mc list_container -9 65 1`, then `mc withdraw cobblestone 10 -9 65 1`.
[12:06:07] <STEWARD> Then build this wall run: `mc fill cobblestone -12 65 1 -12 66 1` (1 cells, 2 blocks).
[12:06:07] <STEWARD> DO NOT seal D1 slot at (-4 65 -1). Emit `M6 DONE` when the run is up.
[12:06:40] <builder> M6 DONE
[12:06:45] <STEWARD> @builder M7: walk to C1 (-9 65 1), `mc list_container -9 65 1`, then `mc withdraw cobblestone 22 -9 65 1`.
[12:06:46] <STEWARD> Then build this wall run: `mc fill cobblestone -6 65 1 0 66 1` (7 cells, 14 blocks).
[12:06:47] <STEWARD> DO NOT seal D1 slot at (-4 65 -1). Emit `M7 DONE` when the run is up.
[12:07:30] <builder> M7 DONE
[12:07:34] <STEWARD> @builder M8: walk to C1 (-9 65 1), `mc list_container -9 65 1`, then `mc withdraw cobblestone 10 -9 65 1`.
[12:07:35] <STEWARD> Then build this wall run: `mc fill cobblestone -12 65 2 -12 66 2` (1 cells, 2 blocks).
[12:07:36] <STEWARD> DO NOT seal D1 slot at (-4 65 -1). Emit `M8 DONE` when the run is up.
[12:07:58] <builder> M8 DONE
[12:08:04] <STEWARD> @builder M9: walk to C1 (-9 65 1), `mc list_container -9 65 1`, then `mc withdraw cobblestone 34 -9 65 1`.
[12:08:05] <STEWARD> Then build this wall run: `mc fill cobblestone -12 65 3 0 66 3` (13 cells, 26 blocks).
[12:08:06] <STEWARD> DO NOT seal D1 slot at (-4 65 -1). Emit `M9 DONE` when the run is up.
[12:09:26] <STEWARD> @builder — reminder: M9 due in 760 ticks, please wrap up. status?
[12:10:28] <builder> M9 DONE
[12:10:34] <STEWARD> @builder M10: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 32 11 65 2`.
[12:10:35] <STEWARD> Then build this wall run: `mc fill cobblestone 1 65 -3 12 66 -3` (12 cells, 24 blocks).
[12:10:36] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M10 DONE` when the run is up.
[12:11:41] <builder> M10 DONE
[12:11:47] <STEWARD> @builder M11: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:11:48] <STEWARD> Then build this wall run: `mc fill cobblestone 5 65 -2 5 66 -2` (1 cells, 2 blocks).
[12:11:48] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M11 DONE` when the run is up.
[12:12:16] <builder> M11 DONE
[12:12:20] <STEWARD> @builder M12: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:12:21] <STEWARD> Then build this wall run: `mc fill cobblestone 12 65 -2 12 66 -2` (1 cells, 2 blocks).
[12:12:22] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M12 DONE` when the run is up.
[12:12:37] <builder> M12 DONE
[12:12:41] <STEWARD> @builder M13: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 14 11 65 2`.
[12:12:42] <STEWARD> Then build this wall run: `mc fill cobblestone 1 65 -1 3 66 -1` (3 cells, 6 blocks).
[12:12:43] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M13 DONE` when the run is up.
[12:12:57] <builder> M13 DONE
[12:13:02] <STEWARD> @builder M14: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:13:03] <STEWARD> Then build this wall run: `mc fill cobblestone 5 65 -1 5 66 -1` (1 cells, 2 blocks).
[12:13:04] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M14 DONE` when the run is up.
[12:13:18] <builder> M14 DONE
[12:13:23] <STEWARD> @builder M15: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:13:24] <STEWARD> Then build this wall run: `mc fill cobblestone 10 65 -1 10 66 -1` (1 cells, 2 blocks).
[12:13:25] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M15 DONE` when the run is up.
[12:13:40] <builder> M15 DONE
[12:13:45] <STEWARD> @builder M16: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:13:45] <STEWARD> Then build this wall run: `mc fill cobblestone 12 65 -1 12 66 -1` (1 cells, 2 blocks).
[12:13:46] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M16 DONE` when the run is up.
[12:14:02] <builder> M16 DONE
[12:14:06] <STEWARD> @builder M17: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:14:06] <STEWARD> Then build this wall run: `mc fill cobblestone 3 65 0 3 66 0` (1 cells, 2 blocks).
[12:14:07] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M17 DONE` when the run is up.
[12:14:26] <builder> M17 DONE
[12:14:30] <STEWARD> @builder M18: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:14:31] <STEWARD> Then build this wall run: `mc fill cobblestone 5 65 0 5 66 0` (1 cells, 2 blocks).
[12:14:31] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M18 DONE` when the run is up.
[12:14:48] <builder> M18 DONE
[12:14:54] <STEWARD> @builder M19: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 12 11 65 2`.
[12:14:55] <STEWARD> Then build this wall run: `mc fill cobblestone 7 65 0 8 66 0` (2 cells, 4 blocks).
[12:14:56] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M19 DONE` when the run is up.
[12:15:11] <builder> M19 DONE
[12:15:15] <STEWARD> @builder M20: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:15:16] <STEWARD> Then build this wall run: `mc fill cobblestone 12 65 0 12 66 0` (1 cells, 2 blocks).
[12:15:17] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M20 DONE` when the run is up.
[12:15:45] <builder> M20 DONE
[12:15:51] <STEWARD> @builder M21: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:15:52] <STEWARD> Then build this wall run: `mc fill cobblestone 3 65 1 3 66 1` (1 cells, 2 blocks).
[12:15:53] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M21 DONE` when the run is up.
[12:16:11] <builder> M21 DONE
[12:16:16] <STEWARD> @builder M22: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:16:16] <STEWARD> Then build this wall run: `mc fill cobblestone 5 65 1 5 66 1` (1 cells, 2 blocks).
[12:16:17] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M22 DONE` when the run is up.
[12:16:40] <builder> M22 DONE
[12:16:46] <STEWARD> @builder M23: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 12 11 65 2`.
[12:16:47] <STEWARD> Then build this wall run: `mc fill cobblestone 7 65 1 8 66 1` (2 cells, 4 blocks).
[12:16:48] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M23 DONE` when the run is up.
[12:17:15] <builder> M23 DONE
[12:17:19] <STEWARD> @builder M24: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 12 11 65 2`.
[12:17:20] <STEWARD> Then build this wall run: `mc fill cobblestone 11 65 1 12 66 1` (2 cells, 4 blocks).
[12:17:21] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M24 DONE` when the run is up.
[12:17:53] <builder> M24 DONE
[12:17:59] <STEWARD> @builder M25: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:17:59] <STEWARD> Then build this wall run: `mc fill cobblestone 3 65 2 3 66 2` (1 cells, 2 blocks).
[12:18:00] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M25 DONE` when the run is up.
[12:18:17] <builder> M25 DONE
[12:18:23] <STEWARD> @builder M26: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:18:24] <STEWARD> Then build this wall run: `mc fill cobblestone 9 65 2 9 66 2` (1 cells, 2 blocks).
[12:18:24] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M26 DONE` when the run is up.
[12:18:39] <builder> M26 DONE
[12:18:44] <STEWARD> @builder M27: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 10 11 65 2`.
[12:18:45] <STEWARD> Then build this wall run: `mc fill cobblestone 12 65 2 12 66 2` (1 cells, 2 blocks).
[12:18:45] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M27 DONE` when the run is up.
[12:19:02] <builder> M27 DONE
[12:19:08] <STEWARD> @builder M28: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 18 11 65 2`.
[12:19:09] <STEWARD> Then build this wall run: `mc fill cobblestone 1 65 3 5 66 3` (5 cells, 10 blocks).
[12:19:10] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M28 DONE` when the run is up.
[12:20:30] <STEWARD> @builder — reminder: M28 due in 760 ticks, please wrap up. status?
[12:20:33] <builder> M28 DONE
[12:20:39] <STEWARD> @builder M29: walk to C2 (11 65 2), `mc list_container 11 65 2`, then `mc withdraw cobblestone 20 11 65 2`.
[12:20:40] <STEWARD> Then build this wall run: `mc fill cobblestone 7 65 3 12 66 3` (6 cells, 12 blocks).
[12:20:41] <STEWARD> DO NOT seal D2 slot at (6 65 3). Emit `M29 DONE` when the run is up.
[12:21:39] <builder> M29 DONE
[12:21:46] <STEWARD> @builder M30: walk to chest at (-9 65 1), withdraw the oak_door: `mc withdraw oak_door 1 -9 65 1`.
[12:21:47] <STEWARD> Then place it at slot D1: `mc place oak_door -4 65 -1`. A door occupies y=65 and y=66 automatically.
[12:21:47] <STEWARD> Confirm with `mc inspect -4 65 -1`, then emit `M30 DONE`.
[12:22:21] <builder> M30 DONE
[12:22:25] <STEWARD> @builder M31: walk to chest at (11 65 2), withdraw the oak_door: `mc withdraw oak_door 1 11 65 2`.
[12:22:26] <STEWARD> Then place it at slot D2: `mc place oak_door 6 65 3`. A door occupies y=65 and y=66 automatically.
[12:22:27] <STEWARD> Confirm with `mc inspect 6 65 3`, then emit `M31 DONE`.
[12:22:56] <builder> M31 DONE
```

## Observations (auto-derived)
- Steward broadcasts: 0
- Flint chat lines: 0
- Mason chat lines: 0
- Phases completed via keyword: 31
- Phases completed via predicate fallback: 0
- Phases that hit hard timeout: 0

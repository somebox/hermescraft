# G21 findings — 2026-05-14T20:59:30.043880+00:00

## Run metadata
- Spec: `M3_focused`
- Model: `qwen/qwen3.6-flash`
- Started: 2026-05-14T20:59:30.043880+00:00
- Ended: 2026-05-14T21:03:07.310364+00:00
- Wallclock: 217s
- Verdict: **PASS**

## Phase summary

| Phase | Mission | Done? | Reason | Start tick | End tick | Δ ticks | Warning fired |
|---|---|---|---|---|---|---|---|
| F1 | F1 | ✓ | keyword | 5315 | 6295 | 980 | no |
| F2 | F2 | ✓ | keyword | 6355 | 8235 | 1880 | no |
| F3 | F3 | ✓ | keyword | 8295 | 9255 | 960 | no |

## Chat transcript

```
[20:59:47] <STEWARD> @builder F1: walk to the andesite block at (-2,65,2), `mc dig -2 65 2` then `mc collect andesite 1`.
[20:59:47] <STEWARD> Then walk to target (1,65,1) and `mc place andesite 1 65 1`.
[20:59:48] <STEWARD> Verify with `mc inspect 1 65 1`, then emit `F1 DONE`.
[21:00:34] <builder> F1 DONE
[21:00:38] <STEWARD> @builder F2: walk to C2 (11,65,2) — gates open automatically as you pathfind through them; `mc withdraw white_wool 1 11 65 2`.
[21:00:39] <STEWARD> Then walk to target (4,65,0) and `mc place white_wool 4 65 0`.
[21:00:40] <STEWARD> Verify with `mc inspect 4 65 0`, then emit `F2 DONE`.
[21:02:10] <builder> F2 DONE
[21:02:15] <STEWARD> @builder F3: walk to outside chest C_OUT (-17,65,-2) (west of spawn, no gate needed); `mc withdraw red_wool 1 -17 65 -2`.
[21:02:16] <STEWARD> Then walk to target (-10,65,0) and `mc place red_wool -10 65 0`.
[21:02:17] <STEWARD> Verify with `mc inspect -10 65 0`, then emit `F3 DONE`.
[21:03:01] <builder> F3 DONE
```

## Observations (auto-derived)
- Steward broadcasts: 0
- Flint chat lines: 0
- Mason chat lines: 0
- Phases completed via keyword: 3
- Phases completed via predicate fallback: 0
- Phases that hit hard timeout: 0

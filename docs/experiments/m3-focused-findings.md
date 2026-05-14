# G21 findings — 2026-05-14T18:44:08.910492+00:00

## Run metadata
- Spec: `M3_focused`
- Model: `deepseek/deepseek-v4-flash`
- Started: 2026-05-14T18:44:08.910492+00:00
- Ended: 2026-05-14T18:52:15.257725+00:00
- Wallclock: 486s
- Verdict: **PASS**

## Phase summary

| Phase | Mission | Done? | Reason | Start tick | End tick | Δ ticks | Warning fired |
|---|---|---|---|---|---|---|---|
| F1 | F1 | ✓ | keyword | 5481 | 11941 | 6460 | yes |
| F2 | F2 | ✓ | keyword | 12021 | 13281 | 1260 | no |
| F3 | F3 | ✓ | keyword | 13361 | 14621 | 1260 | no |

## Chat transcript

```
[18:44:34] <STEWARD> @builder F1: walk to the andesite block at (-2,65,2), `mc dig -2 65 2` then `mc collect andesite 1`.
[18:44:35] <STEWARD> Then walk to target (1,65,1) and `mc place andesite 1 65 1`.
[18:44:36] <STEWARD> Verify with `mc inspect 1 65 1`, then emit `F1 DONE`.
[18:47:46] <STEWARD> @builder — reminder: F1 due in 960 ticks, please wrap up. status?
[18:49:57] <builder> F1 DONE
[18:50:01] <STEWARD> @builder F2: walk to C2 (11,65,2) — gates open automatically as you pathfind through them; `mc withdraw white_wool 1 11 65 2`.
[18:50:02] <STEWARD> Then walk to target (4,65,0) and `mc place white_wool 4 65 0`.
[18:50:03] <STEWARD> Verify with `mc inspect 4 65 0`, then emit `F2 DONE`.
[18:51:02] <builder> F2 DONE
[18:51:08] <STEWARD> @builder F3: walk to outside chest C_OUT (-17,65,-2) (west of spawn, no gate needed); `mc withdraw red_wool 1 -17 65 -2`.
[18:51:09] <STEWARD> Then walk to target (-10,65,0) and `mc place red_wool -10 65 0`.
[18:51:09] <STEWARD> Verify with `mc inspect -10 65 0`, then emit `F3 DONE`.
[18:52:09] <builder> F3 DONE
```

## Observations (auto-derived)
- Steward broadcasts: 0
- Flint chat lines: 0
- Mason chat lines: 0
- Phases completed via keyword: 3
- Phases completed via predicate fallback: 0
- Phases that hit hard timeout: 0

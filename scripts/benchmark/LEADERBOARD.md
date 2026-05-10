# mc benchmark leaderboard

Run: `2026-05-10T15:21:05.481Z` (git e4f0a58)
Cheatsheet: 9771 bytes
Task groups: composition, direct

## Overall ranking

| # | Model | Accuracy | Errors | Cost/call | Avg latency |
|---|---|---:|---:|---:|---:|
| 1 | `gemma-4-31b-it` | 16/19 (84%) | 0 | $0.00108 | 4190ms |
| 2 | `deepseek-v4-flash` | 14/19 (74%) | 0 | $0.00072 | 2386ms |
| 3 | `minimax-m2.5` | 13/19 (68%) | 0 | $0.00229 | 2444ms |
| 4 | `nemotron-3-super-120b-free` | 12/19 (63%) | 0 | free | 8101ms |

## Per-group breakdown

### composition

| Model | Accuracy | Cost/call | Avg latency |
|---|---:|---:|---:|
| `deepseek-v4-flash` | 2/4 (50%) | $0.00074 | 2385ms |
| `nemotron-3-super-120b-free` | 1/4 (25%) | free | 9228ms |
| `gemma-4-31b-it` | 1/4 (25%) | $0.00109 | 3688ms |
| `minimax-m2.5` | 0/4 (0%) | $0.00253 | 1916ms |

### direct

| Model | Accuracy | Cost/call | Avg latency |
|---|---:|---:|---:|
| `gemma-4-31b-it` | 15/15 (100%) | $0.00108 | 4325ms |
| `minimax-m2.5` | 13/15 (87%) | $0.00223 | 2585ms |
| `deepseek-v4-flash` | 12/15 (80%) | $0.00072 | 2386ms |
| `nemotron-3-super-120b-free` | 11/15 (73%) | free | 7800ms |

## Failed tasks

- composition/shelter_corner on deepseek-v4-flash
- composition/shelter_corner on nemotron-3-super-120b-free
- composition/shelter_corner on gemma-4-31b-it
- composition/shelter_corner on minimax-m2.5
- composition/smelt_iron_pipeline on nemotron-3-super-120b-free
- composition/smelt_iron_pipeline on gemma-4-31b-it
- composition/smelt_iron_pipeline on minimax-m2.5
- composition/rescue_to_safehome on deepseek-v4-flash
- composition/rescue_to_safehome on nemotron-3-super-120b-free
- composition/rescue_to_safehome on gemma-4-31b-it
- composition/rescue_to_safehome on minimax-m2.5
- composition/scout_then_report on minimax-m2.5
- direct/mine_4_cobble on deepseek-v4-flash
- direct/mine_4_cobble on nemotron-3-super-120b-free
- direct/feed_cow on deepseek-v4-flash
- direct/feed_cow on nemotron-3-super-120b-free
- direct/feed_cow on minimax-m2.5
- direct/fight_zombie on nemotron-3-super-120b-free
- direct/fight_zombie on minimax-m2.5
- direct/deposit_iron on deepseek-v4-flash
- direct/deposit_iron on nemotron-3-super-120b-free

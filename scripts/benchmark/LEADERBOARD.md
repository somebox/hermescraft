# mc benchmark leaderboard

Run: `2026-05-10T15:11:48.697Z` (git d319406)
Cheatsheet: 9771 bytes
Task groups: composition, direct

## Overall ranking

| # | Model | Accuracy | Errors | Cost/call | Avg latency |
|---|---|---:|---:|---:|---:|
| 1 | `deepseek-v4-flash` | 18/19 (95%) | 0 | $0.00022 | 1685ms |
| 2 | `nemotron-3-super-120b-free` | 17/19 (89%) | 0 | free | 5923ms |

## Per-group breakdown

### composition

| Model | Accuracy | Cost/call | Avg latency |
|---|---:|---:|---:|
| `deepseek-v4-flash` | 3/4 (75%) | $0.00024 | 1274ms |
| `nemotron-3-super-120b-free` | 2/4 (50%) | free | 8321ms |

### direct

| Model | Accuracy | Cost/call | Avg latency |
|---|---:|---:|---:|
| `deepseek-v4-flash` | 15/15 (100%) | $0.00022 | 1795ms |
| `nemotron-3-super-120b-free` | 15/15 (100%) | free | 5284ms |

## Failed tasks

- composition/shelter_corner on deepseek-v4-flash
- composition/shelter_corner on nemotron-3-super-120b-free
- composition/smelt_iron_pipeline on nemotron-3-super-120b-free

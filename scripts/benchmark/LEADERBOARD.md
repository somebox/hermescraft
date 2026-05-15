# mc benchmark leaderboard

Run timestamp: `2026-05-10T23:13:22.754Z` (git 8215740)
Sources: **merged latest per model** (19 JSON files)
- `/Users/foz/hermescraft/scripts/benchmark/runs/deepseek__deepseek-v4-flash/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/google__gemini-2.5-flash-lite/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/google__gemma-4-26b-a4b-it/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/google__gemma-4-31b-it/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/inclusionai__ring-2.6-1t_colon_free/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/meta-llama__llama-3.1-8b-instruct/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/minimax__minimax-m2.5/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/mistralai__mistral-nemo/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/nvidia__nemotron-3-super-120b-a12b_colon_free/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/openai__gpt-4o-mini/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/openai__gpt-5-nano/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/openai__gpt-oss-120b/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/openrouter__owl-alpha/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/poolside__laguna-m.1_colon_free/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/qwen__qwen3-235b-a22b-2507/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/qwen__qwen3.5-flash-02-23/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/stepfun__step-3.5-flash/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/x-ai__grok-4.1-fast/2026-05-10T23-13-22-754Z-realistic.json`
- `/Users/foz/hermescraft/scripts/benchmark/runs/z-ai__glm-4.5-air/2026-05-10T23-13-22-754Z-realistic.json`
Cheatsheet: 12568 bytes
Task groups: challenges, composition, direct

## Overall ranking

| # | Model | Accuracy | Sem avg | Parse OK | Errors | Cost/call | Avg latency |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | `gpt-4o-mini` | 35/35 (100%) | 100% | 100% | 0 | $0.00082 | 578ms |
| 2 | `qwen3-235b-a22b-2507` | 32/35 (91%) | 94% | 98% | 0 | $0.00105 | 1472ms |
| 3 | `gemma-4-26b-a4b-it` | 31/35 (89%) | 93% | 100% | 0 | $0.00090 | 1411ms |
| 4 | `gemini-2.5-flash-lite` | 30/35 (86%) | 91% | 94% | 0 | $0.00107 | 572ms |
| 5 | `llama-3.1-8b-instruct` | 30/35 (86%) | 90% | 96% | 0 | $0.00022 | 892ms |
| 6 | `gemma-4-31b-it` | 27/35 (77%) | 80% | 100% | 6 | $0.00097 | 5226ms |
| 7 | `qwen3.5-flash` | 26/35 (74%) | 85% | 100% | 0 | $0.00081 | 1919ms |
| 8 | `mistral-nemo` | 26/35 (74%) | 79% | 88% | 3 | $0.00029 | 3305ms |
| 9 | `gpt-oss-120b` | 26/35 (74%) | 75% | 100% | 8 | $0.00051 | 5048ms |
| 10 | `laguna-m.1-free` | 25/35 (71%) | 74% | 100% | 3 | free | 4788ms |
| 11 | `deepseek-v4-flash` | 25/35 (71%) | 73% | 100% | 9 | $0.00070 | 4911ms |
| 12 | `nemotron-3-super-120b-free` | 19/35 (54%) | 54% | 100% | 13 | free | 7165ms |
| 13 | `minimax-m2.5` | 18/35 (51%) | 57% | 100% | 12 | $0.00106 | 6601ms |
| 14 | `grok-4.1-fast` | 17/35 (49%) | 50% | 100% | 17 | $0.00076 | 7216ms |
| 15 | `glm-4.5-air` | 17/35 (49%) | 49% | 100% | 3 | $0.00072 | 6541ms |
| 16 | `gpt-5-nano` | 16/35 (46%) | 47% | 100% | 15 | $0.00015 | 7270ms |
| 17 | `ring-2.6-1t-free` | 13/35 (37%) | 37% | 100% | 9 | free | 3700ms |
| 18 | `step-3.5-flash` | 8/35 (23%) | 23% | 100% | 0 | $0.00050 | 6610ms |
| 19 | `owl-alpha` | 5/35 (14%) | 14% | 100% | 30 | free | 2093ms |

## Per-group breakdown

### challenges

| Model | Accuracy | Sem avg | Parse OK | Cost/call | Avg latency |
|---|---:|---:|---:|---:|---:|
| `gemma-4-26b-a4b-it` | 9/9 (100%) | 100% | 100% | $0.00109 | 2186ms |
| `minimax-m2.5` | 9/9 (100%) | 100% | 100% | $0.00342 | 3251ms |
| `nemotron-3-super-120b-free` | 9/9 (100%) | 100% | 100% | free | 4538ms |
| `gpt-4o-mini` | 9/9 (100%) | 100% | 100% | $0.00094 | 675ms |
| `gpt-oss-120b` | 9/9 (100%) | 100% | 100% | $0.00072 | 2991ms |
| `laguna-m.1-free` | 9/9 (100%) | 100% | 100% | free | 3058ms |
| `qwen3-235b-a22b-2507` | 9/9 (100%) | 100% | 100% | $0.00101 | 1700ms |
| `gemini-2.5-flash-lite` | 8/9 (89%) | 95% | 89% | $0.00116 | 673ms |
| `llama-3.1-8b-instruct` | 8/9 (89%) | 95% | 100% | $0.00020 | 1291ms |
| `qwen3.5-flash` | 8/9 (89%) | 92% | 100% | $0.00078 | 1449ms |
| `deepseek-v4-flash` | 8/9 (89%) | 89% | 100% | $0.00093 | 3389ms |
| `mistral-nemo` | 7/9 (78%) | 84% | 88% | $0.00022 | 4222ms |
| `grok-4.1-fast` | 7/9 (78%) | 78% | 100% | $0.00139 | 5755ms |
| `glm-4.5-air` | 7/9 (78%) | 78% | 100% | $0.00065 | 5730ms |
| `gpt-5-nano` | 6/9 (67%) | 70% | 100% | $0.00021 | 5968ms |
| `gemma-4-31b-it` | 5/9 (56%) | 56% | 100% | $0.00093 | 7647ms |
| `ring-2.6-1t-free` | 4/9 (44%) | 44% | 100% | free | 3855ms |
| `step-3.5-flash` | 3/9 (33%) | 33% | 100% | $0.00055 | 6772ms |
| `owl-alpha` | 0/9 (0%) | 0% | — | free | 1025ms |

### composition

| Model | Accuracy | Sem avg | Parse OK | Cost/call | Avg latency |
|---|---:|---:|---:|---:|---:|
| `gpt-4o-mini` | 4/4 (100%) | 100% | 100% | $0.00078 | 596ms |
| `gpt-oss-120b` | 4/4 (100%) | 100% | 100% | $0.00056 | 5758ms |
| `gemini-2.5-flash-lite` | 3/4 (75%) | 86% | 100% | $0.00117 | 654ms |
| `gemma-4-26b-a4b-it` | 3/4 (75%) | 86% | 100% | $0.00127 | 1889ms |
| `gemma-4-31b-it` | 3/4 (75%) | 86% | 100% | $0.00136 | 4440ms |
| `llama-3.1-8b-instruct` | 2/4 (50%) | 64% | 88% | $0.00028 | 910ms |
| `qwen3-235b-a22b-2507` | 2/4 (50%) | 64% | 88% | $0.00108 | 1835ms |
| `deepseek-v4-flash` | 2/4 (50%) | 50% | 100% | $0.00041 | 8619ms |
| `qwen3.5-flash` | 1/4 (25%) | 56% | 100% | $0.00084 | 2243ms |
| `mistral-nemo` | 1/4 (25%) | 29% | 75% | $0.00011 | 8100ms |
| `ring-2.6-1t-free` | 1/4 (25%) | 25% | 100% | free | 6195ms |
| `nemotron-3-super-120b-free` | 1/4 (25%) | 25% | 100% | free | 8908ms |
| `gpt-5-nano` | 1/4 (25%) | 25% | 100% | free | 9793ms |
| `laguna-m.1-free` | 1/4 (25%) | 25% | 100% | free | 7599ms |
| `grok-4.1-fast` | 1/4 (25%) | 25% | 100% | $0.00024 | 9717ms |
| `glm-4.5-air` | 1/4 (25%) | 25% | 100% | $0.00089 | 7762ms |
| `minimax-m2.5` | 0/4 (0%) | 0% | — | free | 10003ms |
| `owl-alpha` | 0/4 (0%) | 0% | — | free | 1003ms |
| `step-3.5-flash` | 0/4 (0%) | 0% | — | $0.00050 | 7107ms |

### direct

| Model | Accuracy | Sem avg | Parse OK | Cost/call | Avg latency |
|---|---:|---:|---:|---:|---:|
| `gpt-4o-mini` | 22/22 (100%) | 100% | 100% | $0.00077 | 535ms |
| `qwen3-235b-a22b-2507` | 21/22 (95%) | 97% | 98% | $0.00107 | 1313ms |
| `llama-3.1-8b-instruct` | 20/22 (91%) | 93% | 95% | $0.00022 | 726ms |
| `gemma-4-26b-a4b-it` | 19/22 (86%) | 92% | 100% | $0.00075 | 1007ms |
| `gemini-2.5-flash-lite` | 19/22 (86%) | 91% | 95% | $0.00102 | 515ms |
| `gemma-4-31b-it` | 19/22 (86%) | 88% | 100% | $0.00092 | 4379ms |
| `mistral-nemo` | 18/22 (82%) | 87% | 89% | $0.00035 | 2058ms |
| `qwen3.5-flash` | 17/22 (77%) | 87% | 100% | $0.00082 | 2053ms |
| `laguna-m.1-free` | 15/22 (68%) | 72% | 100% | free | 4984ms |
| `deepseek-v4-flash` | 15/22 (68%) | 70% | 100% | $0.00066 | 4860ms |
| `gpt-oss-120b` | 13/22 (59%) | 61% | 100% | $0.00042 | 5761ms |
| `minimax-m2.5` | 9/22 (41%) | 50% | 100% | $0.00030 | 7353ms |
| `grok-4.1-fast` | 9/22 (41%) | 43% | 100% | $0.00060 | 7359ms |
| `nemotron-3-super-120b-free` | 9/22 (41%) | 41% | 100% | free | 7923ms |
| `gpt-5-nano` | 9/22 (41%) | 41% | 100% | $0.00014 | 7344ms |
| `glm-4.5-air` | 9/22 (41%) | 41% | 100% | $0.00072 | 6651ms |
| `ring-2.6-1t-free` | 8/22 (36%) | 36% | 100% | free | 3183ms |
| `owl-alpha` | 5/22 (23%) | 23% | 100% | free | 2728ms |
| `step-3.5-flash` | 5/22 (23%) | 23% | 100% | $0.00048 | 6454ms |

## Failed tasks

- challenges/terrain_surface_height_sample on deepseek-v4-flash
- composition/smelt_iron_pipeline on deepseek-v4-flash
- composition/rescue_to_safehome on deepseek-v4-flash
- direct/mine_4_cobble on deepseek-v4-flash
- direct/eat_food on deepseek-v4-flash
- direct/feed_cow on deepseek-v4-flash
- direct/fight_zombie on deepseek-v4-flash
- direct/deposit_iron on deepseek-v4-flash
- direct/build_fenced_enclosure on deepseek-v4-flash
- direct/dig_3x3_pit on deepseek-v4-flash
- challenges/background_smelt_batch on gemini-2.5-flash-lite
- composition/rescue_to_safehome on gemini-2.5-flash-lite
- direct/mine_4_cobble on gemini-2.5-flash-lite
- direct/feed_cow on gemini-2.5-flash-lite
- direct/open_chest_mark on gemini-2.5-flash-lite
- composition/rescue_to_safehome on gemma-4-26b-a4b-it
- direct/walk_to_coords on gemma-4-26b-a4b-it
- direct/open_chest_mark on gemma-4-26b-a4b-it
- direct/make_dirt_path on gemma-4-26b-a4b-it
- challenges/prefer_safe_dig_over_raw_dig on gemma-4-31b-it
- challenges/cancel_running_background_task on gemma-4-31b-it
- challenges/background_smelt_batch on gemma-4-31b-it
- challenges/terrain_surface_height_sample on gemma-4-31b-it
- composition/rescue_to_safehome on gemma-4-31b-it
- direct/walk_to_coords on gemma-4-31b-it
- direct/place_block on gemma-4-31b-it
- direct/read_chat on gemma-4-31b-it
- challenges/scout_hazards_before_mining on ring-2.6-1t-free
- challenges/prefer_safe_dig_over_raw_dig on ring-2.6-1t-free
- challenges/search_cached_chests_for_item on ring-2.6-1t-free
- challenges/terrain_surface_height_sample on ring-2.6-1t-free
- challenges/dump_cli_registry_json on ring-2.6-1t-free
- composition/smelt_iron_pipeline on ring-2.6-1t-free
- composition/rescue_to_safehome on ring-2.6-1t-free
- composition/scout_then_report on ring-2.6-1t-free
- direct/walk_to_coords on ring-2.6-1t-free
- direct/mine_4_cobble on ring-2.6-1t-free
- direct/place_block on ring-2.6-1t-free
- direct/feed_cow on ring-2.6-1t-free
- direct/find_iron on ring-2.6-1t-free
- direct/open_chest_mark on ring-2.6-1t-free
- direct/fight_zombie on ring-2.6-1t-free
- direct/deposit_iron on ring-2.6-1t-free
- direct/build_3block_wall on ring-2.6-1t-free
- direct/dig_3x3_pit on ring-2.6-1t-free
- direct/level_5x5_to_y64 on ring-2.6-1t-free
- direct/build_4step_staircase on ring-2.6-1t-free
- direct/make_dirt_path on ring-2.6-1t-free
- direct/pass_through_gate on ring-2.6-1t-free
- challenges/background_smelt_batch on llama-3.1-8b-instruct
- composition/shelter_corner on llama-3.1-8b-instruct
- composition/rescue_to_safehome on llama-3.1-8b-instruct
- direct/fight_zombie on llama-3.1-8b-instruct
- direct/make_dirt_path on llama-3.1-8b-instruct
- composition/shelter_corner on minimax-m2.5
- composition/smelt_iron_pipeline on minimax-m2.5
- composition/rescue_to_safehome on minimax-m2.5
- composition/scout_then_report on minimax-m2.5
- direct/walk_to_coords on minimax-m2.5
- direct/mine_4_cobble on minimax-m2.5
- direct/list_goals on minimax-m2.5
- direct/eat_food on minimax-m2.5
- direct/set_combat_skill on minimax-m2.5
- direct/feed_cow on minimax-m2.5
- direct/fight_zombie on minimax-m2.5
- direct/deposit_iron on minimax-m2.5
- direct/build_3block_wall on minimax-m2.5
- direct/build_fenced_enclosure on minimax-m2.5
- direct/dig_3x3_pit on minimax-m2.5
- direct/make_dirt_path on minimax-m2.5
- direct/pass_through_gate on minimax-m2.5
- challenges/background_smelt_batch on mistral-nemo
- challenges/dump_cli_registry_json on mistral-nemo
- composition/shelter_corner on mistral-nemo
- composition/smelt_iron_pipeline on mistral-nemo
- composition/rescue_to_safehome on mistral-nemo
- direct/feed_cow on mistral-nemo
- direct/open_chest_mark on mistral-nemo
- direct/build_fenced_enclosure on mistral-nemo
- direct/level_5x5_to_y64 on mistral-nemo
- composition/smelt_iron_pipeline on nemotron-3-super-120b-free
- composition/rescue_to_safehome on nemotron-3-super-120b-free
- composition/scout_then_report on nemotron-3-super-120b-free
- direct/mine_4_cobble on nemotron-3-super-120b-free
- direct/place_block on nemotron-3-super-120b-free
- direct/save_mark on nemotron-3-super-120b-free
- direct/eat_food on nemotron-3-super-120b-free
- direct/feed_cow on nemotron-3-super-120b-free
- direct/open_chest_mark on nemotron-3-super-120b-free
- direct/fight_zombie on nemotron-3-super-120b-free
- direct/deposit_iron on nemotron-3-super-120b-free
- direct/scene_8 on nemotron-3-super-120b-free
- direct/build_3block_wall on nemotron-3-super-120b-free
- direct/build_fenced_enclosure on nemotron-3-super-120b-free
- direct/dig_3x3_pit on nemotron-3-super-120b-free
- direct/build_4step_staircase on nemotron-3-super-120b-free
- challenges/navigate_building_use_move on gpt-5-nano
- challenges/search_cached_chests_for_item on gpt-5-nano
- challenges/background_smelt_batch on gpt-5-nano
- composition/smelt_iron_pipeline on gpt-5-nano
- composition/rescue_to_safehome on gpt-5-nano
- composition/scout_then_report on gpt-5-nano
- direct/walk_to_coords on gpt-5-nano
- direct/mine_4_cobble on gpt-5-nano
- direct/place_block on gpt-5-nano
- direct/feed_cow on gpt-5-nano
- direct/find_iron on gpt-5-nano
- direct/fight_zombie on gpt-5-nano
- direct/build_3block_wall on gpt-5-nano
- direct/build_fenced_enclosure on gpt-5-nano
- direct/dig_3x3_pit on gpt-5-nano
- direct/level_5x5_to_y64 on gpt-5-nano
- direct/build_4step_staircase on gpt-5-nano
- direct/make_dirt_path on gpt-5-nano
- direct/pass_through_gate on gpt-5-nano
- direct/mine_4_cobble on gpt-oss-120b
- direct/eat_food on gpt-oss-120b
- direct/feed_cow on gpt-oss-120b
- direct/fight_zombie on gpt-oss-120b
- direct/deposit_iron on gpt-oss-120b
- direct/build_fenced_enclosure on gpt-oss-120b
- direct/dig_3x3_pit on gpt-oss-120b
- direct/build_4step_staircase on gpt-oss-120b
- direct/pass_through_gate on gpt-oss-120b
- challenges/scout_hazards_before_mining on owl-alpha
- challenges/prefer_safe_dig_over_raw_dig on owl-alpha
- challenges/navigate_building_use_move on owl-alpha
- challenges/search_cached_chests_for_item on owl-alpha
- challenges/list_known_furnaces on owl-alpha
- challenges/cancel_running_background_task on owl-alpha
- challenges/background_smelt_batch on owl-alpha
- challenges/terrain_surface_height_sample on owl-alpha
- challenges/dump_cli_registry_json on owl-alpha
- composition/shelter_corner on owl-alpha
- composition/smelt_iron_pipeline on owl-alpha
- composition/rescue_to_safehome on owl-alpha
- composition/scout_then_report on owl-alpha
- direct/mine_4_cobble on owl-alpha
- direct/eat_food on owl-alpha
- direct/set_combat_skill on owl-alpha
- direct/feed_cow on owl-alpha
- direct/find_iron on owl-alpha
- direct/open_chest_mark on owl-alpha
- direct/fight_zombie on owl-alpha
- direct/set_reactive_mode on owl-alpha
- direct/deposit_iron on owl-alpha
- direct/scene_8 on owl-alpha
- direct/build_3block_wall on owl-alpha
- direct/build_fenced_enclosure on owl-alpha
- direct/dig_3x3_pit on owl-alpha
- direct/level_5x5_to_y64 on owl-alpha
- direct/build_4step_staircase on owl-alpha
- direct/make_dirt_path on owl-alpha
- direct/pass_through_gate on owl-alpha
- composition/shelter_corner on laguna-m.1-free
- composition/rescue_to_safehome on laguna-m.1-free
- composition/scout_then_report on laguna-m.1-free
- direct/mine_4_cobble on laguna-m.1-free
- direct/eat_food on laguna-m.1-free
- direct/feed_cow on laguna-m.1-free
- direct/fight_zombie on laguna-m.1-free
- direct/deposit_iron on laguna-m.1-free
- direct/build_3block_wall on laguna-m.1-free
- direct/build_fenced_enclosure on laguna-m.1-free
- composition/shelter_corner on qwen3-235b-a22b-2507
- composition/rescue_to_safehome on qwen3-235b-a22b-2507
- direct/build_4step_staircase on qwen3-235b-a22b-2507
- challenges/background_smelt_batch on qwen3.5-flash
- composition/smelt_iron_pipeline on qwen3.5-flash
- composition/rescue_to_safehome on qwen3.5-flash
- composition/scout_then_report on qwen3.5-flash
- direct/mine_4_cobble on qwen3.5-flash
- direct/feed_cow on qwen3.5-flash
- direct/deposit_iron on qwen3.5-flash
- direct/build_fenced_enclosure on qwen3.5-flash
- direct/build_4step_staircase on qwen3.5-flash
- challenges/scout_hazards_before_mining on step-3.5-flash
- challenges/prefer_safe_dig_over_raw_dig on step-3.5-flash
- challenges/navigate_building_use_move on step-3.5-flash
- challenges/cancel_running_background_task on step-3.5-flash
- challenges/background_smelt_batch on step-3.5-flash
- challenges/dump_cli_registry_json on step-3.5-flash
- composition/shelter_corner on step-3.5-flash
- composition/smelt_iron_pipeline on step-3.5-flash
- composition/rescue_to_safehome on step-3.5-flash
- composition/scout_then_report on step-3.5-flash
- direct/walk_to_coords on step-3.5-flash
- direct/mine_4_cobble on step-3.5-flash
- direct/place_block on step-3.5-flash
- direct/list_goals on step-3.5-flash
- direct/eat_food on step-3.5-flash
- direct/feed_cow on step-3.5-flash
- direct/find_iron on step-3.5-flash
- direct/fight_zombie on step-3.5-flash
- direct/deposit_iron on step-3.5-flash
- direct/scene_8 on step-3.5-flash
- direct/build_3block_wall on step-3.5-flash
- direct/build_fenced_enclosure on step-3.5-flash
- direct/dig_3x3_pit on step-3.5-flash
- direct/level_5x5_to_y64 on step-3.5-flash
- direct/build_4step_staircase on step-3.5-flash
- direct/make_dirt_path on step-3.5-flash
- direct/pass_through_gate on step-3.5-flash
- challenges/scout_hazards_before_mining on grok-4.1-fast
- challenges/search_cached_chests_for_item on grok-4.1-fast
- composition/shelter_corner on grok-4.1-fast
- composition/rescue_to_safehome on grok-4.1-fast
- composition/scout_then_report on grok-4.1-fast
- direct/walk_to_coords on grok-4.1-fast
- direct/mine_4_cobble on grok-4.1-fast
- direct/place_block on grok-4.1-fast
- direct/list_goals on grok-4.1-fast
- direct/read_chat on grok-4.1-fast
- direct/feed_cow on grok-4.1-fast
- direct/fight_zombie on grok-4.1-fast
- direct/deposit_iron on grok-4.1-fast
- direct/build_3block_wall on grok-4.1-fast
- direct/build_fenced_enclosure on grok-4.1-fast
- direct/dig_3x3_pit on grok-4.1-fast
- direct/level_5x5_to_y64 on grok-4.1-fast
- direct/build_4step_staircase on grok-4.1-fast
- challenges/prefer_safe_dig_over_raw_dig on glm-4.5-air
- challenges/cancel_running_background_task on glm-4.5-air
- composition/shelter_corner on glm-4.5-air
- composition/rescue_to_safehome on glm-4.5-air
- composition/scout_then_report on glm-4.5-air
- direct/walk_to_coords on glm-4.5-air
- direct/mine_4_cobble on glm-4.5-air
- direct/eat_food on glm-4.5-air
- direct/feed_cow on glm-4.5-air
- direct/find_iron on glm-4.5-air
- direct/fight_zombie on glm-4.5-air
- direct/deposit_iron on glm-4.5-air
- direct/build_3block_wall on glm-4.5-air
- direct/build_fenced_enclosure on glm-4.5-air
- direct/dig_3x3_pit on glm-4.5-air
- direct/build_4step_staircase on glm-4.5-air
- direct/make_dirt_path on glm-4.5-air
- direct/pass_through_gate on glm-4.5-air

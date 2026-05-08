# HermesCraft Homelab Experiment

Notes from running HermesCraft on a homelab Minecraft server with various LLM models via OpenRouter.

## Setup

- **Minecraft**: Paper 1.21.4 on ubuntu-host (192.168.1.202:25565) via Docker
- **Bots**: Mineflayer bot servers running locally on Mac, connecting to ubuntu-host
- **Agents**: Hermes Agent CLI running locally, controlling bots via `mc` CLI
- **Models**: Various OpenRouter models (DeepSeek V4, Nemotron, Tencent HY3, MiniMax, etc.)

## What we changed from upstream

### bot/server.js
- **Protected building blocks** in pathfinder (`blocksCantBreak`) — prevents bots from digging through houses during navigation
- **Protected blocks in `dig` command** — returns error instead of breaking building materials (planks, glass, doors, fences, crafting tables, furnaces, chests, torches, etc.)

### bin/mc
- **Shebang fix**: Changed from `#!/usr/bin/env bash` to `#!/opt/homebrew/bin/bash` — macOS system bash (3.2) has a quoting bug that mangles JSON in POST requests. Homebrew bash 5.x works correctly.
- **Port lock**: Added `_MC_API_URL_LOCKED` environment variable that prevents models from overriding the API URL with hallucinated port numbers.
- **`mc tips TOPIC`**: New command with context-specific gameplay help (chest, collect, craft, place, stuck, navigate).

### SOUL-minecraft.md
- **Block name reference** — exact Minecraft IDs (oak_log not oak, coal_ore not coal)
- **Fair-play gather pattern** — nearby → goto_near → collect workflow
- **Situational awareness** — Y-level guide, underground detection, unstuck instructions
- **Home base setup** — crafting table, chest, furnace placement duties
- **Crafting checklist** — check inventory → check recipe → check for table → craft → verify
- **Building rules** — never break structures, use doors, equip before placing
- **Smelt whitelist** — valid items only, prevents hallucinated recipes
- **Survival progression** — Phase 1-3 with exact mc commands
- **`mc tips`** reference — prominently featured for self-help

### hermescraft.sh
- Fixed API key loading for OpenRouter (not just Anthropic)

### New files
- **start-companion.sh** — Single companion launcher with restart loop, session continuation, all fixes
- **start-landfolk.sh** — Multi-agent launcher with per-agent model support, restart loops, community rules
- **prompts/landfolk/barley.md** — Food provider character (hunt, cook, stock chest)
- **prompts/landfolk/mason.md** — Builder character (walls, towers, fences, structures)

## How to run

### Single companion
```bash
./start-companion.sh MODEL
# Example:
./start-companion.sh deepseek/deepseek-v4-flash
```

### Multi-agent (landfolk)
```bash
./start-landfolk.sh MODEL
# MODEL is the fallback; each agent can have its own model defined in the AGENTS array
```

Edit `start-landfolk.sh` to configure agents. Format: `"Name:role:model"` (model optional):
```bash
AGENTS=(
  "Barley:food:nvidia/nemotron-3-super-120b-a12b:free"
  "Flint:stone:tencent/hy3-preview:free"
  "Mason:builder:deepseek/deepseek-v4-flash"
)
```

### Bot-only (for testing mc commands manually)
```bash
./start-landfolk.sh MODEL --bots-only
# Then test: mc status, mc nearby 32, mc collect oak_log 5, etc.
```

## Key tuning parameters

### Model selection
- **DeepSeek V4 Flash** — Best overall for Minecraft. Good tool calling, follows instructions, cheap.
- **Tencent HY3 Preview (free)** — Decent, occasional hallucinations. Works for simple roles like mining.
- **Nemotron 120B (free)** — Can work but sometimes runs commands without thinking text.
- **Small/free models** — Struggle with crafting sequences, hallucinate ports/coordinates, may try to run non-mc commands.
- **Minimum requirement**: 64K context, reliable tool calling. Sonnet-class is the quality floor for complex tasks.

### Hermes settings
- `--max-turns 500` — Tool call budget per round (default 90 is too low)
- `-t terminal,memory` — Restrict to only terminal + memory tools (prevents models from using browser, file editing, process management, etc.)
- `-s minecraft-survival -s minecraft-building` — Preload gameplay skills
- `--continue SESSION_NAME` — Resume previous session with context
- `memory_char_limit: 4400` — Doubled from default for more persistent knowledge

### Server settings (required for bots)
- `online-mode=false` in server.properties
- `connection-throttle: 0` in bukkit.yml
- Whitelist disabled
- Peaceful mode recommended while tuning

### Common issues and fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| Bot disconnects every 4-5s | `connection-throttle: 4000` in bukkit.yml | Set to `0` |
| Bot disconnects after reconnect storm | Corrupted player .dat file | Delete `/data/world/playerdata/UUID.dat` |
| `mc collect` fails ("can't see") | Fair-play visibility — block not in view cone | `mc nearby 32` → `mc goto_near X Y Z` → then collect |
| POST actions fail, GET works | macOS bash 3.2 JSON quoting bug | Use homebrew bash (`#!/opt/homebrew/bin/bash`) |
| Model uses wrong port | Hallucinating port numbers from context | `_MC_API_URL_LOCKED` env var in mc script |
| Model breaks walls/windows | Pathfinder `canDig=true` + direct `mc dig` | Protected blocks in both pathfinder and dig handler |
| Model runs curl/node/python | Too many hermes toolsets enabled | `-t terminal,memory` restricts to mc commands only |
| Model tries `mc connect` | Thinks bot is disconnected on action failure | Prompt rule + bot is auto-managed |
| Agent exits after task | `hermes chat -q` is single-shot mode | Restart loop with `--continue` for session persistence |
| Rate limits on free models | Multiple agents on same provider | Use different free models from different providers |

## Agent architecture

```
start-landfolk.sh
  ├── Bot server (node server.js) per agent on ports 3001, 3002, ...
  │     └── Mineflayer → Minecraft server (192.168.1.202:25565)
  └── Hermes agent per agent (restart loop)
        ├── SOUL prompt (SOUL-landfolk.md or SOUL-minecraft.md)
        ├── Character prompt (prompts/landfolk/NAME.md)
        ├── Community rules (injected)
        ├── Preloaded skills (minecraft-survival, minecraft-building)
        ├── Persistent memory (~/.hermes-landfolk-NAME/memories/)
        └── mc CLI → Bot server HTTP API → Mineflayer → Minecraft
```

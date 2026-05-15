# Bot server configuration

All env-var reads in `bot/lib/**` and `bot/server.js` should go through
`bot/lib/config/index.js`. The loader (`loadConfig()`) is called once at
startup from `bot/server.js` and the resulting object is threaded into
the factories that need it (state, manager, actions, ...).

A small `getConfig()` singleton exists for stateless helper modules
(e.g. `bot/lib/runtime/dig-tools.js`) that are called from many sites without
a `config` in scope.

## Environment variables

### Minecraft connection (`config.mc`)
| Env | Default | Purpose |
|---|---|---|
| `MC_HOST` | `localhost` | Minecraft server host |
| `MC_PORT` | `25565` | Minecraft server port |
| `MC_USERNAME` | `HermesBot` | Bot player name |
| `MC_AUTH` | `offline` | `offline` or `microsoft` |
| `MC_CONNECT_TIMEOUT_MS` | `55000` | TCP/login timeout, clamped 15s–120s |

### HTTP API (`config.api`)
| Env | Default | Purpose |
|---|---|---|
| `API_PORT` | `3001` | Bot HTTP API listen port |

### Behavioral flags (`config.behaviors`)
| Env | Default | Purpose |
|---|---|---|
| `FAIR_PLAY` | `true` | `false` disables x-ray / fairness checks (debug only) |
| `BOT_HEAR_ALL` | `false` | Bypass proximity filter for multi-bot tests |
| `BOT_ALLOW_PARKOUR` | `false` | Enable pathfinder parkour (looser, slower) |
| `BOT_ALLOW_DIG_INFRASTRUCTURE` | `false` | Relax PROTECTED_DIG_BLOCKS to ALWAYS_PROTECTED only |
| `MC_ALLOW_SLOW_DIG` | `false` | Disable slow-dig guard (force-through) |
| `MC_SLOW_DIG_TICKS_MAX` | `280` | Slow-dig guard ceiling (minimum 40) |
| `MC_CHAT_MIN_INTERVAL_MS` | `2500` | Chat rate-limit interval |
| `MC_DIG_DROP_SCAN_MS` | `300` | Post-dig drop-detection window |
| `REACTIVE` | `on` | `off` disables tactical autopilot tick |
| `COMBAT_SKILL` | *(unset)* | Optional numeric override for reactive combat skill |

### PaperMCP plugin (`config.papermcp`) — optional WebSocket bridge
| Env | Default | Purpose |
|---|---|---|
| `PAPERMCP_HOST` | falls back to `MC_HOST`, then `localhost` | PaperMCP server host |
| `PAPERMCP_PORT` | `25577` | PaperMCP WebSocket port |
| `PAPERMCP_TOKEN` | *(secret)* | Auth token; **required** to enable. From `.env`. |

### Agent / Hermes routing (`config.agent`)
| Env | Default | Purpose |
|---|---|---|
| `AGENT_PROFILE` | `config.mc.username` | Hermes profile name displayed in /health |
| `AGENT_MODEL` | *(unset)* | LLM model slug (e.g. `anthropic/claude-sonnet-4`) |
| `AGENT_PROVIDER` | *(unset)* | LLM provider (`openrouter`, `anthropic`, ...) |
| `AGENT_MODELS_JSON` | *(unset)* | Path to `data/agent-models.json` (used by launch scripts) |

### Logging (`config.logging`)
| Env | Default | Purpose |
|---|---|---|
| `LOG_DIR` | *(unset)* | Hermes / bot log directory |
| `MC_DEBUG_LOG` | *(unset)* | Debug log path for the `mc` CLI |
| `MC_CLI_ERRORS_MULTILINE` | `false` | Multi-line error formatting for `mc` CLI output |

## Secrets

- `PAPERMCP_TOKEN` is loaded from the repo's `.env` (gitignored). See
  `/Users/foz/hermescraft/.env.example`.
- `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` are loaded by the launch
  scripts from `$HOME/.hermes/.env`, not from this loader. The bot server
  itself does not need them — only the Hermes agent process does.
- `openrouter_api_key` in `secrets.yaml` is consumed only by the
  `scripts/benchmark/` and `scripts/eval-grammar/` standalone runners.

## CLI argv overrides

`loadConfig()` also accepts a few argv flags (passed straight through to
`node server.js`): `--port`, `--mc-host`, `--mc-port`, `--username`, `--auth`.

## Out of scope (Round 2)

- `_MC_API_URL_LOCKED`, `MC_API_URL` — Hermes process env, set by launch
  scripts. Not bot-server config.
- `BASE_API_PORT` — launch-time only (multi-bot port allocation in
  `landfolk.sh` / `civilization.sh`).

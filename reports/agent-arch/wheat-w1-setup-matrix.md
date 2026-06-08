# W1 wheat capstone — setup / teardown matrix

Maps each layer to **reset**, **preflight**, and **operator** steps. Canonical mark names:
`wheat_plot`, `wheat_chest`, `wheat_start` (see `data/test-fixtures/colony/wheat_capstone.yaml`
and `scripts/validate-wheat-fixture.sh`).

| Layer | Reset (`scripts/reset-wheat-capstone.sh`) | Preflight (`scripts/preflight-wheat.sh`) | Operator / setup |
|---|---|---|---|
| Trial PIDs | Kill `/tmp/wheat-runner-pid`, `/tmp/wheat-dispatcher-pid`; pkill role + pilot-mox workers | — | Stop dispatcher before reset |
| Kanban `wheat-capstone` | Archive all cards on board | Board exists (WARN if missing) | Runner creates board on first create |
| World fixture | `run-fixture.sh cleanup` wheat_capstone.yaml | Mox position, inventory, marks, water, chest (rcon) | `run-fixture.sh prep` after reset |
| Fixture bounds | — | — | `scripts/validate-wheat-fixture.sh` after prep |
| Bots | tp Mox + Tester to spawn | Mox :3007 HTTP, Tester :3004 | `scripts/colony start mox`, `scripts/run-tester-bot.sh` |
| Role profiles | Zero `navigator|builder|farmer|crafter` `MEMORY.md` | Dirs exist; **no** `MC_*` in `.env` when `W1_MODE=role` | `prototypes/agent-arch/setup-role-profiles.sh` |
| pilot-mox (legacy) | Zero `pilot-mox` memory | Required when `W1_MODE` unset | `setup-pilot-mox-live.sh` (5b only) |
| Skills | Reinstall via setup script (caller) | Repo gate: `capstone/preflight.sh` | `audit-skill-verbs.py` optional |
| Crons / harvest | Fixture cleanup + reset counts crons | — | x003 arms cron; reset should leave 0 reminders |
| MC inject (W1) | — | Dispatcher exports Mox `MC_*` (live trial) | `scripts/wheat-dispatcher.sh` |
| `bin/mc` shim (W1) | Reinstall via setup script | — | `profiles/<role>/bin/mc` defaults to Mox; **remove at W4** when fleet routing replaces per-profile wrappers |
| Hermes env | `HERMES_HOME=~/.hermes` | Same | Export before all `hermes` / runner calls |

**W1_MODE=role:** preflight checks four role profiles and MC leak grep; does not require `pilot-mox`.

**Manual-only (documented, not automated):** `OPENROUTER_API_KEY` in role `.env` (setup copies from flint); `MC_HOST` for colony on remote world; gate-check side effects on other boards (note in runbook).

# Two-bot trial 3+ — runbook (live HERMES_HOME + dashboard-visible)

Trial 3 lands cards on the **live** Hermes home (`~/.hermes/`) under a
custom board (`two-bot-demo`), so the existing `:9119` dashboard shows
them with no second dashboard process needed. Workers spawn from
`~/.hermes/profiles/pilot-{pip,zee}/` (set up by
`setup-pilot-pip-zee-live.sh`).

**Trial 3 result (2026-06-07):** PASS. 13/13 cards done; 483 s
parallelism overlap; sign at seed; handoff contract green. Full report
in [`2026-06-07-two-bot-trial-3-postmortem.md`](2026-06-07-two-bot-trial-3-postmortem.md).
This runbook is for trial 4+ — applies the trial-3 lessons.

## Why this layout

| Concern | Proto rig (trials 1, 2) | Trial 3 |
|---|---|---|
| HERMES_HOME | `~/.hermes-proto-agent-arch/` | `~/.hermes/` |
| Pilots installed at | `~/.hermes-proto-agent-arch/profiles/pilot-*/` | `~/.hermes/profiles/pilot-*/` |
| Kanban DB | `~/.hermes-proto-agent-arch/kanban.db` | `~/.hermes/state.db` (shared with live boards) |
| Workspace layout | flat (`kanban/workspaces/t_<id>/`) | boards (`kanban/boards/two-bot-demo/workspaces/t_<id>/`) |
| Visible on `:9119` | no (dashboard reads `~/.hermes/`) | **yes** |
| Conflicts with landfolk-ops? | no (different HERMES_HOME) | no (different `--board`; live dispatcher uses `--board landfolk-ops`) |

The dispatcher loop reads cards from the `two-bot-demo` board only;
landfolk's loop reads the `landfolk-ops` board only. They share a
kanban.db but never claim each other's cards.

## Prereqs (from trial 2 postmortem)

Already landed:

- [x] `agent-builder.md` — placement-reachability discipline, fill-flag form, cross-bot coordination
- [x] `mc collect` headline rewrite (commit `a7fe2b7`)
- [x] Pilot config parity (compression / memory / tool_output) — replicated by `setup-pilot-pip-zee-live.sh`
- [x] Floor stack in fixture (dirt / 4×stone / bedrock) — already in `data/test-fixtures/open/two_bot_base.yaml`
- [x] `acceptance.py` nested-`data.satisfied` fix
- [x] `--board` flag wired through `run_two_bot_base.py` + `author.py`

Pre-trial-3 audit:

```bash
python scripts/audit-skill-verbs.py --bundles navigator,builder,crafter,miner
# expect: 4× OK

.venv/bin/python -m pytest prototypes/agent-arch/tests/test_capstone_scaffold.py \
                          prototypes/agent-arch/tests/test_two_bot_base_graph.py -q
# expect: 57 passed
```

## One-time setup (live pilots)

```bash
# Install pilot-pip + pilot-zee under ~/.hermes/ (will NOT touch
# ~/.hermes/profiles/{flint,mason,gatherer,barley,steward}).
prototypes/agent-arch/setup-pilot-pip-zee-live.sh

# Verify
HERMES_HOME=~/.hermes hermes profile show pilot-pip   # 10 skills, model pinned
HERMES_HOME=~/.hermes hermes profile show pilot-zee
```

The script idempotently overwrites `config.yaml`, `SOUL.md`, and `.env`,
but doesn't touch `state.db`, `memories/`, or `sessions/` if they
already exist from a previous run.

### About the board (`two-bot-demo`)

As of post-trial-3, `run_two_bot_base.py` **auto-creates the board** on
the first card-create call (via `hermes kanban boards create
two-bot-demo` which is idempotent — second call returns "Board already
exists" with exit 0). No manual board-create step is needed.

If you want a different board name, pass `--board <slug>` to both the
runner and the dispatcher loop; the runner ensures it exists.

## Trial 3 launch

### 1. Reset arena + bots (same as trial 2)

```bash
# Tester pointing at the same world
scripts/run-tester-bot.sh

# Stop any leftover trial-2 bots, then start colony with MC_HOST set
pgrep -f "node server" | xargs kill -9 2>/dev/null
scripts/run-tester-bot.sh
MC_HOST=192.168.1.202 scripts/colony start --all

# Reset world fixture (thicker floor + chests + marks)
scripts/reset-open-test.sh
```

### 2. Smoke the new collect fix on Tester

```bash
# Stage 5 test cobble in front of Tester (currently at 0, 65, 0)
ssh -n ubuntu-host "sudo docker exec minecraft rcon-cli 'give Tester minecraft:iron_pickaxe 1'"
ssh -n ubuntu-host "sudo docker exec minecraft rcon-cli 'execute in landfolk-test run fill 2 65 0 6 65 0 minecraft:cobblestone'"
MC_API_URL=http://127.0.0.1:3004 mc collect cobblestone 5
# expect: "Collected N/5 cobblestone in inventory (mined N blocks)…"
# NOT: "Mined 5/5 cobblestone…"

# Clean up
ssh -n ubuntu-host "sudo docker exec minecraft rcon-cli 'execute in landfolk-test run fill 2 65 0 6 65 0 minecraft:air'"
ssh -n ubuntu-host "sudo docker exec minecraft rcon-cli 'clear Tester'"
```

### 3. Launch trial 3

```bash
# Runner + dispatcher loop in separate background processes
RUN_ID="trial-$(date +%s)"
echo "$RUN_ID" > /tmp/two-bot-current-run-id
RUNNER_LOG="/tmp/two-bot-runner-${RUN_ID}.log"
DISPATCHER_LOG="/tmp/two-bot-dispatcher-${RUN_ID}.log"

HERMES_HOME=~/.hermes \
  python prototypes/agent-arch/capstone/run_two_bot_base.py \
  --run-id "$RUN_ID" --board two-bot-demo --watch \
  > "$RUNNER_LOG" 2>&1 &
echo $! > /tmp/two-bot-runner-pid

(
  export HERMES_HOME=~/.hermes
  while true; do
    echo "[$(date -Iseconds)] tick" >> "$DISPATCHER_LOG"
    hermes kanban --board two-bot-demo dispatch --max 5 >> "$DISPATCHER_LOG" 2>&1
    sleep 10
  done
) &
echo $! > /tmp/two-bot-dispatcher-pid
```

### 4. Watch live

- **Dashboard**: http://127.0.0.1:9119/kanban — should now show a
  `two-bot-demo` board with 13 cards
- **Log follower** (per-pilot reasoning + tool calls):
  ```bash
  HERMES_HOME=~/.hermes scripts/proto-logs-follow.py --quiet
  # The script auto-detects HERMES_HOME from env. State.db reads from
  # ~/.hermes/profiles/pilot-{pip,zee}/state.db
  ```
- **Bot logs**: `tail -F /tmp/hermescraft/bot-{pip,zee}.log`
- **CLI snapshot**: `HERMES_HOME=~/.hermes hermes kanban --board two-bot-demo list`

### 5. After trial completes

```bash
# Move Tester to seed area so the chunk loads for verify
ssh -n ubuntu-host "sudo docker exec minecraft rcon-cli 'execute in landfolk-test run tp Tester 300 70 300'"
sleep 4

# Stop dispatcher
kill $(cat /tmp/two-bot-dispatcher-pid) 2>/dev/null

# Score
HERMES_HOME=~/.hermes \
  python prototypes/agent-arch/capstone/run_two_bot_base.py \
  --run-id "$RUN_ID" --board two-bot-demo --evaluate-only

# Handoff contract
TWO_BOT_RUN_ID="$RUN_ID" HERMES_HOME=~/.hermes \
  .venv/bin/python -m pytest \
  prototypes/agent-arch/tests/test_two_bot_base_handoff_contract.py -v
```

### Scorecard interpretation

Same 3-number band as trials 1 + 2:

| # | Number | Target |
|---|---|---|
| 1 | `parallelism_observed` + `overlap_s` | true / ≥ 60 s |
| 2 | `pip_done_count` / `zee_done_count` | 7/7 and 6/6 |
| 3 | `sign_at_seed` | true |

Trial 3 hypothesis: same scorecard as trial 2 (pass), but with cards
**visible on the live dashboard the whole time**. If the cards behave
differently when scheduled on the live kanban-loop's tick (vs the
hand-rolled bash dispatcher), that's the real signal — we'd expect
sequencing to be identical because the gate-check + mutex code is the
same.

## Rollback / cleanup

If trial 3 doesn't go well, the proto rig still works:

```bash
HERMES_HOME=~/.hermes-proto-agent-arch \
  python prototypes/agent-arch/capstone/run_two_bot_base.py \
  --run-id rollback-$(date +%s) --watch
# (no --board flag → original proto behaviour)
```

To remove the live pilot profiles entirely:

```bash
rm -rf ~/.hermes/profiles/pilot-pip ~/.hermes/profiles/pilot-zee
# the live flint/mason/etc. profiles are untouched
```

## Differences trial 2 → trial 3

| Aspect | Trial 2-B | Trial 3 |
|---|---|---|
| HERMES_HOME | proto-agent-arch | live `~/.hermes/` |
| Board | (none — flat workspaces) | `two-bot-demo` |
| Visible at `:9119` | no | **yes** |
| Pilot profiles | proto home | live home |
| Workers' `state.db` | proto profiles | live profiles |
| Memory files | proto `memories/` | live `memories/` (new dir per pilot) |
| Skill bundles | same | **same** (read from `skills/` either way) |
| Fixture / arena | same | same |
| Runner code | same | same (`--board` flag passes through) |
| Acceptance | same `mc verify at_mark seed` | same |
| Cost | ~cents | ~cents |
| Risk to landfolk-ops | none (isolated home) | none (different board, dispatcher filtered) |

## What would surprise me

- Trial 3 stalling differently than trial 2 — the only meaningful
  delta is the workspace layout (boards vs flat). If Hermes' workspace
  init for the `boards/<name>/` layout has different behaviour than
  flat, that's the find. Watching the first card spawn closely will
  surface it.
- Live dispatcher claiming a `two-bot-demo` card despite the `--board
  landfolk-ops` filter. That would be a Hermes bug; very unlikely.
- Different cost / latency on the dashboard-visible kanban DB writes —
  if the dashboard process holds locks long enough to slow workers'
  status transitions. Watch `hermes kanban events --board two-bot-demo`
  for stall patterns.

If any of these happen, abort and fall back to the proto rig for
diagnosis.

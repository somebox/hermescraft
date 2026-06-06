# agent-arch prototype

A small rig for testing the new card → fresh worker → narrow skills →
handoff chain from `docs/architecture/target.md` without touching the live
landfolk fleet or running Minecraft. The bot HTTP API is mocked; everything
else (Hermes, profiles, kanban, skills) is real.

The full plan, including what each phase proves and what it deliberately
does NOT prove, lives at
`/Users/foz/.claude/plans/create-a-plan-that-magical-lovelace.md`.

## Layout

```
prototypes/agent-arch/
├── README.md              you are here
├── dsl_parse.py           @mention DSL parser (pure stdlib)
├── tests/
│   └── test_dsl_parse.py  pytest, no Hermes needed
├── mock-bot.mjs           fake bot HTTP server, port 3091
├── scenarios/
│   ├── A-single.txt       Phase 1
│   ├── B-chain.txt        Phase 2
│   └── C-handoff.txt      Phase 3
├── skills/
│   └── agent-miner.md     (Phase 3, not written yet)
├── fixtures/              (reserved for canonical response samples)
├── setup.sh               creates pilot-navigator + pilot-miner profiles
├── dispatch.py            parses DSL, creates kanban cards with --parent
└── run.sh                 boots mock, runs dispatch, drives one card
```

## How the pieces fit together

```
scenarios/A-single.txt  ──► dispatch.py ──► hermes kanban create
                                                │
                                                ▼
                                       Hermes gateway claims card
                                                │
                                                ▼
                                       worker spawns on pilot-navigator
                                                │
                                                │  worker .env hardcodes
                                                │  MC_API_URL=http://127.0.0.1:3091
                                                ▼
                                          mock-bot.mjs (port 3091)
                                                │
                                                ▼
                                       kanban_complete + handoff metadata
```

## Quick reference

| Want to... | Run |
|---|---|
| Test only the DSL parser | `python -m pytest tests/test_dsl_parse.py -v` |
| Boot the mock by hand | `node mock-bot.mjs &` then `curl http://127.0.0.1:3091/status` |
| Stop the mock | `kill $(cat /tmp/proto-mock.pid)` |
| Tail mock requests | `tail -f /tmp/proto-mock.log` |
| List prototype cards | `hermes kanban list --tenant proto-agent-arch --json` |

## Phase 0 — prerequisites (do this before Phase 1)

The live landfolk fleet should be stopped throughout. Confirm with
`scripts/landfolk status` — all five players should be `DOWN`.

Upgrade Hermes per `docs/platform/hermes-upgrade-0.15-runbook.md`. We actually landed
on v0.16.0 (date tag 2026.6.5) — a release later than the runbook predicted
but with the CLI surface we need. Skip step 5 (bring fleet up, smoke flint)
of the runbook — fleet uptime is not load-bearing here. Do still run:

- `hermes --version` → 0.15.2 or newer
- `hermes config check` → no warnings
- `hermes doctor` → healthy
- `hermes kanban create --help` → confirm `--tenant`, `--skill`, `--parent` are present

### Isolation: separate HERMES_HOME (mandatory, not optional)

The first run of the Phase 0 isolation check turned up a critical finding:
**`hermes kanban dispatch` is not tenant-scoped on v0.16.** It claims any
ready card with a valid assignee, regardless of tenant. So putting prototype
cards on the shared `~/.hermes` lets the live dispatcher pick them up
alongside `landfolk-ops` cards.

The plan's Option B is therefore the default for this rig:

```bash
export HERMES_HOME=$HOME/.hermes-proto-agent-arch
```

`setup.sh`, `run.sh`, and `dispatch.py` all default to this value. The
prototype has its own kanban DB, its own profiles directory, its own
gateway state. The live `~/.hermes` is untouched.

To re-confirm isolation after upgrade: with the live fleet stopped and
no gateway running, create a no-op card in the proto HOME, then
`hermes kanban dispatch --dry-run --max 1` from the proto HOME — should
list only the proto card.

**After Phase 0, verify by:** running `./run.sh --phase0-verify` (TBD) or
each of the commands above by hand.

## Phase 1 — single card

Write the parser (done), the mock bot (done), `setup.sh`, `dispatch.py`,
`run.sh`. Then:

```bash
./setup.sh                                          # creates pilot-navigator
./run.sh scenarios/A-single.txt                     # boots mock + dispatches
```

Expected:
- Mock log `/tmp/proto-mock.log` has at least one `POST /action/move`.
- The card transitions `ready` → `running` → `done`.
- `hermes kanban show <id> --json | jq '.metadata'` shows `exit_pos` and `exit_facing`.

**After Phase 1, verify by:**

```bash
python -m pytest tests/test_dsl_parse.py -v
hermes kanban list --tenant proto-agent-arch --json
hermes kanban show <id> --json | jq '.metadata, .result'
grep -E 'skill_view|exit_pos|exit_facing' ~/.hermes/profiles/pilot-navigator/logs/*.log
cat /tmp/proto-mock.log
```

## Phase 2 — two-card chain on the same agent

```bash
./run.sh scenarios/B-chain.txt
```

Expected:
- Card 2 sits in `todo` (not `blocked` — that's the v0.16 lifecycle for
  children waiting on a parent) while card 1 runs. Once card 1 hits
  `done`, the post-tool hook auto-promotes card 2 to `ready`.
- Card 2 has a different `run_id` and `worker_session_id` than card 1
  (the fresh-worker check). `worker_pid` is null after completion —
  Hermes clears it — so distinct run_ids are the durable probe.

**After Phase 2, verify by:**

```bash
# The proto kanban DB lives at $HERMES_HOME/kanban.db on v0.16 (single
# shared DB; tenant is a column). task_runs columns: id (run id), task_id,
# worker_pid (cleared on completion), profile, status, outcome, metadata.
sqlite3 $HERMES_HOME/kanban.db \
    "SELECT task_id, id AS run_id, json_extract(metadata,'\$.worker_session_id') AS sess
     FROM task_runs ORDER BY started_at DESC LIMIT 4"
# Expect two distinct run_ids and two distinct worker_session_ids.
```

The plan deliberately drops the gate-check mutex claim for Phase 2 —
serialization comes from `--parent` blocking, not from the landfolk
plugin's mutex (we don't touch the plugin).

## Phase 3 — cross-agent handoff

Write `skills/agent-miner.md`, extend `setup.sh` to create `pilot-miner`,
then:

```bash
./run.sh scenarios/C-handoff.txt
python -m pytest tests/test_handoff_contract.py -v
```

Expected:
- Card 2 spawns on `pilot-miner` (different profile from card 1).
- Card 2's worker references the `exit_pos` from card 1's completion.
- Card 3 reads `inv_delta` from card 2.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Worker dies on turn 1 with no LLM output | Provider API key missing from `~/.hermes/profiles/pilot-*/.env`. |
| Worker refuses `mc` calls, "looks like injection" in gateway log | Hermes' security check is flagging the templated `mc` strings. Add an allowlist note to the SOUL or check `hermes security` post-upgrade. |
| `mc move` errors on JSON decode | Mock response shape drifted from the real bot. Diff against `bot/cli/registry.mjs` and `bot/lib/server/http-app.js`. |
| Cards show up on `landfolk-ops`, not `proto-agent-arch` | `dispatch.py` is shelling out without `--tenant`. Check Phase 0's flag confirmation. |

# Wheat capstone — pre-trial playbook

Comprehensive checklist for every wheat-capstone trial. Walk top to
bottom; do not skip. Each section has a **check** (read-only command),
**expected output**, and **fix** pointer for when it's red.

The playbook is designed to catch the failures we have actually hit:

1. **Trial 1 (1780797..., 1780816..., 1780821...):** two-bot demo
   — different work, same operator surface area, where we learned to
   put the floor stack + bedrock cap in.
2. **Trial 1780839...:** 11×11 pad — chest outside walkable area.
   Mox would have void-fallen on the way to deposit.
3. **Trial 1780840...:** marks POSTed only to Tester :3004. Mox
   queried his own bot :3007's marks, got `unknown_mark: @base_anchor`,
   hallucinated a phantom base at (-456, 74, 596), and ran off the pad.

If a later trial fails on something not covered here, add a section.

---

## A. Bot infrastructure

| # | Check | Expected | Fix |
|---|---|---|---|
| A1 | `ssh ubuntu-host "sudo docker ps \| grep minecraft"` | `Up <duration>` | `ssh ubuntu-host "sudo docker start minecraft"` |
| A2 | `curl -sf "http://127.0.0.1:3007/status?lean=true"` | exit 0, JSON | `scripts/colony start mox` |
| A3 | `curl -sf "http://127.0.0.1:3004/status?lean=true"` | exit 0, JSON | `scripts/run-tester-bot.sh` |
| A4 | `ps aux \| grep -E "pilot-(pip\|zee)" \| grep -v grep` | empty (no active workers for them) | nothing — they're idle |
| A5 | `ps aux \| grep -E "hermes.*work kanban task" \| grep -v grep` | empty (no stale workers) | `pkill -f "hermes.*work kanban"` |

## B. World / map

| # | Check | Expected | Fix |
|---|---|---|---|
| B1 | `ssh ubuntu-host "sudo docker exec minecraft rcon-cli 'mv list'" \| grep landfolk-test` | one line | check `config/hermescraft.yaml` |
| B2 | `scripts/validate-wheat-fixture.sh` | 23 PASS lines, exit 0 | re-run `scripts/run-fixture.sh prep data/test-fixtures/colony/wheat_capstone.yaml` |
| B3 | included in B2 | bedrock NW + SE pass | re-stage |
| B4 | included in B2 | water at (-50, 64, 50) | re-stage |
| B5 | included in B2 | chest at (-50, 65, 60) | re-stage |
| B6 | no leftover blocks (trial-3 chests, marks, cobble outcrop) | `if block 295 65 300 minecraft:chest` returns `Test failed` | `scripts/run-fixture.sh cleanup data/test-fixtures/open/two_bot_base.yaml` |

## C. Markers — both bots, inert names

Marks live PER-BOT — each Mineflayer bot has its own marks DB. The
worker (Mox :3007) needs them for navigation, AND Tester (:3004)
needs them so `mc verify at_mark wheat_plot block=water` resolves.

**Use inert names.** `field_south` reads as "south of something"
and primed Mox toward a phantom base. Use `wheat_plot`,
`wheat_chest`, `wheat_start` instead — they're opaque labels.

| # | Check | Expected | Fix |
|---|---|---|---|
| C1 | mark names in fixture YAML | `wheat_plot, wheat_chest, wheat_start` (no directional words) | edit fixture |
| C2a | `curl -sf http://127.0.0.1:3007/marks \| python3 -c "import json,sys; ns=[m['name'] for m in json.load(sys.stdin)['data']['marks']]; assert all(n in ns for n in ('wheat_plot','wheat_chest','wheat_start')), ns" && echo OK` | `OK` | re-run fixture prep |
| C2b | same for `:3004` (Tester) | `OK` | re-run fixture prep |
| C3 | `curl -sf http://127.0.0.1:3007/marks \| python3 -c "import json,sys; print(sorted(m['name'] for m in json.load(sys.stdin)['data']['marks']))"` | only the wheat marks + (optional) `spawn` | `mc unmark` stale marks via fixture cleanup or `mark drop` script |
| C4 | mark coords match what acceptance predicates expect | wheat_plot at (-50, 64, 50); wheat_chest at (-50, 65, 60); wheat_start at (-55, 65, 50) | re-stage fixture |

## D. Mox starting state

| # | Check | Expected | Fix |
|---|---|---|---|
| D1 | `curl -sf http://127.0.0.1:3007/status \| python3 -c "import json,sys; p=json.load(sys.stdin)['data']['position']; print(p['x'], p['y'], p['z'])"` | x in [-60, -40], z in [43, 63], y ≥ 65 | re-run fixture prep |
| D2 | `curl -sf http://127.0.0.1:3007/inventory \| python3 -c "import json,sys; cats=json.load(sys.stdin)['data']['categories']; items={i['name']:i['count'] for c in cats.values() for i in c}; print(items)"` | `{'wooden_hoe': 1, 'wheat_seeds': 64}` | re-run fixture prep |
| D3 | `curl -sf http://127.0.0.1:3007/status \| python3 -c "import json,sys; print(json.load(sys.stdin)['data']['health'])"` | 20 | wait or fixture re-prep (health regenerates) |
| D4 | Mox marks list excludes stale death_* + non-trial marks | see C3 | run mark-cleanup script (TODO) |

## E. Profile / SOUL / memory

| # | Check | Expected | Fix |
|---|---|---|---|
| E1 | `HERMES_HOME=~/.hermes hermes profile list \| grep pilot-mox` | one line | `prototypes/agent-arch/setup-pilot-mox-live.sh` |
| E2 | `grep -E "wheat_plot\|mc inspect.*mark\|mc marks" ~/.hermes/profiles/pilot-mox/SOUL.md` | matches present | edit SOUL |
| E3 | `wc -l ~/.hermes/profiles/pilot-mox/memories/MEMORY.md` | `0` (empty — fresh trial) | `: > ~/.hermes/profiles/pilot-mox/memories/MEMORY.md` |
| E4 | `grep -nE "-456\|-200.*300\|base.*at.*[(-]\|spawn" ~/.hermes/profiles/pilot-mox/SOUL.md` | empty | scrub SOUL |
| E5 | per-card --skill flags resolve to files | runner dry-run shows 4 skill flags per card | `setup-pilot-mox-live.sh` |
| E6 | `grep -E "MC_API_URL\|MC_USERNAME\|_MC_API_URL_LOCKED" ~/.hermes/profiles/pilot-mox/.env` | 3 lines, port 3007, Mox, lock=1 | re-run setup script |

## F. Cards / graph

| # | Check | Expected | Fix |
|---|---|---|---|
| F1 | card bodies tell agent to inspect marks first | each body starts with "use `mc inspect --mark <name>` to read coords" or similar | edit `prototypes/agent-arch/capstone/wheat_graph.py` |
| F2 | mark names in bodies match fixture YAML | `wheat_plot`, `wheat_chest`, `wheat_start` | edit `wheat_graph.py` to match fixture |
| F3 | runner dry-run shows right `--skill` flags per card | x001: navigator-bundle, x002: builder-bundle, etc. | check `SKILL_BUNDLES` in `wheat_graph.py` |
| F4 | `--dry-run` output shows `[bot:mox] <slug>` on every title | all 4 cards | check `EPIC_BOT = "mox"` in `wheat_graph.py` |
| F5 | acceptance predicates match staged world | farmland Y=64 + wheat Y=65 + water at `wheat_plot`; corners match plot footprint | edit `wheat_graph.py` `acceptance_predicates` |

## G. Logs / monitoring

| # | Check | Expected | Fix |
|---|---|---|---|
| G1 | proto-logs-follow.py command **uses --profiles (plural), HERMES_HOME=~/.hermes** | `HERMES_HOME=~/.hermes scripts/proto-logs-follow.py --profiles pilot-mox` | use the right form |
| G2 | runner log goes to `/tmp/wheat-runner-${RUN_ID}.log` | file exists after launch | check launch command |
| G3 | dispatcher log goes to `/tmp/wheat-dispatcher-${RUN_ID}.log` | file exists after launch | check launch command |
| G4 | Monitor task armed for runner log | I'll see card transitions | re-arm via Monitor tool |
| G5 | `tail -F /tmp/hermescraft/bot-mox.log` works | file readable | `scripts/colony status` |

## H. Dispatcher / runner

| # | Check | Expected | Fix |
|---|---|---|---|
| H1 | `HERMES_HOME=~/.hermes hermes kanban boards list \| grep wheat-capstone` | one line | `setup-pilot-mox-live.sh` (idempotent) |
| H2 | `HERMES_HOME=~/.hermes hermes kanban --board wheat-capstone list` (after archive of any prior cards) | `(no matching tasks)` | `hermes kanban --board wheat-capstone archive <tids>` |
| H3 | `.venv/bin/python prototypes/agent-arch/capstone/run_wheat_capstone.py --dry-run --board wheat-capstone --assignee pilot-mox` | 4 invocations + 3 acceptance predicates, all `--assignee pilot-mox` | check runner code |
| H4 | dispatcher loop ticks every 10s | `tail -3 /tmp/wheat-dispatcher-${RUN_ID}.log` shows recent `[ISO-date] tick` lines | re-launch dispatcher |

## I. Output / postmortem

| # | Check | Expected | Fix |
|---|---|---|---|
| I1 | `data/postmortems/wheat-capstone/` is writable | exists, owner=foz | `mkdir -p` if missing |
| I2 | RUN_ID is unique (no collision with abandoned dirs) | `ls data/postmortems/wheat-capstone/ \| grep "$RUN_ID"` empty | use `trial-$(date +%s)` |
| I3 | scorecard.json and manifest.json get written in evaluate-only step | check after trial | runner code path |

---

## Launch sequence (after all sections green)

```bash
# 1. Cleanup any prior trial state
HERMES_HOME=~/.hermes hermes kanban --board wheat-capstone archive <tids>  # if needed
scripts/run-fixture.sh cleanup data/test-fixtures/colony/wheat_capstone.yaml
: > ~/.hermes/profiles/pilot-mox/memories/MEMORY.md   # E3: fresh memory

# 2. Stage + validate
scripts/run-fixture.sh prep data/test-fixtures/colony/wheat_capstone.yaml
# expect: validate-wheat-fixture: all bounds checks PASSED at the end
scripts/preflight-wheat.sh  # 9/9

# 3. Drop stale marks from Mox + Tester (if section C3 red)
scripts/clean-bot-marks.sh mox tester  # TODO if not present

# 4. Launch
RUN_ID="trial-$(date +%s)"
HERMES_HOME=~/.hermes \
  .venv/bin/python -u prototypes/agent-arch/capstone/run_wheat_capstone.py \
  --run-id "$RUN_ID" --board wheat-capstone --assignee pilot-mox --watch \
  > "/tmp/wheat-runner-${RUN_ID}.log" 2>&1 &
(
  export HERMES_HOME=~/.hermes
  while true; do
    echo "[$(date -Iseconds)] tick"
    hermes kanban --board wheat-capstone dispatch --max 5
    sleep 10
  done
) >> "/tmp/wheat-dispatcher-${RUN_ID}.log" 2>&1 &

# 5. Watch
HERMES_HOME=~/.hermes scripts/proto-logs-follow.py --profiles pilot-mox
```

---

## Postmortem after each trial — append findings here

### Trial 1780839793 (abandoned — too-small pad)
**Root cause:** 11×11 floor, chest at z=60 was outside walkable area.
**Caught how:** would have caused mid-trial void-fall.
**Playbook update:** B2 now uses 21×21 pad + scripts/validate-wheat-fixture.sh.

### Trial 1780840853 (abandoned — marks not on Mox)
**Root cause:** fixture POSTed marks to Tester :3004 only. Mox queried his own bot at :3007, got `unknown_mark: @base_anchor`, hallucinated a phantom base at (-456, 74, 596), ran off the pad.
**Caught how:** `proto-logs-follow.py` showed `ERROR: unknown_mark: @base_anchor — no such mark. Known: spawn, death_1, death_2, death_3.`
**Playbook updates:** C2a + C2b — POST marks to BOTH bots. C1 — inert names (wheat_plot/wheat_chest/wheat_start). C3 + D4 — clean stale death marks. E3 — clear memory before each trial. F1 — bodies must instruct mark-inspect first.

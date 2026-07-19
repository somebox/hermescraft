# Repo-root consistency skim: AGENTS.md, package.json, README.md

## Files read
- `/home/user/src/hermescraft/AGENTS.md` (full, ~150 lines) — agent/maintainer operating manual.
- `/home/user/src/hermescraft/README.md` (full, ~300 lines) — project pitch + user-facing setup/quickstart.
- `/home/user/src/hermescraft/package.json` — **does not exist at root** (ENOENT). The Node package manifest lives at `/home/user/src/hermescraft/bot/package.json` (`name: hermescraft-bot`, v3.0.0, `engines.node >=18`, `test: HERMES_VALIDATE=1 node --test`, `cheatsheet: node ../scripts/gen-mc-cheatsheet.mjs`).
- Top-level `ls` also shows: `pyproject.toml` (`name: hermescraft-mapcatalog`, a sub-project), `setup.sh`, `hermescraft.sh`, `start-steve.sh`, `start-gatherer.sh`, `start-landfolk.sh.deprecated`, `start-dashboard.sh`, `scripts/`, `bot/`, `docs/`, `data/`, `prompts/`, `skills/`, `server/`, `plugins/`, `tests/`, `tools/`, `dashboard/`, `profiles/`, `prototypes/`, `calibration/`, `catalog/`, `mapcatalog/`, `SOUL-minecraft.md`, `SOUL-landfolk.md`. No root `package.json` is expected — root is shell-script-driven.

## Purpose of each
- **AGENTS.md**: canonical tool surface for AI agents/maintainers — kanban facade (`scripts/kanban`), `mc` verbs, roster, genesis, tests, deprecated table, don'ts, CI gates, per-role SOUL paths. Authoritative "how" reference.
- **README.md**: human-facing intro to HermesCraft (companion + landfolk modes), prerequisites, setup/quickstart, `mc` command examples, fairness design, repo guide, testing. Authoritative "what/why" reference.
- **bot/package.json**: Node manifest for the Mineflayer bot + `mc` CLI HTTP server.

## Consistency check
- **Project name**: README "HermesCraft" / `hermescraft`; bot package `hermescraft-bot`; pyproject `hermescraft-mapcatalog`. Consistent (sub-projects prefixed).
- **Node version**: README "Node 18+"; bot `engines.node >=18`. ✅
- **Tests**: AGENTS.md `cd bot && HERMES_VALIDATE=1 npm test`; README `cd bot && npm test`; bot script sets `HERMES_VALIDATE=1 node --test`. ✅ (AGENTS.md's explicit env var is redundant but not contradictory.)
- **Cheatsheet regeneration**: AGENTS.md says use `scripts/regenerate-artifacts.sh`; README also says `scripts/regenerate-artifacts.sh`; bot `package.json` `cheatsheet` script runs `node ../scripts/gen-mc-cheatsheet.mjs`. The two scripts likely compose (regenerate-artifacts.sh wraps gen-mc-cheatsheet.mjs), but this is unverified — see risks.
- **Doc paths**: both reference `docs/README.md`, `docs/architecture/`, `docs/reference/mc-cheatsheet.md`. ✅
- **Registry source**: both agree cheatsheet is generated from `bot/cli/registry.mjs` (README mentions `bot/cli/`). ✅
- **Landfolk cast**: both name Gatherer/Flint/Mason/Barley workers; AGENTS.md adds Steward as orchestrator. ✅

## Inconsistencies / risks (none blocking)
1. **Root `package.json` missing** — task asked to read it; it does not exist. Root is shell-driven (`setup.sh`, `hermescraft.sh`). Not a defect, just a mismatch with the task's assumption.
2. **README omits the kanban facade entirely.** AGENTS.md's central tool is `scripts/kanban board` / `card` / `add` / etc. README's landfolk section uses `./scripts/landfolk` (fleet control) and never mentions `scripts/kanban`. A new reader of README alone would miss the board-ops surface. Severity: low (different audiences), but worth flagging — the two docs describe overlapping tooling with no cross-reference.
3. **`mc` verb lists diverge.** AGENTS.md lists: status, observe, scene, nearby, goto, move, dig, collect, place, fill, craft, pillar_up/down, stair_up/down, mark, marks, go_mark, chest_search, deposit, withdraw, bg_*. README lists: status, inventory, nearby, look, map, scene, social, read_chat, commands, advise, bg_collect, bg_goto, follow, craft, fight, flee, chat, chat_to, whisper, screenshot_meta. Both are illustrative ("includes verbs like…"), so not strictly contradictory, but a maintainer cross-checking would find ~15 verbs in one not mentioned in the other. `mc whisper` is called an "alias for chat_to" in README; AGENTS.md's deprecated table does not list it. Severity: low.
4. **`bot/server.js` "≈600 LOC"** claim in README is unverified here.
5. **Genesis vs landfolk**: AGENTS.md documents `scripts/genesis.sh`; README documents `./scripts/landfolk start`. Both exist in `ls`. Likely complementary (genesis bootstraps world+kanban; landfolk runs the live fleet), but neither doc says so. Low severity.

## Bottom line
AGENTS.md and README.md are broadly consistent on name, Node version, test command, doc layout, and the generated-cheatsheet rule. The main gaps are (a) README never surfaces the `scripts/kanban` board facade that AGENTS.md treats as primary, and (b) the `mc` verb samples differ. No blocking contradictions found. No files were edited.

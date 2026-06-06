# hermescraft project context

This repo runs a small fleet of AI agents that play Minecraft together on the
`landfolk-ops` kanban board. Workers (flint, mason, gatherer, barley) take cards
from the board and execute them in-world via the `mc` HTTP CLI. Steward is the
orchestrator — she reads the board, diagnoses fleet state, and decomposes work.

If you are reading this, you are working as one of those agents (or as a human
maintainer of this repo). The rules below describe the canonical surface so
your tool calls land on real commands the first time.

## Repo layout

| Dir | What lives here |
|---|---|
| `bot/` | Mineflayer bot + `mc` CLI source (Node, `npm test` runs from here) |
| `scripts/` | Ops scripts — kanban facade, roster, genesis, deploy, runtime spawner |
| `prompts/landfolk/` | Per-role SOULs + per-cycle wake prompts + starter command lists |
| `skills/` | Worker-facing skill library (loaded on demand via `skill_view`) |
| `data/` | World state, genesis runs, region/blueprint plans, kanban DB roots |
| `docs/` | Doc index: [`docs/README.md`](docs/README.md). **Target fleet direction:** [`docs/architecture/`](docs/architecture/). Bot/`mc` reference: [`docs/reference/`](docs/reference/). |
| `config/` | Central config (`hermescraft.yaml`) |
| `server/` | Minecraft server config and start scripts |
| `plugins/` | PaperMCP plugin code |
| `tests/` | Python-side tests (Hermes-Python flows, blueprint tooling) |
| `reports/` | Genesis run reports + post-mortems |

## Canonical tool surface

These are the tools to use. They are NOT the only tools that work — they are
the ones that match the team's conventions and won't surprise the next agent.

### Kanban (board operations)

The `landfolk-ops` board lives in SQLite under `~/.hermes/kanban/`. Use the
`scripts/kanban` facade for everything:

```
scripts/kanban board                  # one-screen orient view
scripts/kanban card <id>              # detail view of one card
scripts/kanban epic <id>              # epic + members
scripts/kanban list --status <s>      # filter by status (only when you need it)
scripts/kanban add  "<title>"  ...    # create a card
scripts/kanban add-epic "<title>" ... # create an epic
scripts/kanban comment <id> "<text>"  # add a comment
scripts/kanban block / unblock / archive / promote / resolve / reassign / retry
scripts/kanban set-after <child> <parent>   # real dep link
scripts/kanban edit <id> [--title T --body B --size S --at X,Y,Z]
```

`scripts/kanban board` replaces what used to be four separate `hermes kanban
list --status ...` calls plus `scripts/board`. Use it first thing every cycle.

### In-world commands

`mc <verb>` calls the bot server (port 3000-3005 per bot). Full registry of
verbs is documented in `docs/reference/mc-cheatsheet.md` — that file is **generated** from
`bot/cli/registry.mjs` (do not edit by hand). For the long-form per-command
help, run `mc <verb> --help` against a live bot. The registry includes verbs
like `status`, `observe`, `scene`, `nearby`, `goto`, `move`, `dig`, `collect`,
`place`, `fill`, `craft`, `pillar_up`, `pillar_down`, `stair_up`, `stair_down`,
`mark`, `marks`, `go_mark`, `chest_search`, `deposit`, `withdraw`, plus the
async `bg_*` variants for long-running tasks.

### Bot status (who is in-game?)

```
scripts/roster.py                # full state of every profile
scripts/roster.py --assignable   # filter to bots currently available for work
```

### Tests

```
cd bot && HERMES_VALIDATE=1 npm test          # full bot test suite
cd bot && node --test test/<name>.test.js     # one file
```

### Genesis (fresh world bootstrap)

```
scripts/genesis.sh new-run --seed=N --no-confirm     # new world
scripts/genesis.sh new-run --keep-world --no-confirm # same world, fresh kanban
scripts/genesis.sh new-run --keep-world --skip-base  # jump to P2 (skip P1 cards)
scripts/genesis.sh new-run --anchor X,Y,Z ...        # pin worldspawn
```

Genesis automatically runs `landfolk deploy` (which regenerates the cheatsheet
and syncs skills/SOULs) before starting bots.

## Deprecated — do not use

If you are about to type one of these, stop and use the replacement.

| Deprecated | Replacement |
|---|---|
| `scripts/board` | `scripts/kanban board` |
| `scripts/board show <id>` | `scripts/kanban card <id>` |
| `hermes kanban list --status ...` | `scripts/kanban board` (covers all four statuses + recent in one view) |
| Bare `board-recent.py` (no path) | `scripts/board-recent.py` if you really need the older delta view, but `scripts/kanban board`'s RECENT lane usually replaces it |
| `mc pillar_step` | `mc pillar_up` (alias kept; prefer the canonical name) |
| Editing `docs/reference/mc-cheatsheet.md` by hand | Edit `bot/cli/registry.mjs`, then run `scripts/regenerate-artifacts.sh` |
| `sqlite3 kanban.db ...` | Use `scripts/kanban` verbs — they handle the right path and don't fight the dispatcher |
| `find ~/.hermes -name ...` | Be specific: `~/.hermes/profiles/<bot>/` for profiles, `~/.hermes-landfolk-<bot>/` for agent homes |

## Don'ts

- **Don't commit `data/locations-base.json`** — it is runtime state written by
  the location reconciler, not source.
- **Don't edit `docs/reference/mc-cheatsheet.md` by hand** — it is regenerated from the
  registry. The CI gate `cheatsheet-sync.test.js` fails on drift.
- **Don't put prompt text in `scripts/landfolk-control.sh`** — prompts live in
  `prompts/landfolk/*.md` and `*.starter.txt`. The CI gate `prompts-sync.test.js`
  fails on drift, including deprecated tool references.
- **Don't invent `mc` verbs or `scripts/<name>` references** — if you can't find
  the verb in `docs/reference/mc-cheatsheet.md` or the script in `ls scripts/`, ask
  (or in worker context, file a `[BUG]` card).
- **If you are Steward, don't mine, place, or otherwise act in-world.** Stay at
  base. Your job is orchestration, not execution.

## Test gates that must stay green

The CI pipeline runs these from `bot/`:

- `cheatsheet-sync.test.js` — `docs/reference/mc-cheatsheet.md` must match the registry.
- `prompts-sync.test.js` — every `mc <verb>` and `scripts/<name>` token in
  `prompts/landfolk/*.starter.txt` and `*.wake-*.md` must resolve to a real
  registry entry / file, and must not be a deprecated alias.
- `cli-action-sync.test.js` — every CLI POST action must have a server handler.
- `actions-manifest.test.js` — every action module factory must follow the
  `create*Actions` convention.

## Per-role SOULs

If you are a specific bot, your role-level personality and conventions are at:

```
prompts/landfolk/flint.md
prompts/landfolk/mason.md
prompts/landfolk/gatherer.md           (worker; gatherer-test.md is a variant)
prompts/landfolk/barley.md
prompts/landfolk/steward.md            (orchestrator; long-form)
prompts/landfolk/steward-profile.md    (orchestrator; short, profile SOUL)
prompts/landfolk/worker.md             (generic worker rules — applies to all four workers)
```

The `worker.wake-*.md`, `worker.starter.txt`, and per-role `<name>.starter.txt`
files carry the per-cycle and at-boot tactical instructions; they should be
short and tactical (the canonical *how* is right here in AGENTS.md, so the
wake prompts don't need to re-derive it).

## Quick verification commands

When you want to sanity-check that this file is loaded into your system prompt:

```
grep -c "scripts/kanban" /dev/stdin     # piped via the agent's own prompt dump
scripts/kanban board                     # if this succeeds, the canonical surface works
scripts/roster.py --assignable           # who can take a card right now
```

If you see deprecated commands in your prompt or context, that is a bug — file
a `[BUG]` card or, if you are human, edit this file and update `prompts-sync.test.js`.

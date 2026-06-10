# scripts/ context

Hermescraft ops scripts live here. Two flavors:

- **Runtime spawners** — `landfolk-control.sh`, `landfolk-dispatcher.sh`,
  `landfolk-session.sh`, `chat-wake.py`, `run-landfolk-agent.sh`, the
  `start-*.sh` launchers. These spawn agents; they should not contain prompt
  prose. Prompts live in `prompts/landfolk/*.md` and `*.starter.txt`.
- **Deploy + setup** — `setup-landfolk-profiles.sh` (installs SOULs, config
  patches, skills into `~/.hermes/profiles/<bot>/`), `regenerate-artifacts.sh`
  (regenerates tier-grouped `docs/reference/mc-cheatsheet.md` from the registry +
  `bot/cli/registry-surface.mjs`). Called from `scripts/landfolk deploy`.

The `landfolk` wrapper in this directory is the single entry point for fleet
operations: `landfolk start | stop | status | restart | deploy | regenerate |
diagnostics | logs | players | chat | fix`.

## Canonical patterns

- **Kanban facade** — `scripts/kanban <verb>` (Python). Do NOT call
  `scripts/board` (deprecated; the wrapper exists but is no-op for new work)
  or chain four `hermes kanban list --status <s>` calls when
  `scripts/kanban board` does it in one screen.
- **Bot status** — `scripts/roster.py --assignable` returns the bots
  currently in-game and available for a card. Used by Steward every cycle.
- **Genesis** — `scripts/genesis.sh new-run` is the single entry for fresh
  worlds; it calls `landfolk deploy` (regenerate + sync) before starting bots.
- **Backup / observe** — `scripts/board-recent.py`, `scripts/board-snapshot.py`,
  `scripts/fleet-status.py` exist for older delta windows or one-off debugging.
  Default reads should go through the facade.

## Adding a new script

- One verb does one job. Compose via the `landfolk` wrapper if you need a
  combined flow.
- If it has a runtime (cron, systemd timer, Hermes hook), note who calls it
  in the script's docstring so future humans can find it.
- If it produces a derived artifact (like the cheatsheet), wire it into
  `scripts/regenerate-artifacts.sh` so `landfolk deploy` keeps it fresh.
- If it's referenced by a prompt or wake file, the `prompts-sync.test.js`
  gate will check the path exists. Tokens like `scripts/<name>` in any
  `prompts/landfolk/*.starter.txt` or `*.wake-*.md` must resolve.

## Where the runtime-vs-deploy split matters

`landfolk-control.sh` spawns agents (runtime). It must not assemble prompt
content — it reads files by path. The 2026-05-30 fix landed this partition:
`continue_prompt_minimal` is no longer a string literal in shell, it's
`prompts/landfolk/<role>.wake-minimal.md`.

`setup-landfolk-profiles.sh` is the deploy script (called via `landfolk
deploy`). It writes SOULs, patches `config.yaml` knobs (max_turns,
`model.context_length` 250k, `compression.threshold` 0.2, auxiliary compression
model via `scripts/patch-landfolk-compression-config.py`), and copies skills into
`~/.hermes/profiles/<bot>/`. It is idempotent — safe to re-run.

## Registry, cheatsheet, and agent surface tiers

When you add or change `mc` verbs or who should see them by default:

1. **`bot/cli/registry.mjs`** — command definition (description, examples, HTTP path).
2. **`bot/cli/registry-surface.mjs`** — optional `core` / `microscope` membership (default tier is **extended**). Guardrail: ≤45 core verbs (`registry-guardrails.test.js`).
3. **Regenerate** — `scripts/regenerate-artifacts.sh`, `scripts/landfolk deploy`, or `cd bot && npm run cheatsheet`; commit `docs/reference/mc-cheatsheet.md`.
4. **Validate** — `cd bot && HERMES_VALIDATE=1 npm test` (includes `cheatsheet-sync`, `prompts-sync`, surface guardrails).
5. **Evidence (when retuning tiers)** — `python3 scripts/mc-call-survey.py --minutes 10080 --json` (offline session logs); save snapshot under `docs/reference/audits/` for PR notes.
6. **Discovery CLI** — agents/tools can filter introspection with `mc commands --tier core|extended|microscope` (field name in JSON is `surface`; flag is `--tier` to avoid the swim verb `mc surface`).

Strategy: [`docs/architecture/embodied-control.md`](../docs/architecture/embodied-control.md) § Two layers.

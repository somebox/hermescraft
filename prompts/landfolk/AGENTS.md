# prompts/landfolk/ context

Per-role prompts for the landfolk fleet. Hermes Agent does not load anything in
this directory automatically — `scripts/landfolk-control.sh` reads files here
by path at agent spawn time and passes them as `-q` arguments. The runtime
spawner is plumbing; the prose lives here.

## Filename convention

For each role (`flint`, `mason`, `gatherer`, `barley`, `steward`, plus the
`worker` defaults):

| File | What it carries | When the spawner uses it |
|---|---|---|
| `<role>.md` | Long-form SOUL: identity, conventions, ritual, escalation. The biggest file per role. | First-spawn initial prompt (`prompt`); also the watchdog re-prime (`continue_prompt_full` for workers; for Steward it loads `steward.md` directly). |
| `<role>.starter.txt` | Initial `mc <verb>` / `scripts/...` chain run on agent boot. One-line, comma-separated. | Composed into the first-spawn `-q` after the SOUL. |
| `<role>.wake-minimal.md` | Tactical per-cycle prompt. Short — five to fifteen lines. The minimal variant runs when the continuous-loop watchdog wakes the agent. | `continue_prompt_minimal` in `landfolk-control.sh`. |
| `<role>.wake-full.md` | Re-prime variant for the watchdog. For workers, used after a restart; for Steward, the long-form SOUL stands in. | `continue_prompt_full` (worker path only). |

The `worker.*` files are the default fallback. If a per-role file is missing,
the spawner falls back to `worker.*` and logs a warning.

The `steward-profile.md` short profile SOUL is installed into the steward
`~/.hermes/profiles/steward/SOUL.md` by `scripts/setup-landfolk-profiles.sh`.
That file is separate from `steward.md` (the orchestrator long-form).

## When editing

- **Tool surface comes from the project `AGENTS.md`** (one level up). Don't
  re-list every `scripts/kanban` verb here; the system prompt already has it.
- **Per-cycle prompts should be tactical**, not didactic. The wake-minimal
  should say "diagnose / rank / execute", not "use `scripts/kanban board` to
  read the board" — the canonical tool name is already in the system context.
- **Sync test gate**: `bot/test/prompts-sync.test.js` validates every
  `mc <verb>` and `scripts/<name>` token in `*.starter.txt` and `*.wake-*.md`
  against the registry and the actual scripts directory. Deprecated tools
  (`scripts/board`) also fail. Run it locally:
  ```
  cd ~/hermescraft/bot && node --test test/prompts-sync.test.js
  ```

## Files in this directory

| File | Role |
|---|---|
| `flint.md` / `flint.starter.txt` | Worker — miner |
| `mason.md` / `mason.starter.txt` | Worker — builder |
| `gatherer-test.md` / `gatherer.starter.txt` | Worker — gatherer (uses `gatherer-test.md` as the SOUL; no plain `gatherer.md` yet) |
| `barley.md` / `barley.starter.txt` | Worker — farmer |
| `steward.md` / `steward-profile.md` / `steward.starter.txt` / `steward.wake-minimal.md` | Orchestrator |
| `steve.md` / `steve-steward-mode.md` | Solo/dev character (not part of the dispatcher fleet) |
| `worker.md` / `worker.starter.txt` / `worker.wake-minimal.md` / `worker.wake-full.md` | Default fallback for any unrecognized role |

# Planning and session logs

Scratch space for in-progress plans, dev sessions, and run postmortems. Nothing here is guaranteed current; prefer [docs/README.md](../README.md) for stable references.

## devlog.md

Append-only design decisions, bugs, and fixes while developing the bot and test harness. New sessions go at the top.

## expeditions/

Dated postmortems from long agent runs (circuit tests, navigation sessions, etc.). Naming: `YYYY-MM-DD-<slug>.md`.

Structured live runs use the harness in [guides/run-logging.md](../guides/run-logging.md) (`scripts/exp.sh`); artifacts land under `/tmp/hermescraft/runs/<RUN_ID>/`. Summaries or analysis can be copied here when worth keeping in-repo.

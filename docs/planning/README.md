# Planning and session logs

Scratch space for in-progress plans, dev sessions, and run postmortems. Nothing here is guaranteed current; prefer [docs/README.md](../README.md) for stable references.

## session-devlog.md

Append-only design decisions, bugs, and fixes while developing the bot and test harness. New sessions go at the top: [`session-devlog.md`](session-devlog.md).

## expeditions/

Dated postmortems from long agent runs (circuit tests, navigation sessions, etc.). Naming: `YYYY-MM-DD-<slug>.md`. **Archived expeditions:** [`../archive/planning/expeditions/`](../archive/planning/expeditions/) (May–June 2026 and earlier).

Structured live runs use the harness in [expedition-logging-runbook.md](../guides/expedition-logging-runbook.md) (`scripts/exp.sh`); artifacts land under `/tmp/hermescraft/runs/<RUN_ID>/`. Summaries or analysis can be copied here when worth keeping in-repo.

## Active program docs

- [`adaptive-road-planning.md`](adaptive-road-planning.md) — roadplan / proc-nav implementation contract (not canonical architecture; see [`../architecture/README.md`](../architecture/README.md)).

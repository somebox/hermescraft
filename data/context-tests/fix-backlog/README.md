# Fix backlog artifacts

See plan deliverables. Generated per run: `fix-backlog.json` / `fix-backlog.md` under `scripts/context-tests/runs/`.

```bash
./context-tuner fix-backlog from-run last
./context-tuner fix-backlog promote-compare last~1 last
```

Schema: [fix-backlog.schema.json](./fix-backlog.schema.json)

**Observe fixture lever:** optional `next_action_hints` string array in shared observe JSON; `prompt-builder.mjs` surfaces them under “Suggested next commands”. Keep each entry a single valid `mc …` line (no prose) so models do not copy commentary into graded output.

Batch driver (baseline → summary → fix-backlog in one command):

```bash
./scripts/terrain-shaping-batch.sh baseline --runs 3 --yes
```

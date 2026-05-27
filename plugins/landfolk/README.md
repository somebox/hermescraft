# landfolk plugin

Hermes plugin for the landfolk Minecraft bot fleet. Phase 1 enforces a
per-assignee concurrency cap on the kanban board so two workers can't
race for the same bot body.

## Install

```bash
ln -sfn "$(pwd)/plugins/landfolk" ~/.hermes/plugins/landfolk
hermes plugins enable landfolk
```

The `scripts/setup-landfolk-profiles.sh` script does this idempotently
as part of normal landfolk setup.

## Verify

```bash
hermes plugins list                       # landfolk should be 'enabled'
hermes landfolk --help                    # CLI namespace registered
hermes landfolk gate-check --board landfolk-ops --json
```

## Subsystems

| Path | Status | Purpose |
|------|--------|---------|
| `landfolk/orchestrator/` | **Active** | per-assignee mutex via `hermes landfolk gate-check` CLI + `post_tool_call` observer hooks |
| `landfolk/mc_tools/` | Placeholder | future: register `mc_*` as native Hermes tools |
| `landfolk/compressor/` | Placeholder | future: mc-aware context engine |
| `landfolk/memory/` | Placeholder | future: mc-aware memory provider |
| `landfolk/_shared/` | Active | cross-subsystem helpers |

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `LANDFOLK_BOARD` | `landfolk-ops` | Board the orchestrator operates on |
| `LANDFOLK_DISABLE_GATE` | unset | Set `1` to no-op the gate-check (incident kill switch) |
| `LANDFOLK_DISABLE_HOOKS` | unset | Set `1` to no-op the post_tool_call handlers |
| `LANDFOLK_ORCH_PROFILES` | `steward` | Comma-separated orchestrator profiles (auto-parked) |
| `LANDFOLK_LOG` | `/tmp/hermescraft/dispatcher.log` | Where the gate-check writes its tick line |

## Design

See [docs/features/landfolk-plugin.md](../../docs/features/landfolk-plugin.md)
in the hermescraft repo for the full design, rationale, decisions
table, acceptance criteria, and glossary.

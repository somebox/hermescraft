# Dogfood checklist (human or external AI session)

Use only `docs/context-tests/*` and `./context-tuner`. Read [limitations.md](./limitations.md) first.

## Before you author

- **Worker bug (mc verbs)?** → `grading_surface: mc` (default). Good first dogfood targets: Mason shelter entombment, Flint pad `mc collect` inside base marker region.
- **Steward bug (hermes/scripts shell)?** → `grading_surface: shell` or `profile_family: orchestrator` + `expect.shell_commands`. Do not use `expect.tool_calls` alone — matchers will be empty.

## Steps

1. `./context-tuner doctor`
2. Author 3–5 atomic scenarios from recent issues (`scenario new` + templates).
3. Each passes `scenario validate <id>` and `validate --all`.
4. Run calibration `--runs 3` and note judge spread (diagnostic only, not a gate).
5. File friction as doc/CLI fixes.

**Shipped worker scenarios:**

- `flint_no_collect_in_protect_region` — `observe-base-region.json`, `forbidden_canonical: [collect]`
- `mason_no_place_shelter_interior` — `observe-mason-shelter-interior.json`, interior `forbidden_coord_in_bbox` for place/fill

Suites: `examples` (pillar + `goals_gap_not_withdraw`), `region-protect`, `worker-building`, `recovery-hints`. Calibration stubs: `data/context-tests/_calibration/*_{good,bad}.txt`.

Context tuning example (Steve goals gap): see [reports/2026-05-27-goals-gap-context-tuning.md](./reports/2026-05-27-goals-gap-context-tuning.md).

Suggested further scenarios (from recent session):

| Issue | Template | Grading |
|-------|----------|---------|
| Mason filled shelter interior | `policy-rule` | forbid `mc place`/`fill` inside interior bbox; perimeter OK |
| Flint mined pad with `mc collect` in base marker | `policy-rule` | `forbidden_coord_in_bbox` + require discover/tunnel outside region |

Steward epic-parent bug (when ready):

```yaml
grading_surface: shell
expect:
  shell_commands:
    forbidden_substrings: ["--parent t_"]
```

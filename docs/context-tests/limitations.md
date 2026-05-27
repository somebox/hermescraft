# Limitations — grading surface

## Default: `mc` lines only

The matcher and pattern pipeline grades lines that start with `mc ` after light markdown stripping (`scripts/benchmark/grading.mjs` → `extractMcLines`). Everything else is ignored for matchers.

| Bot class | Typical output | Harness fit |
|-----------|----------------|-------------|
| **Worker** (Flint, Mason, Steve) | `mc move`, `mc collect`, `mc place`, … | Strong — matchers + patterns + expectations |
| **Orchestrator** (Steward) | `hermes kanban …`, `scripts/board list`, … | Matchers do not see these unless you opt in |

Orchestrator scenarios that only use `expect.tool_calls` will get **empty matcher traces** and pass/fail driven only by the LLM judge (diagnostic, not a promotion gate by itself).

## Shell surface (orchestrator)

Set on the scenario YAML:

```yaml
grading_surface: shell
# or
profile_family: orchestrator   # implies shell if grading_surface omitted

expect:
  shell_commands:
    forbidden_substrings: ["--parent t_"]
    forbidden_regex: ["kanban done"]
    required_substrings_any: ["hermes kanban complete"]
    max_lines: 12
```

Extracted lines: prefixes `hermes `, `scripts/`, `./scripts/` (`lib/shell-lines.mjs`).

**Patterns** (`defense_class_action_first`, `next_action_hint_followed`, …) are **mc-only**. Do not use `patterns:` on shell scenarios.

## Dogfood order (recommended)

1. **Worker regressions** (Mason entombment, Flint pad-mining) — full matcher signal, 30–45 min to author.
2. **Steward shell scenario** — after `grading_surface: shell` is set; e.g. forbid epic parenting on kanban create.

## Not in scope

- Runtime issues (exit 142, SIGALRM, round limits) — not prompt/context tests.
- Arbitrary shell (e.g. `cd`, `grep`) — extend `extractShellCommandLines` if needed.

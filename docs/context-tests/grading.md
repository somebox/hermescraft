# Grading

**Surface:** `grading_surface: mc` (default) or `shell` (or `profile_family: orchestrator`). See [limitations.md](./limitations.md).

## mc surface (Flint, Mason, …)

Three tracks (at least one required):

| Track | Use when |
|-------|----------|
| **Matchers** (`expect.tool_calls`) | Hard rules: forbidden verbs, required verb, bbox |
| **Patterns** (`patterns:`) | Compositional mc rules (hint followed, defense before hunt) |
| **Expectations** (`expectations:`) | Intent in NL; judged with `mc_conventions` blurb |

## shell surface (Steward, …)

| Track | Use when |
|-------|----------|
| **Shell matchers** (`expect.shell_commands`) | `forbidden_substrings`, `forbidden_regex`, `required_substrings_any`, `max_lines` on `hermes` / `scripts/` lines |
| **Expectations** | Still useful; judge sees full output |

Do not use `patterns:` or `expect.tool_calls` on shell scenarios.

Default judge config (`configs/default.yaml`): separate judge model, `context_mode: mc_conventions`, `include_cheatsheet: false`, `samples: 3`.

Judge scores are **diagnostic**. Matchers/patterns drive assumption-suite signal.

## What an AI agent should do here

Prefer matchers for promotion decisions; cite judge median + spread only as supporting evidence.

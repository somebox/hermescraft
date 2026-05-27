# Scenarios

File: `data/context-tests/<id>.yaml` or draft `data/context-tests/_drafts/<id>.yaml`.

`schema_version: 2` fields: `id`, `description`, `category`, `contract_level`, `profile`, `skills`, `observe`, `prior`, `user_prompt`, `memory`, optional `grading_surface` (`mc` | `shell`) or `profile_family` (`worker` | `orchestrator`), `expect.tool_calls` or `expect.shell_commands`, `patterns` (mc only), `expectations`.

Use **`profile`** (path to persona markdown), not a separate soul field.

## Templates (`scenario new --template=`)

| Template | When |
|----------|------|
| `error-recovery` | Failed tool + `next_action_hint` |
| `policy-rule` | Behavioral rule, clean prior |
| `stuck-escalation` | Repeated failures → advise |
| `bare` | Minimal stub |

Stubs contain `TODO` markers. **`scenario validate`** fails until TODOs are resolved (`scenario validate --all` also runs fixture checks).

## Don'ts

- Do not author Steward scenarios with only `expect.tool_calls` — matchers will not see `hermes kanban` lines ([limitations.md](./limitations.md)).
- One atomic rule per scenario (no composites).
- Do not reference observe paths inside expectation text (judge does not see observe).
- Do not treat scenario pass as production ground truth.

## Example

See `data/context-tests/pillar_down_hint_honored.yaml` (recovery + matchers + expectations).

## What an AI agent should do here

`scenario new` → edit YAML → `scenario validate <id>` → `run <id> --runs 3 --yes`.

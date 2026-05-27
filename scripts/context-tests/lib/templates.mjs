export const TEMPLATES = {
  'error-recovery': (id, profile) => `schema_version: 2
id: ${id}
description: "TODO: one sentence — model should follow next_action_hint after tool failure"
category: recovery
contract_level: soft

profile: ${profile}
skills:
  - skills/minecraft-survival.md
observe: data/context-tests/_shared/observe-on-pillar.json
memory: { mode: none }

prior_format: text
prior:
  - assistant: "mc move 0 64 0"
    tool_result:
      ok: false
      error:
        code: TODO_ERROR_CODE
        message: "TODO failure message"
        next_action_hint: "mc pillar_down 6"

user_prompt: "Decide your next action."

expect:
  tool_calls:
    forbidden_canonical: [move, goto]
    required_canonical_any: [TODO]
    require_parse_ok: true
    max_lines: 4

patterns: []

expectations:
  - id: follows_hint
    text: "TODO: follows next_action_hint instead of retrying the failed action"
`,
  'policy-rule': (id, profile) => `schema_version: 2
id: ${id}
description: "TODO: behavioral rule under test"
category: policy
contract_level: soft

profile: ${profile}
skills:
  - skills/minecraft-survival.md
observe: data/context-tests/_shared/observe-base-region.json
memory: { mode: none }
prior: []

user_prompt: "TODO: user request that tempts violating the rule"

expect:
  tool_calls:
    forbidden_canonical: []
    require_parse_ok: true
    max_lines: 6

expectations:
  - id: rule_respected
    text: "TODO: NL statement of the rule"
`,
  'stuck-escalation': (id, profile) => `schema_version: 2
id: ${id}
description: "TODO: after repeated failures, escalate to advise"
category: stuck
contract_level: soft

profile: ${profile}
skills:
  - skills/minecraft-survival.md
observe: data/context-tests/_shared/observe-stuck-collect.json
memory: { mode: none }

prior_format: text
prior:
  - assistant: "mc collect stone 8"
    tool_result: { ok: false, error: { code: NO_TARGET } }
  - assistant: "mc collect stone 8"
    tool_result: { ok: false, error: { code: NO_TARGET } }

user_prompt: "Keep trying to get stone."

expect:
  tool_calls:
    required_canonical_any: [advise]
    require_parse_ok: true
    max_lines: 4

expectations:
  - id: escalates
    text: "TODO: escalates with advise after repeated NO_TARGET, does not retry collect"
`,
  bare: (id, profile) => `schema_version: 2
id: ${id}
description: "TODO"
category: TODO
contract_level: exploratory

profile: ${profile}
skills: []
observe: data/context-tests/_shared/observe-base-region.json
memory: { mode: none }
prior: []
user_prompt: "TODO"

expect:
  tool_calls:
    require_parse_ok: true
    max_lines: 4
`,
};

export function hasTodoMarkers(text) {
  if (/\bTODO\b/.test(text)) return true;
  if (/\bTODO_/.test(text)) return true;
  if (/category:\s*TODO/.test(text)) return true;
  if (/required_canonical_any:\s*\[TODO\]/.test(text)) return true;
  if (/code:\s*TODO/.test(text)) return true;
  return false;
}

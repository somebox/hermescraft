# Phase 2 — Board protocol

Section 5 of the Phase 2 architecture: card types, status transitions, dispatch + retry rules.

## 5. Board protocol

### Card types

| Type | Title prefix | Default assignee | Dispatchable | Body schema |
|------|-------------|------------------|--------------|-------------|
| `capability_test` | `[L<N>.<n>] <capability>` | character (gatherer/flint) | yes | §7 |
| `behavior_test` | `[BEH][L<N>.<n>] <scenario>` | character | yes | §7 (same schema, different mode) |
| `bug_report` | `[BUG][L<N>.<n>] <symptom>` | `human` | **no** | §11 |
| `feature_request` | `[FEAT] <feature>` | `human` | **no** | §11 |
| `skill_revision` | `[SKILL] <skill_name>: <issue>` | `human` | **no** | §11 |
| `verify_fix` | `[VERIFY][L<N>.<n>] re-run <test_id>` | character | yes | §11 |

**`capability_test` vs `behavior_test`** — both use the same fixture+predicate schema; what differs is the *failure response*:

- A `capability_test` failure means the **action layer** broke its contract. The fix lives in `bot/lib/actions/*.js` and the next loop is: `[BUG]` → fix code → `[VERIFY]`. One pass is enough to close.
- A `behavior_test` failure means the **strategy layer** is wrong — the bot's SOUL/skill chose the wrong sequence given the scenario. The fix lives in `~/.hermes/profiles/<name>/{SOUL.md,skills/...}` and the next loop is: rewrite skill → re-run → re-run → re-run until N consecutive passes. The action contracts already PASS; we're tuning judgment.

A behavior_test card body uses the same §7 schema with one extra field:

```yaml
mode: behavior_test
required_consecutive_pass: 5    # default 3; bump for higher-stakes scenarios
strategy_under_test: "skills/gaming/minecraft-survival/SKILL.md"   # what to tune on FAIL
```

Behavior tests use the fixture system to construct **adversarial scenarios** rcon-side: place a 6-block hole around the bot (can it pillar out?), spawn a zombie 3 blocks away at night with low HP and a wooden sword (can it survive?), drop a chest with locked items it must request via @steward (does it follow protocol?). The fixture YAML's `prep` block does the world surgery; the success_predicate measures whether the bot is alive / has the items / reached the mark. Failures route to `[SKILL] <skill_name>: <symptom>` cards (not `[BUG]`).

Behavior tests start showing up at L1+ (movement under constraints) and dominate L4+. L0 is all `capability_test`.

### Status transitions

Hermes Kanban built-in: `triage → todo → ready → running → done | blocked | timed_out`.

Phase 2 conventions:
- Capability tests skip `triage` (created directly in `ready` since they have full schemas at create time)
- Bug/feature/skill cards skip `triage` too (human-authored, structured)
- `verify_fix` cards depend_on the bug they verify; auto-promote when bug is `done`

### Dispatchability rules

The dispatcher must be patched to:
1. **Skip cards where `assignee == "human"`** — they stay in `ready` indefinitely
2. **Auto-promote `verify_fix`** when its parent `bug_report` is marked `done` AND parent's `summary` starts with `"fixed in "` (commit SHA marker)

### Retries and timeouts

| Card type | `--max-runtime` | `--max-retries` | Notes |
|-----------|----------------|-----------------|-------|
| capability_test | per-test (5 min default) | 1 | One transient retry; outcome (PASS/FAIL) is final |
| verify_fix | per-test | 1 | Same as test |
| bug_report | n/a | n/a | Human-managed |
| feature_request | n/a | n/a | Human-managed |

### Idempotency keys

- `capability_test`: `{level}_{capability}_{sprint}` — re-running L1.2 in sprint 1 vs sprint 2 are different cards
- `bug_report`: `{level}_{symptom_kebab}` — same symptom on same test dedupes; different symptom creates new
- `verify_fix`: `{bug_id}_verify` — exactly one verify per bug
- `feature_request` / `skill_revision`: `{feature_kebab}` / `{skill}_{issue_kebab}`

### Commit-SHA linkage

Bug-card `kanban_complete` summary string MUST follow:
```
fixed in <SHA>: <one-line description of fix>
```

The verify_fix card body references both bug_id AND `fix_commit`. The verify worker runs the original test's action_sequence and checks the success_predicate. On PASS, both cards close; on FAIL, the bug re-opens with diagnosis from the verify worker.


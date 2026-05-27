# Variants (experiments)

Experiment config: `scripts/context-tests/configs/experiments/<label>.yaml`

```yaml
inherits: ../default.yaml
label: my-label
suite:
  preset: recovery-hints          # or scenarios: [goals_gap_not_withdraw]
overrides:
  skills:
    "skills/minecraft-survival.md": "skills/experiments/survival-my-label.md"
  prompts:
    "prompts/landfolk/flint.md": "prompts/experiments/flint-my-label.md"
```

## Allowlist (override targets only)

- `prompts/experiments/`
- `skills/experiments/`
- `docs/experiments/`
- `data/context-tests/_drafts/`
- `data/context-tests/_shared/`

## CLI

```bash
./context-tuner variant new pillar_down_hint_honored my-fix --override prompts/landfolk/flint.md
# edit prompts/experiments/flint-my-fix.md
./context-tuner run scripts/context-tests/configs/experiments/my-fix.yaml --yes
```

Stdin body: `./context-tuner variant new <scenario> <label> --profile - < patched.md`

## Suite + experiment together

```bash
./context-tuner run region-protect --config scripts/context-tests/configs/experiments/my-fix.yaml --yes
```

## What an AI agent should do here

Never edit production `prompts/landfolk/*.md` until a human promotes after `compare` + optional suite re-run.

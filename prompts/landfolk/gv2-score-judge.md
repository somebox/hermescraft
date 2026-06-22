# Genesis-v2 score judge (optional LLM)

Read `scorecard.json` metrics and cite evidence ids. Output strict JSON only:

- `headline_nuance`: one paragraph
- `proposed_actions`: up to 3 items with `type`, `title`, `evidence`, `confidence`

Do not override deterministic counts in the scorecard.

# Spec — extract (c) architecture-falsification + (d) testing/experiment-integrity learnings

This spec (spec.md) complements `findings-postmortems.md`, which already extracts themes **(a) bot/verb honesty**, **(b) multi-bot cooperation**, and **(e) world/fixtures/genesis** from the two-bot trial postmortems and `docs/devlog/genesis-v2-devlog.md`. This run extracts the remaining two themes — **(c) architecture falsification** and **(d) testing & experiment-integrity methodology** — from the retrospective (non-overview, non-runbook, non-plan) docs dated **>= 2026-05-31**, and writes a structured tried/worked/failed/decided list to `findings-testing-integrity.md` (repo root, mirroring `findings-postmortems.md`). Do **not** re-extract from `docs/devlog/genesis-v2-devlog.md` or the `reports/agent-arch/2026-06-07-two-bot-trial-*-postmortem.md` files — those are already mined for (a)/(b)/(e); cross-reference them only where a testing-integrity item is not already captured.

## Source set (read all; cite file + date + run id where present)

1. **Experiment integrity audit** — `reports/agent-arch/2026-06-06-experiment-integrity-audit.md`.
2. **Clean comparison + multi-phase comparison cluster** — `reports/agent-arch/2026-06-06-clean-comparison.md`, `2026-06-06-multi-phase-chain-comparison.md`, `2026-06-06-multi-phase-clean-plan.md`, `2026-06-06-pinch-test-replication.md`, `2026-06-06-live-pinch-test.md`, and `reports/agent-arch/landfolk-test-env-review.md`.
3. **Context-tuner closure + status + learnings-promotion ledger** — `docs/testing/context-tuner/{README,limitations,grading,dogfood,cli,scenarios,variants,workflow-agents,learnings-promotion}.md` and `docs/testing/context-tuner/reports/{2026-06-17-terrain-shaping-closure,2026-06-19-terrain-shaping-status,2026-05-27-goals-gap-context-tuning,2026-05-29-observe-package-one}.md` (the 2026-05-27/05-29 reports are cusp-predecessor baseline context for the June closure/ledger; include but flag the boundary).
4. **Playbook improvement-pass closure (cusp predecessor, dated 2026-05-31)** — `docs/testing/playbooks/improvement-pass-closure.md` (primary), plus `docs/testing/playbooks/{design-composable-playbooks,fixture-baseline-turns,README}.md` and archive predecessor `docs/archive/testing/playbooks/improvement-pass-followup.md` for the closure's antecedent findings.
5. **Bot test-coverage matrix** — `docs/reference/audits/bot-test-coverage-2026-06-06.md` and `docs/reference/audits/bot-test-coverage-2026-06-24.md` (treat the delta between the two as a learning).
6. **Supporting falsification/audit docs (retrospective, not plans)** — `docs/testing/{arena-spatial-audit,nav-parity-audit,construct-node-arena-parity,construct-canary-policy}.md`, `docs/testing/genesis-v2/{competence-scorecard,goalchanged-evidence-matrix,plan-alignment}.md`, and `docs/testing/procedural/{testing-model,smoke-closure}.md`. **Skip** `docs/testing/procedural/{planning-tracker,plan-phase-10,scenario-runs,map-catalog}.md` (forward-looking plans/runbooks) and all `docs/architecture/*` overview docs (stable reference).

## Exclusions (per user)
- Skip architecture-overview docs (stable reference, not learnings).
- Skip runbooks and plans (forward-looking, not learnings).
- Skip themes (a), (b), (e) bot/fleet/world — already in `findings-postmortems.md`.
- Skip the two-bot-trial postmortems and the genesis-v2 devlog as primary sources (already mined); cross-reference only.

## Output format
- Group under two headings: `## (c) Architecture falsification` and `## (d) Testing & experiment-integrity methodology`.
- Each bullet: **topic** — `file` (date, run id if present). *Tried:* … *Worked:* … *Failed:* … *Decided:* … (mirror findings-postmortems.md style).
- Preserve numerical claims verbatim (e.g. -50% tokens, 8/11, n=3, 0.80→0.10, +/-%).
- End with a "Notes on scope and gaps" section naming what was skipped and why.

## Steps

1. **(util) Execute** — Read every file in the source set above (use `read` + `bash rg`/`head` to triage). Extract the (c)+(d) learnings into `findings-testing-integrity.md` following the output format. Write `context.md` listing the files actually read, any that were empty/non-retrospective, and any date-boundary judgment calls. Do not add features or edit other files.
2. **(research) Review** — Read `spec.md` + `context.md` + `findings-testing-integrity.md`. Verify the work matches this spec: both headings present, every focus area (1–6) represented, citations include file+date, numerical claims verbatim, no (a)/(b)/(e) duplication with findings-postmortems.md. List gaps with `file:line` references in `review.md`; if good, write a 1-paragraph assessment.
3. **(high) Accept** — Read `spec.md` + `context.md` + `review.md`. Return a one-line verdict: `accept` or `kick back` (with the top 1–2 fixes that would flip it).

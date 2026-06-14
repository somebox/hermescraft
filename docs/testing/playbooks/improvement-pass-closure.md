# Playbook improvement pass — closure (2026-05-31)

**Status: closed.** This pass targeted playbook adoption, envelope honesty, and
agent-test falsification on `landfolk-test`. Work stops here; the next testing
direction is **procedurally generated worlds** with controlled conditions for
farming, mining, scouting, and field prep—not more build-geometry matrices on
fixed slabs. Spec: [scenario-runs.md](../procedural/scenario-runs.md)
(catalog pool + planned `mapcatalog scenario` CLI). Map finder: [map-catalog.md](../procedural/map-catalog.md).

## Why we closed

- **Mechanism is shipped:** JSONL chokepoint, nav-telemetry, playbook phase
  context, sub-play propagation, hint injector, agent-test harness (including
  batched rcon predicates and reset cycle).
- **Core hypotheses were measured:** flat playbook vs prose (A1), preflight (A2),
  resume (A3), composition telemetry (A4), build granularity (Wave 6).
- **Remaining genesis pain** (prep, transit, return path, tunnel discipline) is
  poorly approximated by tower fixtures; iterating there has diminishing returns
  compared with **realistic maps + repeatable scenarios**.
- **Strategic pivot:** invest in a **proven library of skills, mc primitives, and
  Steward/worker collaboration patterns**, validated through iteration on varied
  worlds—not a 25-id playbook catalog or a bot-side playbook engine.

## Outcomes (keep these)

| Area | Result | Production implication |
|------|--------|-------------------------|
| Stage 0–1 | Envelope + #54/#56/#58 + hints | Ship; regression via bot CI + stress stubs |
| A1 chop flat | **Falsified** at Flash (n=5) | Simple **[SUPPLY]** → prose-skilled + domain skills |
| A2 preflight | **Pass** | Block before act when prep unmet |
| A3 resume | **Pass** | `[run_state]` + partial-world handoffs are first-class |
| A4 composition | Sub-play JSONL **OK**; Flash completion weak | Composition instrumented; not default worker win |
| W6-T1 column | Prose wins cost/completion | No Steward `build.tower_vertical` for single column |
| W6-T3 platform | **Resume 3/3**; coarse 0/3 | Multi-anchor handoff → resume pattern, not ritual |
| W6-T4 scaffold | Coarse **2/3** vs prose **0/3** | **Closeout complexity** axis: multi-verb teardown + return |

**Authoring policy (both forms valid):**

- **Descriptive (prose-skilled)** — single-loop tasks with trivial closeout
  (chop, simple build, deposit).
- **Structured (playbook or explicit phase/checklist)** — preflight discipline,
  resume checkpoints, multi-verb closeout (scaffold teardown, strict world bbox).
- **Not binary:** Steward picks **card shape** per task section (prep, work,
  closeout); registry playbooks remain **test harness + optional templates**, not
  the default for every card.

**Explicitly deferred / withdrawn:**

- Bot-side playbook engine auto-walking phases
- Broad Stage 3 catalog (~25 ids)
- Pro model escalation to “rescue” falsified worker arms
- Stage 4 genesis A/B as a **gate for this pass** (content + field work still open)

## Preserved artifacts (do not delete)

| Kind | Location |
|------|----------|
| Master plan (historical) | [`improvement-pass-followup.md`](../../archive/testing/playbooks/improvement-pass-followup.md) |
| Test runbook (historical) | [`playbook-pass-test-procedure.md`](../../archive/testing/playbooks/test-procedure.md) |
| Wave 6 results | [`lab-wave-6-granularity.md`](../../archive/testing/playbooks/lab-wave-6-granularity.md) |
| A1/A4 fixture numbers | [`baseline-turns-fixture.md`](fixture-baseline-turns.md) |
| Agent-test specs | `data/agent-tests/playbooks/` (chop, tower, scaffold) |
| Playbook registry (lab ids) | `data/playbooks/registry.yaml`, `docs/testing/playbooks/catalog/` |
| Harness | `scripts/agent-test.py`, `scripts/stress.sh` |
| Orchestration design | [`design-composable-playbooks.md`](design-composable-playbooks.md) |
| Future substrate (unchanged) | [`agent-scripting-layer.md`](../../specs/agent/scripting-layer-dsl.md) |

Regression commands that remain useful:

```bash
cd bot && HERMES_VALIDATE=1 npm test
scripts/stress.sh chop-preflight-refusal
scripts/stress.sh chop-checkpoint-resume
scripts/regenerate-artifacts.sh
```

## Successor direction (not part of this pass)

1. **Procedural / parametric test worlds** — farming plots, mine faces, scout
   routes, surface vs underground with bounded dig boxes and muster marks.
2. **Scenario library** tied to worlds — prep, transit, work, closeout; same
   agent-test + predicate pattern, richer ecology than flat slabs.
3. **Skills and collaboration patterns** — kanban-worker, mining, navigation,
   Steward decomposition; expand from **observed failures** on those worlds.
4. **Add playbooks one at a time** only when a scenario shows prose-inexpressible
   discipline or multi-verb closeout that skills alone do not fix.

Genesis integration (`genesis-boot-cards.md`, content track) continues on its own
timeline; this closure does not block genesis—it reframes how we **bench** worker
behavior before the next full run.

## Worklog pointer

- Genesis evidence: `data/genesis-runs/g-2026-05-30-3/findings/` (local run dir)
- Agent-test run JSON: `data/agent-tests/runs/` (when present on bench hosts)
- Postmortem themes: card re-interpretation, prep traps, return path — see
  [`improvement-pass-followup.md`](../../archive/testing/playbooks/improvement-pass-followup.md) § Why this pass

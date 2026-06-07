"""Wheat-farm capstone scaffold (Session 5a).

This subpackage holds the *runner code* for the wheat-farm capstone
described in the colony validation plan (Session 5). The live trial
(Session 5b) is run manually by the operator — see ``README.md`` for
the pre-flight gate and trial procedure. The scaffold is testable
without any live infrastructure.

Modules:
  - ``wheat_graph`` — canonical colony card graph (data only)
  - ``wide_baseline`` — single-flint-card control (data only)
  - ``acceptance`` — predicates expressible via current ``mc verify``
  - ``author`` — translate a graph into ``hermes kanban create`` calls

Plan: ../../../reports/agent-arch/2026-06-06-colony-validation-plan.md
"""

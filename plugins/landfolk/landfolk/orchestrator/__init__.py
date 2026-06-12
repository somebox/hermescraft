"""Per-assignee kanban concurrency for the landfolk-ops board.

Public surface:

- :func:`gate.gate_check` — the idempotent SQL pass invoked by the
  CLI verb each dispatcher tick.
- :func:`promote.promote_next_for` — promotes the highest-priority
  ``todo`` card for an idle assignee. Used by hooks and gate-check.
- :mod:`hooks` — ``post_tool_call`` observer handlers.
- :mod:`cli` — argparse setup for ``hermes landfolk gate-check``.

Design + acceptance criteria live in
``hermescraft/docs/specs/kanban/plugin-landfolk.md``.
"""

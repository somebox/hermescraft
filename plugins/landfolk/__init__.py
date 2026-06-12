"""landfolk Hermes plugin entry point.

Phase 1 wires the ``orchestrator/`` subsystem:
  - ``post_tool_call`` observer hooks on kanban verbs.
  - ``hermes landfolk gate-check`` CLI subcommand.

Future subsystems (mc_tools, compressor, memory, mc_chat_adapter,
detectors) live alongside ``landfolk/orchestrator/`` and get wired in
by extending this register() function. Full spec lives in
``hermescraft/docs/specs/kanban/plugin-landfolk.md``.
"""

from __future__ import annotations

from .landfolk.orchestrator import cli as orch_cli
from .landfolk.orchestrator import hooks as orch_hooks


def register(ctx) -> None:
    """Plugin loader entry point — called once at plugin enable.

    The ``ctx`` argument is a ``PluginContext`` (see
    ``hermes_cli/plugins.py``). We use:
      - ``register_hook(name, fn)`` to install observer callbacks.
      - ``register_cli_command(name, help, setup_fn, ...)`` to add the
        ``hermes landfolk <verb>`` namespace.
    """
    ctx.register_hook("post_tool_call", orch_hooks.on_post_tool_call)
    ctx.register_cli_command(
        name="landfolk",
        help="Landfolk-specific kanban orchestration + future subsystems.",
        setup_fn=orch_cli.setup,
        handler_fn=orch_cli.handle,
        description=(
            "Per-assignee concurrency cap for the landfolk-ops kanban board. "
            "Run `hermes landfolk gate-check` once per dispatcher tick before "
            "`hermes kanban dispatch`. Spec: hermescraft/docs/specs/kanban/plugin-landfolk.md"
        ),
    )

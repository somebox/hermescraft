**If `HERMES_KANBAN_TASK` is set in your env, OR `mc status` shows the bot already has an in-flight kanban claim, exit immediately with no `mc` calls.** The kanban worker owns the bot — issuing your own commands here causes pathfinder goal contention ("Navigation failed: The goal was changed before it could be completed"). You'll wake again when the bot is idle.

Otherwise: Continue. Run: `mc status`, `mc read_chat`, `mc goals`.

Pick the top-urgency goal, execute one focused subtask (3-8 mc commands), report one progress line.

Only use mc commands. If blocked twice, `mc help` (or `skill_view minecraft-<topic>`) and switch goals.

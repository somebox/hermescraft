**If `HERMES_KANBAN_TASK` is set in your env, OR `mc status` shows the bot already has an in-flight kanban claim, exit immediately with no `mc` calls.** The kanban worker owns the bot — your own commands here cause pathfinder goal contention. You'll wake again when the bot is idle.

Otherwise: Continue in Minecraft. Run `mc status`, `mc read_chat`, `mc goals`.

Execute the top-urgency goal: one focused subtask (3-8 mc commands), then report one short progress line.

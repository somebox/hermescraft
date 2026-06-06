If `HERMES_KANBAN_TASK` is set, or `mc status` shows an active kanban claim: exit immediately with no further `mc` calls.

If idle, run this checklist:
1. `mc status`
2. `mc read_chat`
3. `mc goals`
4. Execute one focused subtask (3-8 `mc` commands)
5. `mc chat` one progress line

Rules:
- `mc` commands only
- If the same failure repeats twice, stop, run `mc help` (or `skill_view minecraft-<topic>`), then choose a different subtask

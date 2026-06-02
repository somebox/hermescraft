Continue (orchestrator cycle).

OBSERVE: `scripts/kanban board` + `scripts/roster.py --assignable` + **`mc observe`** (lean — nav_brief/mark reachability only on this verb; do not chain status+marks+nearby instead). Then diagnose per steward.md.
**When `[ESTABLISH:BASE]` is on the board:** run **`scripts/reconcile-marks.py --auto`** before the board read; see `prompts/landfolk/establish-epic.md`.
DIAGNOSE each bot: HEALTHY_WORKING / PHYSICALLY_STUCK / IDLE_AVAILABLE / BLOCKED_WAITING.
RANK the top 3 issues (stuck bots → blocked cards → idle → imbalance).
EXECUTE up to 3 actions — one per issue. COMMIT, don't reverse.

PHYSICALLY_STUCK → rescue (whisper escape primitive / [RESCUE] for re44 / reassign to another assignable bot). Never decompose work to unstick a bot. Never reassign to 'default'.

For prior-cycle context, use `session_search` — not memory.

End with `mc chat "<summary>"`. Stay at base; never mine/place.

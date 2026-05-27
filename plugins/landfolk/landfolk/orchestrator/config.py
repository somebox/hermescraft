"""Configuration constants for the orchestrator subsystem.

Everything that varies between environments / incidents is an env var
read once at module import. The values are intentionally cheap to
compute so test fixtures can `importlib.reload` the module after
mutating the environment.
"""

from __future__ import annotations

import os


def _truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


# Board the orchestrator gates on. Tests override via env.
BOARD: str = os.environ.get("LANDFOLK_BOARD", "landfolk-ops")

# Orchestrator-class profiles. Cards assigned to these never get
# dispatcher-spawned: the gate-check sets `claim_lock=orch_continuous:<name>`
# so the dispatcher's `WHERE claim_lock IS NULL` selector skips them. The
# orchestrator (Steward) processes her own queue out-of-band.
ORCHESTRATOR_PROFILES: frozenset[str] = frozenset(
    p.strip().lower()
    for p in os.environ.get("LANDFOLK_ORCH_PROFILES", "steward").split(",")
    if p.strip()
)

# claim_lock value prefix the gate-check writes when parking an
# orchestrator card. Release logic keys on this prefix so we only
# release locks we own.
ORCH_LOCK_PREFIX: str = "orch_continuous:"

# claim_lock value prefix the gate-check writes when parking a
# NON-orchestrator excess ready card (per-assignee mutex). Same
# mechanism, different prefix so the two release paths stay
# separable. Distinct from the status-demote (ready→todo) mechanism
# originally specified — that approach lost to `recompute_ready`'s
# auto-promotion of parent-less todos on every `kanban list` call.
# claim_lock parking is recompute_ready-safe: the card stays `ready`
# (visible in the queue) but the dispatcher's
# `WHERE claim_lock IS NULL` selector skips it.
MUTEX_LOCK_PREFIX: str = "mutex_park:"

# Re-applied each tick. A 1-hour TTL means a missed tick (e.g.
# dispatcher down) still keeps the lock valid until the next run.
LOCK_TTL_SECONDS: int = 3600

# Cards whose title starts with this prefix are exempt from the
# per-assignee cap — they're operator-initiated interruption requests
# (e.g. in-game @bot whispers) and should run alongside the bot's
# current task.
CHAT_REQUEST_PREFIX: str = "[CHAT_REQUEST]"

# Where the gate-check writes its single-line tick output. Defaults to
# the same file the dispatcher script writes to, so operators have one
# place to tail.
LOG_PATH: str = os.environ.get("LANDFOLK_LOG", "/tmp/hermescraft/dispatcher.log")

# Incident kill switches. Setting either of these disables the
# corresponding layer without uninstalling the plugin.
DISABLE_GATE: bool = _truthy("LANDFOLK_DISABLE_GATE")
DISABLE_HOOKS: bool = _truthy("LANDFOLK_DISABLE_HOOKS")

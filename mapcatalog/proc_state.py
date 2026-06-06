"""Track last materialized proc-* world seed for fast reuse on agent re-runs."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


def repo_root() -> Path:
    here = Path(__file__).resolve()
    for p in [here.parent, *here.parents]:
        if (p / "mapcatalog").is_dir() and (p / "AGENTS.md").exists():
            return p
    return here.parent.parent


def state_path() -> Path:
    return repo_root() / "data" / "runtime" / "proc-lab-state.json"


def read_state() -> dict:
    path = state_path()
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def write_state(*, world_name: str, seed: str, requirements_id: str | None = None) -> None:
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "world_name": world_name,
        "seed": str(seed),
        "requirements_id": requirements_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def seed_matches_loaded(world_name: str, seed: str) -> bool:
    st = read_state()
    return st.get("world_name") == world_name and str(st.get("seed")) == str(seed)

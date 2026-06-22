from __future__ import annotations

import json
from pathlib import Path


def extract_cards(board: list[dict], *, run_root: Path | None = None) -> dict:
    kanban_runs: dict[str, dict] = {}
    if run_root:
        kr = run_root / "artifacts" / "kanban-runs.json"
        if kr.is_file():
            try:
                payload = json.loads(kr.read_text())
                for c in payload.get("cards") or []:
                    tid = c.get("id")
                    if tid:
                        kanban_runs[tid] = c
            except (json.JSONDecodeError, OSError):
                pass
    cards = []
    for t in board:
        st = (t.get("status") or "").lower()
        outcome = "done" if st in ("done", "archived") else st
        eff = 80 if outcome == "done" else 20
        rec = {
            "id": t.get("id"),
            "title": t.get("title"),
            "size": t.get("size"),
            "outcome": outcome,
            "effectiveness": eff,
        }
        k = kanban_runs.get(t.get("id") or "")
        if k:
            runs = k.get("task_runs") or []
            if runs:
                rec["wall_s"] = (
                    int(runs[0]["ended_at"]) - int(runs[0]["started_at"])
                    if runs[0].get("started_at") and runs[0].get("ended_at")
                    else None
                )
        cards.append(rec)
    effs = [c["effectiveness"] for c in cards if c["outcome"] == "done"]
    median = sorted(effs)[len(effs) // 2] if effs else None
    return {"cards": cards, "effectiveness_median": median}

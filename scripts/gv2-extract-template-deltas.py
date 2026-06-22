#!/usr/bin/env python3
"""Extract template/playbook deltas from captured RETRO bodies into template-changelog.jsonl."""
from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CHANGELOG = REPO / "data" / "genesis-v2" / "template-changelog.jsonl"
QUEUE = REPO / "data" / "genesis-v2" / "improvement-queue.json"

TAG_RE = re.compile(
    r"^(TEMPLATE_PATCH|MISSING_PREFLIGHT|PLAYBOOK_CANDIDATE)\s*:\s*(.+)$",
    re.IGNORECASE | re.MULTILINE,
)


def extract_from_text(text: str, *, run_id: str, source: str) -> list[dict]:
    out: list[dict] = []
    for m in TAG_RE.finditer(text or ""):
        out.append(
            {
                "id": f"td-{uuid.uuid4().hex[:10]}",
                "run_id": run_id,
                "source": source,
                "tag": m.group(1).upper(),
                "payload": m.group(2).strip(),
                "recorded_at": datetime.now(timezone.utc).isoformat(),
            }
        )
    return out


def load_retro_bodies(run_dir: Path) -> list[tuple[str, str]]:
    bundle = run_dir / "feedback-bundle.json"
    if bundle.is_file():
        data = json.loads(bundle.read_text())
        rows = []
        for r in data.get("retro_cards") or []:
            body = r.get("body") or ""
            tid = r.get("task_id") or r.get("assignee") or "retro"
            rows.append((str(tid), body))
        return rows
    board = run_dir / "artifacts" / "board.json"
    if not board.is_file():
        return []
    tasks = json.loads(board.read_text())
    if isinstance(tasks, dict):
        tasks = tasks.get("tasks") or []
    rows = []
    for t in tasks:
        if "[RETRO]" not in (t.get("title") or ""):
            continue
        rows.append((str(t.get("id")), t.get("body") or ""))
    return rows


def append_changelog(records: list[dict], changelog: Path) -> int:
    if not records:
        return 0
    changelog.parent.mkdir(parents=True, exist_ok=True)
    with changelog.open("a", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return len(records)


def ingest_queue(records: list[dict]) -> int:
    if not records or not QUEUE.is_file():
        return 0
    data = json.loads(QUEUE.read_text())
    items = data.setdefault("items", [])
    existing = {(it.get("title") or "").strip() for it in items}
    added = 0
    for rec in records:
        title = f"{rec['tag']}: {rec['payload'][:120]}"
        if title in existing:
            continue
        work_id = f"gv2-td-{rec['id']}"
        items.append(
            {
                "work_id": work_id,
                "status": "proposed",
                "type": "template_delta",
                "title": title,
                "source_run_id": rec["run_id"],
                "evidence": [rec["source"], rec["tag"]],
                "candidate_direction": rec["payload"],
            }
        )
        existing.add(title)
        added += 1
    QUEUE.write_text(json.dumps(data, indent=2) + "\n")
    return added


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--run-id", required=True)
    p.add_argument("--run-dir", type=Path)
    p.add_argument("--changelog", type=Path, default=CHANGELOG)
    p.add_argument("--ingest-queue", action="store_true")
    args = p.parse_args()
    sys.path.insert(0, str(REPO / "scripts"))
    import genesis2_lib as g2  # noqa: E402

    run_dir = args.run_dir or g2.run_dir(args.run_id)
    records: list[dict] = []
    for tid, body in load_retro_bodies(run_dir):
        records.extend(
            extract_from_text(body, run_id=args.run_id, source=f"retro:{tid}")
        )
    n = append_changelog(records, args.changelog)
    ingested = ingest_queue(records) if args.ingest_queue else 0
    print(json.dumps({"extracted": len(records), "appended": n, "queue_ingested": ingested}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

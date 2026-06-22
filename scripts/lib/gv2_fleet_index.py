from __future__ import annotations

import html
import json
from pathlib import Path

import genesis2_lib as g2
from scripts.lib.gv2_run_nav import build_run_nav


def _render_fleet_index_html(index: dict, runs_root: Path) -> None:
    rows = index.get("runs") or []
    trs = []
    for r in rows:
        rid = html.escape(str(r.get("run_id") or ""))
        dash = r.get("dashboard_path") or ""
        link = f"../{rid}/dashboard/index.html" if rid else "#"
        trs.append(
            f"<tr><td><a href=\"{html.escape(link)}\">{rid}</a></td>"
            f"<td>{html.escape(str(r.get('achievement_level') or ''))}</td>"
            f"<td>{html.escape(str(r.get('overall') or ''))}</td>"
            f"<td>{html.escape(str(r.get('compare_safe') or ''))}</td></tr>"
        )
    body = "\n".join(trs) or "<tr><td colspan=\"4\">No scored runs yet</td></tr>"
    page = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>gv2 fleet index</title>
<style>body{{font-family:system-ui;margin:1.5rem}} table{{border-collapse:collapse}} td,th{{border:1px solid #ccc;padding:.4rem .6rem}}</style>
</head><body>
<h1>Genesis-v2 scored runs</h1>
<p>Machine index: <code>_index.json</code> (regenerated on each score-run under fleet runs root).</p>
<table><thead><tr><th>run_id</th><th>level</th><th>overall</th><th>compare_safe</th></tr></thead>
<tbody>{body}</tbody></table>
</body></html>"""
    idx_dir = runs_root / "_index"
    idx_dir.mkdir(parents=True, exist_ok=True)
    (idx_dir / "index.html").write_text(page, encoding="utf-8")


def update_fleet_artifacts(run_root: Path, scorecard: dict) -> None:
    """Refresh fleet _index.json, _index/index.html, and per-run run-nav.json."""
    run_root = run_root.resolve()
    runs_root = g2.runs_root().resolve()
    under_fleet = False
    try:
        run_root.relative_to(runs_root)
        under_fleet = True
    except ValueError:
        pass

    run_id = scorecard.get("run_id") or run_root.name
    summary = scorecard.get("summary") or {}
    ach = summary.get("achievement_level") or {}
    cfg = None
    spawn = None
    cfg_path = run_root / "config.json"
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text())
            spawn = cfg.get("spawn")
        except (json.JSONDecodeError, OSError):
            pass

    nav = build_run_nav(run_root, cfg)
    nav["overall"] = summary.get("overall")
    nav["achievement_level"] = ach.get("current")
    nav["paths"] = {
        "scorecard": "scorecard.json",
        "postmortem": "postmortem.md",
        "dashboard": "dashboard/index.html",
        "feedback": "feedback-bundle.json",
    }
    cmp_ = summary.get("compare") or {}
    if cmp_.get("prev_run_id"):
        nav["prev_run_id"] = cmp_["prev_run_id"]
    if cmp_.get("baseline_run_id"):
        nav["baseline_run_id"] = cmp_["baseline_run_id"]
    (run_root / "run-nav.json").write_text(json.dumps(nav, indent=2) + "\n")

    if not under_fleet:
        return

    op = summary.get("operational") or {}
    ach_block = summary.get("achievement") or {}
    entry = {
        "run_id": run_id,
        "overall": summary.get("overall"),
        "achievement_level": ach.get("current"),
        "compare_safe": cmp_.get("compare_safe"),
        "loop_goal": (summary.get("loop_goal") or "")[:80],
        "ops_err": op.get("motor_errors_scoped"),
        "achieve_score": ach_block.get("establishment_score"),
        "vs_prev_delta": cmp_.get("overall_delta_vs_prev"),
        "spawn": spawn,
        "scorecard_path": str(run_root / "scorecard.json"),
        "dashboard_path": str(run_root / "dashboard" / "index.html"),
    }
    index_path = runs_root / "_index.json"
    index: dict = {"runs": []}
    if index_path.is_file():
        try:
            index = json.loads(index_path.read_text())
        except (json.JSONDecodeError, OSError):
            index = {"runs": []}
    runs = [r for r in (index.get("runs") or []) if r.get("run_id") != run_id]
    runs.append(entry)
    runs.sort(key=lambda r: r.get("run_id") or "", reverse=True)
    index["runs"] = runs[:50]
    index_path.write_text(json.dumps(index, indent=2) + "\n")
    _render_fleet_index_html(index, runs_root)

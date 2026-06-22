#!/usr/bin/env python3
"""Assemble genesis-v2 scorecard from frozen run artifacts."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "scripts"))

import genesis2_lib as g2  # noqa: E402
from scripts.lib.gv2_fleet_index import update_fleet_artifacts  # noqa: E402
from scripts.lib.gv2_metrics.achievement_level import evaluate_achievement_level  # noqa: E402
from scripts.lib.gv2_metrics.audit import extract_audit  # noqa: E402
from scripts.lib.gv2_metrics.board_quality import extract_board_quality  # noqa: E402
from scripts.lib.gv2_metrics.cards import extract_cards  # noqa: E402
from scripts.lib.gv2_metrics.compare_enrich import enrich_compare  # noqa: E402
from scripts.lib.gv2_metrics.establishment import extract_establishment  # noqa: E402
from scripts.lib.gv2_metrics.fleet import extract_fleet  # noqa: E402
from scripts.lib.gv2_metrics.motor import extract_motor  # noqa: E402
from scripts.lib.gv2_metrics.production import extract_production  # noqa: E402
from scripts.lib.gv2_metrics.summary import build_summary, evaluate_expected_metrics  # noqa: E402
from scripts.lib.gv2_metrics.time import extract_time  # noqa: E402
from scripts.lib.gv2_metrics_history import append_metrics_history  # noqa: E402
from scripts.lib.gv2_smoke_status import smoke_status_for_run  # noqa: E402


def score_run(run_root: Path) -> dict:
    config = json.loads((run_root / "config.json").read_text())
    if not config.get("prev_run_id"):
        rid = config.get("run_id") or run_root.name
        prev = g2.previous_run_id(rid)
        if prev:
            config["prev_run_id"] = prev
    art = run_root / "artifacts"
    board_raw = json.loads((art / "board.json").read_text()) if (art / "board.json").is_file() else []
    board = board_raw if isinstance(board_raw, list) else list(board_raw.get("tasks") or [])
    retro = g2.retro_card_snapshot(tasks=board)
    time_m = extract_time(config, board)
    motor = extract_motor(art)
    metrics = {
        "time": time_m,
        "motor": motor,
        "production": extract_production(run_root),
        "establishment": extract_establishment(run_root),
        "board_quality": extract_board_quality(board),
        "cards": extract_cards(board, run_root=run_root),
        "fleet": extract_fleet(art, time_m.get("run_wall_s")),
        "audit": extract_audit(run_root, art / "action-log-scope.json"),
    }
    if os.environ.get("GV2_SCORE_SKIP_SMOKE") != "1":
        metrics["smoke_status"] = smoke_status_for_run(run_root)
    summary = build_summary(config=config, metrics=metrics, retro=retro)
    eval_metrics = {
        **metrics,
        "operational": {**summary["operational"], "retro_pending": retro.get("pending", 0)},
        "compare": summary["compare"],
        "establishment": metrics["establishment"],
    }
    tier = config.get("tier") or "standard"
    ach = evaluate_achievement_level(eval_metrics, summary, tier)
    summary["achievement_level"] = ach
    enrich_compare(
        config=config,
        summary=summary,
        run_root=run_root,
        repo_root=REPO,
        achievement_level=ach,
    )
    ctx = {
        "metrics": metrics,
        "summary": summary,
        "compare": summary.get("compare") or {},
        "audit": metrics.get("audit") or {},
        "achievement_level": ach,
    }
    flat = {
        "retro_pending": retro.get("pending", 0),
        "establishment_score": metrics["establishment"].get("score"),
        "craft_error_share": 0,
    }
    summary["outcome_vs_expected"] = evaluate_expected_metrics(
        config.get("expected_metrics") or {}, flat, context=ctx
    )
    scorecard = {
        "schema_version": 1,
        "run_id": config.get("run_id") or run_root.name,
        "metrics": metrics,
        "summary": summary,
        "feedback": {
            "bundle_path": "feedback-bundle.json",
            "retro_count": retro.get("total"),
            "retro_pending_at_capture": retro.get("pending", 0),
        },
    }
    return scorecard


def write_next_actions(run_root: Path, scorecard: dict) -> None:
    gaps = (scorecard.get("summary") or {}).get("achievement_level", {}).get("gaps") or []
    actions = []
    if gaps:
        actions.append(
            {
                "id": "na-1",
                "type": "planner_prompt_or_skill",
                "title": f"Close gap: {gaps[0][:80]}",
                "evidence": gaps[:3],
                "confidence": "medium",
                "predicted_delta": {"establishment": 5},
                "suggested_test": "scripts/tests/test_gv2_establishment_ladder.py",
            }
        )
    (run_root / "next-actions.json").write_text(json.dumps(actions[:3], indent=2) + "\n")


def write_postmortem(run_root: Path, scorecard: dict) -> None:
    s = scorecard["summary"]
    lines = [
        f"# Postmortem {scorecard['run_id']}",
        "",
        f"**Headline:** {s.get('headline')}",
        f"**Level:** {(s.get('achievement_level') or {}).get('current')}",
        "",
        "## Operational",
        json.dumps(s.get("operational"), indent=2),
        "",
        "## Achievement",
        json.dumps(s.get("achievement"), indent=2),
    ]
    (run_root / "postmortem.md").write_text("\n".join(lines) + "\n")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--run-id")
    p.add_argument("--run-dir", type=Path)
    p.add_argument("--no-llm", action="store_true", default=True)
    args = p.parse_args()
    if args.run_dir:
        root = args.run_dir
    elif args.run_id:
        root = g2.run_dir(args.run_id)
    else:
        rid = g2.active_run_id()
        if not rid:
            print("no run", file=sys.stderr)
            return 2
        root = g2.run_dir(rid)
    scorecard = score_run(root)
    (root / "scorecard.json").write_text(json.dumps(scorecard, indent=2) + "\n")
    update_fleet_artifacts(root, scorecard)
    if g2.runs_root().resolve() in root.resolve().parents:
        append_metrics_history(scorecard)
    write_postmortem(root, scorecard)
    write_next_actions(root, scorecard)
    render = REPO / "scripts" / "gv2-render-dashboard.py"
    if render.is_file():
        import subprocess

        subprocess.run(
            [sys.executable, str(render), "--run-dir", str(root)],
            cwd=REPO,
            check=False,
        )
    print(json.dumps({"run_id": scorecard["run_id"], "overall": scorecard["summary"].get("overall")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

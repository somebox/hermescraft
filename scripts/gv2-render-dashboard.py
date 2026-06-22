#!/usr/bin/env python3
"""Render static run dashboard from scorecard.json."""
from __future__ import annotations

import argparse
import html
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TEMPLATE = REPO / "scripts" / "gv2-dashboard" / "template.html"


def render(run_root: Path) -> Path:
    score_path = run_root / "scorecard.json"
    if not score_path.is_file():
        raise FileNotFoundError(score_path)
    sc = json.loads(score_path.read_text())
    s = sc.get("summary") or {}
    ach = s.get("achievement_level") or {}
    cmp_ = s.get("compare") or {}
    nav_path = run_root / "run-nav.json"
    nav = json.loads(nav_path.read_text()) if nav_path.is_file() else {}
    prev = nav.get("prev_run_id") or cmp_.get("prev_run_id")
    nxt = nav.get("next_run_id")
    nav_bits = []
    if prev:
        nav_bits.append(f'<a href="../../{html.escape(prev)}/dashboard/index.html">← {html.escape(prev)}</a>')
    nav_bits.append(f"<strong>{html.escape(str(sc.get('run_id') or run_root.name))}</strong>")
    if nxt:
        nav_bits.append(f'<a href="../../{html.escape(nxt)}/dashboard/index.html">{html.escape(nxt)} →</a>')
    nav_bits.append('<a href="../../_index/index.html">fleet index</a>')
    nav_html = " · ".join(nav_bits)
    delta = cmp_.get("overall_delta_vs_prev")
    compare_strip = ""
    if delta is not None:
        compare_strip = f"Δ vs prev: {delta:+d} · compare_safe={cmp_.get('compare_safe')}"
    elif cmp_.get("prev_run_id"):
        compare_strip = "No prior scorecard for delta · compare_safe=" + str(cmp_.get("compare_safe"))
    tpl = TEMPLATE.read_text(encoding="utf-8")
    out = (
        tpl.replace("{{RUN_ID}}", html.escape(str(sc.get("run_id") or run_root.name)))
        .replace("{{LOOP_GOAL}}", html.escape(str(s.get("loop_goal") or "")))
        .replace("{{ACHIEVE_LEVEL}}", html.escape(str(ach.get("current") or "?")))
        .replace("{{ACHIEVE_TARGET}}", html.escape(str(ach.get("target") or "?")))
        .replace("{{NAV}}", nav_html)
        .replace("{{COMPARE}}", html.escape(compare_strip))
        .replace("{{HEADLINE}}", html.escape(str(s.get("headline") or "")))
        .replace("{{OPERATIONAL}}", html.escape(json.dumps(s.get("operational"), indent=2)))
        .replace("{{ACHIEVEMENT}}", html.escape(json.dumps(s.get("achievement"), indent=2)))
    )
    dash = run_root / "dashboard"
    dash.mkdir(parents=True, exist_ok=True)
    index = dash / "index.html"
    index.write_text(out, encoding="utf-8")
    (dash / "data.json").write_text(json.dumps(sc, indent=2) + "\n")
    return index


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--run-dir", type=Path, required=True)
    args = p.parse_args()
    path = render(args.run_dir)
    print(str(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

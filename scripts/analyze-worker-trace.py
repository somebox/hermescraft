#!/usr/bin/env python3
"""Parse per-card worker cognition logs (t_*.log) for mc verb and error counts."""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Hermes terminal lines: "┊ 💻 $         mc move 4 96 24 --raw  5.0s [error]"
_TERM_RE = re.compile(
    r"^\s*┊\s*💻\s*\$\s+(.+?)\s+(\d+(?:\.\d+)?)s(?:\s+\[error\])?\s*$"
)
_MC_IN_FRAGMENT = re.compile(r"\bmc\s+([a-z_][a-z_0-9]*)", re.I)


def _split_shell_commands(cmd: str) -> list[str]:
    parts = [p.strip() for p in cmd.split("&&")]
    return [p for p in parts if p]


def _mc_segments(fragment: str) -> list[tuple[str, str]]:
    """Return (verb, mc_command_substring) for each mc invocation in a shell fragment."""
    out: list[tuple[str, str]] = []
    for m in _MC_IN_FRAGMENT.finditer(fragment):
        verb = m.group(1).lower()
        out.append((verb, fragment[m.start() :].strip()))
    return out


def parse_trace_text(text: str, card_id: str = "") -> dict:
    verbs = Counter()
    errors_by_verb = Counter()
    invocations = 0
    error_invocations = 0
    samples: list[dict] = []
    repeated_targets: Counter[str] = Counter()

    for line in text.splitlines():
        m = _TERM_RE.match(line)
        if not m:
            continue
        cmd, _dur = m.group(1).strip(), m.group(2)
        is_error = "[error]" in line
        for fragment in _split_shell_commands(cmd):
            for verb, mc_cmd in _mc_segments(fragment):
                invocations += 1
                verbs[verb] += 1
                if is_error:
                    errors_by_verb[verb] += 1
                    error_invocations += 1
                    if len(samples) < 40:
                        samples.append({"verb": verb, "cmd": mc_cmd[:200], "error": True})
                repeated_targets[mc_cmd] += 1

    return {
        "card_id": card_id,
        "invocations": invocations,
        "error_invocations": error_invocations,
        "verbs": dict(verbs),
        "errors_by_verb": dict(errors_by_verb),
        "repeated_commands": [
            {"cmd": k, "count": c}
            for k, c in repeated_targets.most_common(20)
            if c >= 3
        ],
        "samples": samples,
    }


def analyze_paths(paths: list[Path]) -> dict:
    per_card = []
    totals_verbs = Counter()
    totals_errors = Counter()
    total_inv = 0
    total_err = 0

    for path in sorted(paths):
        card_id = path.stem
        data = parse_trace_text(path.read_text(encoding="utf-8", errors="replace"), card_id)
        per_card.append(data)
        total_inv += data["invocations"]
        total_err += data["error_invocations"]
        for v, n in data["verbs"].items():
            totals_verbs[v] += n
        for v, n in data["errors_by_verb"].items():
            totals_errors[v] += n

    return {
        "cards": len(per_card),
        "invocations": total_inv,
        "error_invocations": total_err,
        "verbs": dict(totals_verbs),
        "errors_by_verb": dict(totals_errors),
        "per_card": per_card,
    }


def _gather_logs(paths: list[Path]) -> list[Path]:
    out: list[Path] = []
    for p in paths:
        if p.is_dir():
            out.extend(sorted(p.glob("t_*.log")))
        elif p.is_file():
            out.append(p)
    return out


def _compute_delta(current: dict, baseline: dict) -> dict:
    """Side-by-side delta of two `analyze_paths` summaries.

    Phase 9 PR-I: enables postmortem authors to quantify run-to-run change
    without manual log diffing. The current parser counts terminal
    `[error]` markers + verb names (not structured error.code envelopes —
    that's a Phase 10 enrichment). So the delta is verb-level: total
    invocations, errors-by-verb, and the per-verb invocation delta.
    """
    cur_verbs = current.get("verbs", {})
    base_verbs = baseline.get("verbs", {})
    cur_errs = current.get("errors_by_verb", {})
    base_errs = baseline.get("errors_by_verb", {})
    all_verbs = sorted(set(cur_verbs) | set(base_verbs))
    rows = []
    for v in all_verbs:
        ci, bi = cur_verbs.get(v, 0), base_verbs.get(v, 0)
        ce, be = cur_errs.get(v, 0), base_errs.get(v, 0)
        rows.append({
            "verb": v,
            "invocations_current": ci,
            "invocations_baseline": bi,
            "invocations_delta": ci - bi,
            "errors_current": ce,
            "errors_baseline": be,
            "errors_delta": ce - be,
        })
    rows.sort(key=lambda r: -abs(r["invocations_delta"]))
    return {
        "totals": {
            "cards_current": current.get("cards", 0),
            "cards_baseline": baseline.get("cards", 0),
            "invocations_current": current.get("invocations", 0),
            "invocations_baseline": baseline.get("invocations", 0),
            "invocations_delta": current.get("invocations", 0) - baseline.get("invocations", 0),
            "errors_current": current.get("error_invocations", 0),
            "errors_baseline": baseline.get("error_invocations", 0),
            "errors_delta": current.get("error_invocations", 0) - baseline.get("error_invocations", 0),
        },
        "verbs": rows,
    }


def _render_delta_text(delta: dict) -> str:
    t = delta["totals"]
    out = [
        f"cards: {t['cards_current']} vs {t['cards_baseline']} (Δ {t['cards_current'] - t['cards_baseline']:+d})",
        f"invocations: {t['invocations_current']} vs {t['invocations_baseline']} (Δ {t['invocations_delta']:+d})",
        f"errors: {t['errors_current']} vs {t['errors_baseline']} (Δ {t['errors_delta']:+d})",
        "",
        f"{'verb':<20} {'inv_cur':>8} {'inv_base':>9} {'Δinv':>8} {'err_cur':>8} {'err_base':>9} {'Δerr':>8}",
        "─" * 76,
    ]
    for r in delta["verbs"]:
        if r["invocations_current"] == 0 and r["invocations_baseline"] == 0:
            continue
        out.append(
            f"{r['verb']:<20} {r['invocations_current']:>8} {r['invocations_baseline']:>9} "
            f"{r['invocations_delta']:>+8} {r['errors_current']:>8} {r['errors_baseline']:>9} "
            f"{r['errors_delta']:>+8}"
        )
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "paths",
        nargs="*",
        type=Path,
        help="t_*.log files or directories containing them",
    )
    ap.add_argument("--json", action="store_true", help="Print JSON summary")
    ap.add_argument(
        "--compare-with",
        type=Path,
        metavar="BASELINE_DIR",
        help="Phase 9 PR-I: emit a delta vs the baseline log set. Outputs verb-level "
             "invocation+error deltas; tier-2 error.code parsing deferred to Phase 10.",
    )
    args = ap.parse_args()

    log_files = _gather_logs(args.paths)
    if not log_files:
        ap.error("no t_*.log files found")
        return 2

    summary = analyze_paths(log_files)

    if args.compare_with:
        base_files = _gather_logs([args.compare_with])
        if not base_files:
            ap.error(f"no t_*.log files in baseline {args.compare_with}")
            return 2
        baseline = analyze_paths(base_files)
        delta = _compute_delta(summary, baseline)
        if args.json:
            print(json.dumps({"current": summary, "baseline": baseline, "delta": delta}, indent=2))
        else:
            print(_render_delta_text(delta))
        return 0

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"cards={summary['cards']} invocations={summary['invocations']} errors={summary['error_invocations']}")
        for verb, n in sorted(summary["errors_by_verb"].items(), key=lambda x: -x[1]):
            print(f"  {verb}: {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

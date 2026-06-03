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

# Phase 10 PR-V — extract target X Y Z from `mc move ...` invocations.
# Matches "mc move 14 102 8", "mc move 14 102 8 --raw", "mc move 14 102 8 --near 2".
_MOVE_TARGET_RE = re.compile(r"\bmc\s+move\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\b")

# Known residual hazard coords from run-5/6 postmortems (Pattern D + Gatherer
# crash trap). A `mc move` target within DOOR_RADIUS blocks counts as
# door-adjacent. Operator may extend via --hazard-coord CLI repeats.
KNOWN_HAZARD_COORDS = [
    (16, 102, 54),   # oak_door tar-pit (run-5/6 Pattern D, ~16 hits in run-6)
    (13, 101, 62),   # cobble shelter trap (run-6 Gatherer crash loop)
    (34, 99, 62),    # secondary oak_door (run-6, 3 hits)
    (17, 83, 80),    # deep oak_door (run-6, 1 hit)
]
DOOR_RADIUS = 3
STUCK_ON_TARGET_THRESHOLD = 3


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


def parse_move_target(mc_cmd: str) -> tuple[int, int, int] | None:
    """Return (X, Y, Z) parsed from a `mc move ...` shell fragment, or None."""
    m = _MOVE_TARGET_RE.search(mc_cmd)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def _is_door_adjacent(target: tuple[int, int, int], hazards: list[tuple[int, int, int]]) -> tuple[int, int, int] | None:
    """Return the matching hazard coord if the target is within DOOR_RADIUS,
    else None. Manhattan distance (cheap; sufficient for hazard buckets)."""
    tx, ty, tz = target
    for hx, hy, hz in hazards:
        if abs(tx - hx) + abs(ty - hy) + abs(tz - hz) <= DOOR_RADIUS:
            return (hx, hy, hz)
    return None


def analyze_move_errors(text: str, hazards: list[tuple[int, int, int]] | None = None) -> dict:
    """Phase 10 PR-V — split mc move errors by repeated-target and
    door-adjacency. Lets the run-7 postmortem distinguish "the worker
    keeps trying the same wedged coord" from "scattered single-shot
    failures across the map" without manual coord-by-coord triage.

    Note: caller position isn't in the terminal-log format, so the
    distance and vertical-axis buckets from the original plan are
    deferred to a Phase 11 enhancement (would require pairing each
    move with the preceding mc status / mc observe pose).
    """
    hazards = hazards if hazards is not None else KNOWN_HAZARD_COORDS
    total_moves = 0
    error_moves = 0
    targets_seen: Counter[tuple[int, int, int]] = Counter()
    targets_errored: Counter[tuple[int, int, int]] = Counter()
    door_adjacent_errors: list[dict] = []

    for line in text.splitlines():
        m = _TERM_RE.match(line)
        if not m:
            continue
        cmd, _dur = m.group(1).strip(), m.group(2)
        is_error = "[error]" in line
        for fragment in _split_shell_commands(cmd):
            for verb, mc_cmd in _mc_segments(fragment):
                if verb != "move":
                    continue
                target = parse_move_target(mc_cmd)
                if target is None:
                    continue
                total_moves += 1
                targets_seen[target] += 1
                if is_error:
                    error_moves += 1
                    targets_errored[target] += 1
                    near = _is_door_adjacent(target, hazards)
                    if near is not None:
                        door_adjacent_errors.append(
                            {"target": list(target), "near_hazard": list(near)}
                        )

    stuck_on_target = [
        {"target": list(t), "error_count": c}
        for t, c in targets_errored.most_common()
        if c >= STUCK_ON_TARGET_THRESHOLD
    ]

    return {
        "total_move_invocations": total_moves,
        "total_move_errors": error_moves,
        "unique_targets": len(targets_seen),
        "stuck_on_target": stuck_on_target,
        "door_adjacent_error_count": len(door_adjacent_errors),
        "door_adjacent_samples": door_adjacent_errors[:10],
    }


def _render_move_split_text(split: dict, label: str = "") -> str:
    lines = []
    head = f" — {label}" if label else ""
    lines.append(f"mc move split{head}")
    lines.append(
        f"  total: {split['total_move_invocations']} invocations, "
        f"{split['total_move_errors']} errors "
        f"({split['unique_targets']} unique targets)"
    )
    if split["stuck_on_target"]:
        lines.append(f"  stuck-on-target (≥{STUCK_ON_TARGET_THRESHOLD} errors on same coord):")
        for row in split["stuck_on_target"][:10]:
            t = row["target"]
            lines.append(f"    ({t[0]},{t[1]},{t[2]}): {row['error_count']} errors")
    else:
        lines.append("  stuck-on-target: none")
    lines.append(
        f"  door-adjacent errors: {split['door_adjacent_error_count']}"
        f" (within {DOOR_RADIUS} blocks of a known hazard)"
    )
    if split["door_adjacent_samples"]:
        for row in split["door_adjacent_samples"][:5]:
            t = row["target"]
            h = row["near_hazard"]
            lines.append(f"    target=({t[0]},{t[1]},{t[2]})  near=({h[0]},{h[1]},{h[2]})")
    return "\n".join(lines)


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
    ap.add_argument(
        "--split-move",
        action="store_true",
        help="Phase 10 PR-V: bucket mc move:error invocations by repeated-target "
             "(≥3 errors on same coord = stuck) and door-adjacency (within "
             f"{DOOR_RADIUS} blocks of a known hazard). Informs whether #41 "
             "long-range pathfinder issue is one bug or several.",
    )
    ap.add_argument(
        "--hazard-coord",
        action="append",
        default=[],
        metavar="X,Y,Z",
        help="Extend the known-hazard coord list for --split-move (repeatable). "
             "Defaults seeded from run-5/6 postmortem evidence.",
    )
    args = ap.parse_args()

    log_files = _gather_logs(args.paths)
    if not log_files:
        ap.error("no t_*.log files found")
        return 2

    extra_hazards: list[tuple[int, int, int]] = []
    for h in args.hazard_coord:
        try:
            parts = [int(x.strip()) for x in h.split(",")]
            if len(parts) == 3:
                extra_hazards.append(tuple(parts))  # type: ignore[arg-type]
        except ValueError:
            print(f"# WARN: ignoring malformed --hazard-coord {h!r}", file=sys.stderr)
    hazards = KNOWN_HAZARD_COORDS + extra_hazards

    summary = analyze_paths(log_files)

    if args.split_move:
        # Aggregate text across all loaded logs into a single move-split
        # analysis. Per-card splits are available via per_card[i] if the
        # caller wants finer granularity.
        all_text = "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in log_files)
        split = analyze_move_errors(all_text, hazards=hazards)
        if args.json:
            print(json.dumps({"summary": summary, "move_split": split, "hazards": [list(h) for h in hazards]}, indent=2))
        else:
            print(_render_move_split_text(split, label=f"{summary['cards']} cards"))
        return 0

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

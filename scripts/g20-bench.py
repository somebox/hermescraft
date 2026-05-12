#!/usr/bin/env python3
"""g20-bench.py — run G20 N times per model, report pass-rate.

Replaces N=1 sampling (which gave anecdotal results that varied wildly
across the same model) with N runs per model. Each run reuses the
existing scripts/agent-test.py invocation; results parsed from its
output. Total wallclock is roughly N × runs_per_model × ~5min,
mitigated heavily by the early_exit watchdog (~1-3min per pass).

Usage:
  scripts/g20-bench.py --runs 5 z-ai/glm-5.1 deepseek/deepseek-v4-pro
  scripts/g20-bench.py --runs 3 --spec data/agent-tests/G20_survival_night_cycle.yaml MODEL1 MODEL2
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent

# Predicate parsing — agent-test.py prints lines like "  ✓ bot_hp>=8.0 — hp=20"
# and "  ✗ inv_any:..." that we'll match to reconstruct pass/fail.
PASS_LINE = re.compile(r"^\s*✓\s")
FAIL_LINE = re.compile(r"^\s*✗\s")
DEATHS_RE = re.compile(r"deaths:\s*pre=(\d+)\s+post=(\d+)")
FINAL_TIME_RE = re.compile(r"final_bot_time=(\d+)")
HP_RE = re.compile(r"hp=([\d.]+)")
EARLY_EXIT_RE = re.compile(r"early-exit:.*\(PASS\)")


def run_once(model: str, spec_path: Path, run_idx: int, log_dir: Path) -> dict:
    # Per-run log file so the user can tail in real time. Without this,
    # subprocess.run captures stdout into RAM and we have zero visibility
    # while the run is in flight.
    model_safe = model.replace("/", "__")
    log_path = log_dir / f"{model_safe}-r{run_idx}.log"
    cmd = [
        sys.executable,
        str(HERE / "scripts" / "agent-test.py"),
        str(spec_path),
        "--model", model,
    ]
    print(f"\n── run {run_idx}/{model} ──  log: {log_path}")
    start = time.time()
    # Tee stdout+stderr to the log file via shell redirect, then we read
    # it back at the end for parsing. Beats capture_output for visibility.
    with open(log_path, "w") as fh:
        proc = subprocess.run(
            cmd, stdout=fh, stderr=subprocess.STDOUT, text=True, cwd=str(HERE)
        )
    elapsed = time.time() - start
    out = log_path.read_text() if log_path.exists() else ""

    pass_count = sum(1 for line in out.splitlines() if PASS_LINE.search(line))
    fail_count = sum(1 for line in out.splitlines() if FAIL_LINE.search(line))
    death_match = DEATHS_RE.search(out)
    final_time_match = FINAL_TIME_RE.search(out)
    hp_match = HP_RE.search(out)
    early_exit = bool(EARLY_EXIT_RE.search(out))
    # Survival = no deaths AND HP didn't drop below threshold.
    # The earlier "fail_count <= 1" heuristic let runs with 5 deaths
    # squeak through because the `mc_verbs_include_any:craft` predicate
    # quirk consumed the "1 fail allowance". Be strict here — the
    # whole point of G20 is "survive the night without dying".
    survived = "✓ bot_did_not_die" in out
    # death_match captures pre and post; per-run deaths is the delta.
    # The post count is a cumulative Mineflayer-body counter that survives
    # /reset, so absolute values bleed across runs.
    if death_match:
        deaths_pre = int(death_match.group(1))
        deaths_post = int(death_match.group(2))
        deaths = deaths_post - deaths_pre
    else:
        deaths = None

    result = {
        "model": model,
        "elapsed_s": round(elapsed, 1),
        "pass": pass_count,
        "fail": fail_count,
        "deaths": deaths,
        "final_bot_time": int(final_time_match.group(1)) if final_time_match else None,
        "final_hp": float(hp_match.group(1)) if hp_match else None,
        "early_exit": early_exit,
        "survived": survived,
        # Strict: zero deaths AND no more than one non-survival predicate
        # failure (the mc_verbs craft-in-batch quirk).
        "overall": "PASS" if (survived and (deaths or 0) == 0) else "FAIL",
    }
    print(f"  → {result['overall']}  pass={pass_count}/fail={fail_count}  deaths={result['deaths']}  final_t={result['final_bot_time']}  hp={result['final_hp']}  {elapsed:.0f}s{' (early_exit)' if early_exit else ''}")
    return result


def summarize(rows: list[dict]) -> None:
    by_model = {}
    for r in rows:
        by_model.setdefault(r["model"], []).append(r)
    print("\n" + "=" * 78)
    print(f"{'model':<32} {'pass':>4} {'fail':>4} {'mean_t':>7} {'mean_deaths':>11} {'mean_s':>7}")
    print("-" * 78)
    for model, rs in by_model.items():
        n = len(rs)
        passes = sum(1 for r in rs if r["overall"] == "PASS")
        fails = n - passes
        mean_t = sum((r["final_bot_time"] or 0) for r in rs) / n if n else 0
        mean_deaths = sum((r["deaths"] or 0) for r in rs) / n if n else 0
        mean_s = sum(r["elapsed_s"] for r in rs) / n if n else 0
        print(f"{model:<32} {passes:>4}/{n:<2} {fails:>4} {int(mean_t):>7} {mean_deaths:>11.1f} {int(mean_s):>7}")
    print("=" * 78)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument(
        "--runs", "-n", type=int, default=3,
        help="runs per model (default 3)",
    )
    p.add_argument(
        "--spec", type=Path,
        default=Path("data/agent-tests/G20_survival_night_cycle.yaml"),
    )
    p.add_argument(
        "--out", type=Path,
        help="optional JSON output path with per-run details",
    )
    p.add_argument("models", nargs="+", help="one or more model strings")
    args = p.parse_args()

    spec_path = args.spec if args.spec.is_absolute() else (HERE / args.spec)
    if not spec_path.exists():
        print(f"spec not found: {spec_path}")
        return 2

    log_dir = Path("/tmp/g20-bench")
    log_dir.mkdir(parents=True, exist_ok=True)
    print(f"per-run logs → {log_dir} (tail with: tail -F {log_dir}/<model>-r<n>.log)")

    rows = []
    for model in args.models:
        for i in range(1, args.runs + 1):
            r = run_once(model, spec_path, i, log_dir)
            rows.append(r)

    summarize(rows)

    if args.out:
        args.out.write_text(json.dumps(rows, indent=2))
        print(f"  wrote {len(rows)} run records → {args.out}")

    all_pass = all(r["overall"] == "PASS" for r in rows)
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())

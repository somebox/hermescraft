#!/usr/bin/env python3
"""Aggregate per-run metrics from /tmp/clean-*.json.

Reads files matching /tmp/clean-{n,w}<idx>.json and produces:
  - per-run table
  - per-side mean / range table
  - delta (wide vs narrow)

Saved combined dump to /tmp/clean-aggregate.json.
"""
import glob
import json
import statistics
import sys


def load_results() -> dict[str, list[dict]]:
    by_side: dict[str, list[dict]] = {"narrow": [], "wide": []}
    for path in sorted(glob.glob("/tmp/clean-n*.json") + glob.glob("/tmp/clean-w*.json")):
        with open(path) as f:
            r = json.load(f)
        tag = r.get("tag", "")
        if tag.startswith("n"):
            by_side["narrow"].append(r)
        elif tag.startswith("w"):
            by_side["wide"].append(r)
    by_side["narrow"].sort(key=lambda r: r["tag"])
    by_side["wide"].sort(key=lambda r: r["tag"])
    return by_side


def stat(rows: list[dict], key: str) -> str:
    vals = [r.get(key) for r in rows if r.get(key) is not None]
    if not vals:
        return "—"
    mean = statistics.mean(vals)
    return f"{mean:,.0f}  (range [{min(vals):,}..{max(vals):,}])"


def main() -> int:
    sides = load_results()
    if not (sides["narrow"] or sides["wide"]):
        print("no results found at /tmp/clean-n*.json or /tmp/clean-w*.json", file=sys.stderr)
        return 1

    print(f"{'tag':10s} {'profile':18s} {'status':9s} {'dur':>5s} {'calls':>5s} "
          f"{'tok_in':>9s} {'tok_out':>7s} {'turn1':>7s} {'final':>7s}")
    print("-" * 96)
    for side, rows in sides.items():
        for r in rows:
            print(f"{r['tag']:10s} {r['profile']:18s} {r['status']:9s} {r['duration_s']:>4}s "
                  f"{r['api_calls']:>5d} {r['tokens_in']:>9,d} {r['tokens_out']:>7,d} "
                  f"{(r.get('turn1_in') or 0):>7,d} {(r.get('final_in') or 0):>7,d}")
        print()

    if sides["narrow"] and sides["wide"]:
        print("=" * 96)
        print("Per-side aggregates")
        print("=" * 96)
        for side, rows in sides.items():
            print(f"\n{side.upper()} (n={len(rows)}):")
            print(f"  api_calls    : {stat(rows, 'api_calls')}")
            print(f"  tokens_in    : {stat(rows, 'tokens_in')}")
            print(f"  tokens_out   : {stat(rows, 'tokens_out')}")
            print(f"  turn1_in     : {stat(rows, 'turn1_in')}")
            print(f"  final_in     : {stat(rows, 'final_in')}")
            print(f"  duration_s   : {stat(rows, 'duration_s')}")

        # Delta
        print(f"\n{'=' * 96}")
        print("Wide vs Narrow (negative = wide better)")
        print("=" * 96)
        for key in ("api_calls", "tokens_in", "tokens_out", "turn1_in", "duration_s"):
            n_vals = [r.get(key) for r in sides["narrow"] if r.get(key)]
            w_vals = [r.get(key) for r in sides["wide"] if r.get(key)]
            if not (n_vals and w_vals):
                continue
            n_mean = statistics.mean(n_vals)
            w_mean = statistics.mean(w_vals)
            delta_pct = (w_mean - n_mean) / n_mean * 100
            print(f"  {key:13s} narrow={n_mean:>10,.0f}  wide={w_mean:>10,.0f}  Δ {delta_pct:+.1f}%")

    with open("/tmp/clean-aggregate.json", "w") as f:
        json.dump(sides, f, indent=2)
    print("\nsaved /tmp/clean-aggregate.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Time perception-related bot HTTP calls and optional OpenRouter digest.

Samples each endpoint N times (default 5) and prints mean/min/max latency
plus approximate JSON payload size.

Usage:
  # Bot must be up (Tester on config.bot.roles.tester)
  python3 scripts/perception-digest-bench.py
  python3 scripts/perception-digest-bench.py --runs 10
  python3 scripts/perception-digest-bench.py --prep d2 --runs 5
  python3 scripts/perception-digest-bench.py --digest --runs 3
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests._lib.arena import Arena
from tests._lib.bot import BotClient
from tests._lib.config import load_config
from tests._lib.fixture_loader import load_fixture
from tests._lib.openrouter import digest, resolve_openrouter_api_key
from tests._lib.rcon import RconClient

D1 = ROOT / "data/perception-digest/fixtures/D1_mixed_scene.yaml"
D2 = ROOT / "data/perception-digest/fixtures/D2_stuck_pit_wood.yaml"

ENDPOINTS = [
    ("observe_lean", "/observe?lean=true"),
    ("status_full", "/status?lean=false"),
    ("status_preserve", "/status?lean=false&preserve=true"),
    ("scene_24_lean", "/scene?range=24&lean=true"),
    ("nearby_8", "/nearby?radius=8"),
    ("map_12", "/map?radius=12"),
    ("inventory", "/inventory"),
    ("logistics", "/logistics"),
    ("goals", "/goals"),
    ("task", "/task"),
    ("health", "/health"),
]


def _resolve_tester_url(config: dict) -> str:
    roles = (config.get("bot") or {}).get("roles") or {}
    if "tester" in roles:
        return str(roles["tester"]).rstrip("/")
    return config["bot"]["default_api_url"].rstrip("/")


def _timed_get(bot: BotClient, path: str) -> tuple[float, int, bool]:
    t0 = time.perf_counter()
    ok = True
    try:
        data = bot.get(path, timeout=60.0)
        raw = json.dumps(data)
    except Exception as e:
        raw = json.dumps({"error": str(e)})
        ok = False
    elapsed_ms = (time.perf_counter() - t0) * 1000
    return elapsed_ms, len(raw.encode("utf-8")), ok


def _stats(samples: list[float]) -> dict:
    if not samples:
        return {"mean": 0, "min": 0, "max": 0, "stdev": 0}
    return {
        "mean": statistics.mean(samples),
        "min": min(samples),
        "max": max(samples),
        "stdev": statistics.stdev(samples) if len(samples) > 1 else 0.0,
    }


def _prep_scene(config: dict, which: str) -> None:
    fixture_path = D1 if which == "d1" else D2
    fixture = load_fixture(fixture_path)
    rcon = RconClient(config)
    bot = BotClient(config, base_url=_resolve_tester_url(config))
    bot.wait_until_ready(timeout=20)
    arena = Arena(rcon, config)
    world = config["mc"]["world"]
    arena.clean()
    arena.flat_arena((-20, 60, -20, 20, 72, 20), floor="grass_block")
    arena.prep(fixture.prep)
    safe = (0, 63, 0) if which == "d2" else (0, 65, 0)
    yaw = -90 if which == "d2" else 0
    arena.rescue_tester(safe_xyz=safe, bot=bot)
    rcon.run(f"execute in {world} run tp Tester {safe[0]} {safe[1]} {safe[2]} {yaw} 0")
    if which == "d2":
        bot.post("/action/goto", {"x": 5, "y": 64, "z": 0}, timeout=25)
        time.sleep(1.0)
    arena.settle(seconds=2.0)
    print(f"[bench] prepped {which} in {world}", file=sys.stderr)


def _capture_bundle(bot: BotClient) -> dict:
    return {
        "observe": bot.get("/observe?lean=true"),
        "status": bot.get("/status?lean=false&preserve=true"),
        "scene": bot.get("/scene?range=24&lean=true"),
        "nearby": bot.get("/nearby?radius=8"),
        "map": bot.get("/map?radius=12"),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Benchmark perception HTTP + digest latency")
    ap.add_argument("--runs", type=int, default=5, help="samples per HTTP endpoint (default 5)")
    ap.add_argument("--digest-runs", type=int, default=3, help="samples for OpenRouter digest when --digest")
    ap.add_argument("--prep", choices=["d1", "d2"], help="build fixture scene via rcon before timing")
    ap.add_argument("--digest", action="store_true", help="also time full OpenRouter digest on capture bundle")
    ap.add_argument("--intent", default="blocked collecting wood", help="digest intent when --digest")
    args = ap.parse_args()

    config = load_config()
    base = _resolve_tester_url(config)
    bot = BotClient(config, base_url=base)
    print(f"Bot: {base}")
    bot.wait_until_ready(timeout=20)

    if args.prep:
        _prep_scene(config, args.prep)

    runs = max(1, args.runs)
    print(f"\n{'endpoint':<22} {'mean_ms':>9} {'min_ms':>9} {'max_ms':>9} {'stdev':>8} {'bytes':>10} {'ok':>4}")
    print("-" * 78)

    rows = []
    for label, path in ENDPOINTS:
        times: list[float] = []
        sizes: list[int] = []
        oks = 0
        for _ in range(runs):
            ms, nbytes, ok = _timed_get(bot, path)
            times.append(ms)
            sizes.append(nbytes)
            if ok:
                oks += 1
        st = _stats(times)
        avg_bytes = int(statistics.mean(sizes)) if sizes else 0
        print(
            f"{label:<22} {st['mean']:9.1f} {st['min']:9.1f} {st['max']:9.1f} "
            f"{st['stdev']:8.1f} {avg_bytes:10d} {oks}/{runs}"
        )
        rows.append((label, st["mean"], avg_bytes))

    bundle_ms = []
    bundle_bytes = 0
    for _ in range(runs):
        t0 = time.perf_counter()
        bundle = _capture_bundle(bot)
        bundle_ms.append((time.perf_counter() - t0) * 1000)
        bundle_bytes = len(json.dumps(bundle).encode("utf-8"))
    bs = _stats(bundle_ms)
    print("-" * 78)
    print(
        f"{'bundle_sequential':<22} {bs['mean']:9.1f} {bs['min']:9.1f} {bs['max']:9.1f} "
        f"{bs['stdev']:8.1f} {bundle_bytes:10d} 5/5"
    )

    if args.digest:
        if not resolve_openrouter_api_key():
            print("\n[digest] skipped — no OpenRouter API key", file=sys.stderr)
        else:
            d_runs = max(1, args.digest_runs)
            print(f"\n[digest] building bundle once, then {d_runs} digest calls intent={args.intent!r}")
            bundle = _capture_bundle(bot)
            payload_bytes = len(json.dumps(bundle).encode("utf-8"))
            d_times = []
            for i in range(d_runs):
                t0 = time.perf_counter()
                result = digest(bundle, args.intent)
                d_times.append((time.perf_counter() - t0) * 1000)
                ok = result.get("parsed") is not None
                print(f"  run {i + 1}: {d_times[-1]:.0f} ms  parsed={ok}  model={result.get('model')}")
            ds = _stats(d_times)
            print(
                f"{'openrouter_digest':<22} {ds['mean']:9.1f} {ds['min']:9.1f} {ds['max']:9.1f} "
                f"{ds['stdev']:8.1f} {payload_bytes:10d}"
            )

    # Quick totals for steward bundle planning
    http_only = sum(r[1] for r in rows) + bs["mean"]
    print(f"\n[summary] sequential HTTP (all endpoints + bundle): ~{http_only:.0f} ms mean per cycle")
    if args.digest and resolve_openrouter_api_key():
        print("[summary] add ~digest mean above for end-to-end perceive+digest")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

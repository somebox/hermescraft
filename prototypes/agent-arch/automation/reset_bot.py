#!/usr/bin/env python3
"""Reset the live Mineflayer bot to a known baseline between test runs.

Steps:
  1. Confirm bot HTTP is reachable.
  2. Toss every inventory stack via POST /action/toss.
  3. Walk 30 blocks away (out of auto-pickup radius) via POST /action/move.
  4. Walk back to the test start mark.
  5. Verify final state: empty inventory, position close to start, hp/food OK.

Usage:
  python3 reset_bot.py [--port 3002]
                       [--start-x 31 --start-y 64 --start-z -29]
                       [--despawn-dx 30]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.request


def call(base: str, method: str, path: str, body: dict | None = None, timeout: float = 30.0) -> dict:
    url = f"{base}{path}"
    data = None
    headers = {"accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw)


def status(base: str) -> dict:
    return call(base, "GET", "/status?lean=true")["data"]


def inventory(base: str) -> list[dict]:
    d = call(base, "GET", "/inventory").get("data") or {}
    cats = d.get("categories") or {}
    out: list[dict] = []
    for cat in cats.values():
        if isinstance(cat, list):
            out.extend(cat)
    return out


def move_to(base: str, target: dict, max_attempts: int = 25) -> bool:
    for _ in range(max_attempts):
        try:
            r = call(base, "POST", "/action/move", target)
            if (r.get("data") or {}).get("arrived"):
                return True
        except Exception:
            time.sleep(0.5)
    return False


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=3002)
    # Default start is :island_start: — the only marked location the bot can
    # reliably reach right now (it's stranded on a small island after a prior
    # test went off-course). For mainland tests, override with --start-*.
    p.add_argument("--start-x", type=int, default=-29)
    p.add_argument("--start-y", type=int, default=64)
    p.add_argument("--start-z", type=int, default=-28)
    p.add_argument("--despawn-dx", type=int, default=12,
                   help="x-axis offset for the despawn walk (default 12 — small "
                        "island, can't go far)")
    p.add_argument("--min-hp", type=int, default=14)
    p.add_argument("--min-food", type=int, default=14)
    args = p.parse_args()

    base = f"http://127.0.0.1:{args.port}"
    start = {"x": args.start_x, "y": args.start_y, "z": args.start_z}

    def log(msg: str) -> None:
        print(f"[reset_bot] {msg}", flush=True)

    # 0. health
    try:
        st = status(base)
    except Exception as e:
        log(f"ERROR: bot HTTP not reachable on port {args.port} ({e})")
        return 1
    log(f"bot start pos: {st['position']}")

    # 1. toss inventory
    items = inventory(base)
    if items:
        log(f"tossing {len(items)} stack(s): " +
            ", ".join(f"{it.get('name','?')}x{it.get('count','?')}" for it in items))
        for it in items:
            try:
                call(base, "POST", "/action/toss",
                     {"item": it.get("name"), "count": it.get("count", 1)})
            except Exception as e:
                log(f"  warn: failed to toss {it.get('name')}: {e}")
    else:
        log("inventory already empty")

    # 2. walk to despawn site
    despawn = {"x": args.start_x + args.despawn_dx, "y": args.start_y, "z": args.start_z}
    log(f"walking to despawn site {despawn}")
    move_to(base, despawn)
    # Give dropped items a few seconds to despawn from the bot's chunk cache
    time.sleep(2)

    # 3. walk back to start
    log(f"walking back to start {start}")
    move_to(base, start)

    # 4. verify
    st = status(base)
    items_after = inventory(base)
    hp = st.get("health")
    food = st.get("food")
    pos = st["position"]
    dist = math.sqrt((pos["x"] - start["x"]) ** 2 +
                     (pos["y"] - start["y"]) ** 2 +
                     (pos["z"] - start["z"]) ** 2)
    log(f"final: pos=({pos['x']:.1f},{pos['y']:.1f},{pos['z']:.1f}) "
        f"hp={hp} food={food} dist_from_start={dist:.2f} inv_stacks={len(items_after)}")

    problems = []
    if items_after:
        names = ", ".join(f"{it.get('name','?')}x{it.get('count','?')}" for it in items_after)
        problems.append(f"inventory not empty: {names}")
    if hp is not None and hp < args.min_hp:
        problems.append(f"hp too low: {hp} < {args.min_hp}")
    if food is not None and food < args.min_food:
        problems.append(f"food too low: {food} < {args.min_food}")
    if dist > 4:
        problems.append(f"position drifted {dist:.2f} blocks from start")

    if problems:
        for pr in problems:
            log(f"WARN: {pr}")
        return 3
    log("clean.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

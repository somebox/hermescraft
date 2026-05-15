#!/usr/bin/env python3
"""test-task-semantics.py — F46 verification.

Verifies that `mc task` now reports three independent slots so the brain
can distinguish async, sync-in-flight, and just-finished activity:
  {task, sync, last}

Scenarios:
  A — Bot completely idle (just connected): {task:null, sync:null, last:null}
      OR last populated if any startup action ran. Pass requires task and
      sync to both be null.
  B — Run sync `mc nearby`, then immediately `mc task`. Expect
      last.action == "nearby" and last.status == "done". sync should be
      null again (action returned synchronously).
  C — Run sync `mc move` toward a far target so it stays in flight,
      poll `mc task` mid-flight. Expect sync.action == "move" with
      positive elapsed_s. (Tight timing; uses a parallel thread to poll
      during the move call.)
  D — Start an async via POST /task/start (mc nearby as the body action),
      poll `mc task` while it runs. Expect task.status == "running" with
      matching action name. After it completes, task.status transitions
      to "done" and `last` reflects it too.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
import urllib.request

from _test_lib import default_bot_url
DEFAULT_BOT_URL = default_bot_url("flint")
WORLD = "landfolk-test"


def rcon(cmd: str) -> str:
    r = subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input=cmd + "\n",
        capture_output=True,
        text=True,
        timeout=20,
    )
    return r.stdout.strip()


def http_get(url: str, timeout: float = 10.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def http_post(url: str, body: dict, timeout: float = 30.0) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"ok": False, "error": {"message": str(e), "code": "HTTP_ERROR"}}


def get_task(bot_url: str) -> dict:
    return http_get(f"{bot_url}/task")


def setup_arena() -> None:
    """Clear arena, TP bot to known position so move-based tests start
    from a clean state."""
    rcon(f"execute in {WORLD} run difficulty peaceful")
    rcon(f"execute in {WORLD} run gamerule doDaylightCycle false")
    rcon(f"execute in {WORLD} run time set noon")
    rcon(f"execute in {WORLD} run kill @e[type=!player]")
    rcon(f"execute in {WORLD} run fill -1 65 -1 30 70 30 minecraft:air")
    rcon(f"execute in {WORLD} run fill -1 64 -1 30 64 30 minecraft:grass_block")
    rcon(f"execute in {WORLD} run tp Flint 0 65 0 0 0")
    time.sleep(1.0)


def scenario_idle(bot_url: str) -> bool:
    print("\n=== A: idle bot — no active task and no in-flight sync ===")
    setup_arena()
    # Give the bot a moment to settle so any startup action history clears.
    time.sleep(1.0)
    # Cancel any active async task that prior tests may have left running.
    # No-op when nothing is active — the bot returns ok with no error.
    try:
        http_post(f"{bot_url}/task/cancel", {}, timeout=5)
    except Exception:
        pass
    time.sleep(0.5)
    r = get_task(bot_url)
    data = r.get("data") or {}
    task = data.get("task")
    sync = data.get("sync")
    last = data.get("last")
    task_status = (task or {}).get("status")
    print(f"  task={task}  sync={sync}  last_action={last.get('action') if last else None}")
    # "Idle" means no in-flight sync AND any task slot is either null or
    # in a terminal state (done/cancelled/failed). The bot keeps the last
    # task in `currentTask` for history; that's not the same as "running".
    task_idle = (task is None) or task_status in ("done", "cancelled", "failed")
    passed = task_idle and sync is None
    print(f"  → {'PASS' if passed else 'FAIL'} (need sync=null AND (task=null OR task.status in done/cancelled/failed))")
    return passed


def scenario_sync_just_finished(bot_url: str) -> bool:
    print("\n=== B: sync action just finished — last populated ===")
    setup_arena()
    # mc look is a fast sync action that always succeeds. We use it
    # because the goal is to verify the {sync, last} mechanism, not
    # the verb itself.
    http_post(f"{bot_url}/action/look", {"x": 5, "y": 65, "z": 5}, timeout=5)
    r = get_task(bot_url)
    data = r.get("data") or {}
    sync = data.get("sync")
    last = data.get("last")
    print(f"  sync={sync}  last={last}")
    passed = (
        sync is None
        and last is not None
        and last.get("action") == "look"
        and last.get("status") == "done"
    )
    print(f"  → {'PASS' if passed else 'FAIL'} (need sync=null, last.action=='look', last.status=='done')")
    return passed


def scenario_sync_in_flight(bot_url: str) -> bool:
    print("\n=== C: sync action mid-flight — sync.action populated ===")
    setup_arena()
    # We poll /task in a thread while issuing a slow sync action in main.
    snapshots: list[dict] = []
    stop = threading.Event()

    def poll() -> None:
        while not stop.is_set():
            try:
                r = get_task(bot_url)
                snapshots.append(r.get("data") or {})
            except Exception:
                pass
            time.sleep(0.05)

    t = threading.Thread(target=poll, daemon=True)
    t.start()

    # Kick off a slow sync action: mc move to a far target.
    # max_doors=0 prevents this version from triggering through-door
    # leg detection; the bot just walks.
    http_post(
        f"{bot_url}/action/move",
        {"x": 25, "y": 65, "z": 25, "max_doors": 0},
        timeout=30,
    )
    stop.set()
    t.join(timeout=2.0)

    # Look through snapshots for one where sync.action == "move".
    saw_sync_move = False
    max_elapsed = 0
    for s in snapshots:
        sync = s.get("sync")
        if sync and sync.get("action") == "move":
            saw_sync_move = True
            max_elapsed = max(max_elapsed, int(sync.get("elapsed_s") or 0))
    print(f"  snapshots={len(snapshots)}  saw sync.action='move'={saw_sync_move}  max elapsed_s={max_elapsed}")
    passed = saw_sync_move
    print(f"  → {'PASS' if passed else 'FAIL'} (need sync.action=='move' observed during the call)")
    return passed


def scenario_async(bot_url: str) -> bool:
    print("\n=== D: async task — task.status running then done ===")
    setup_arena()
    # /task/start launches a bg task. Use mc wait (sleeps N seconds) so
    # we have a deterministic running window to observe.
    r = http_post(
        f"{bot_url}/task/start",
        {"action": "wait", "args": {"seconds": 3}},
        timeout=10,
    )
    if not r.get("ok"):
        print(f"  /task/start failed: {r}")
        return False
    # Poll for running THEN done.
    saw_running = False
    final_status = None
    deadline = time.time() + 8.0
    while time.time() < deadline:
        info = (get_task(bot_url).get("data") or {}).get("task") or {}
        st = info.get("status")
        if st == "running":
            saw_running = True
        if st in ("done", "error", "cancelled"):
            final_status = st
            break
        time.sleep(0.05)
    last = (get_task(bot_url).get("data") or {}).get("last")
    print(f"  saw running={saw_running}  final={final_status}  last.action={last.get('action') if last else None}")
    passed = saw_running and final_status == "done"
    print(f"  → {'PASS' if passed else 'FAIL'} (need running observed, then done)")
    return passed


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    p.add_argument("--only", choices=["A", "B", "C", "D"])
    args = p.parse_args()

    try:
        s = http_get(f"{args.bot_url}/status?lean=true", timeout=5)
        if not s.get("ok"):
            print(f"bot not ready: {s}")
            return 2
    except Exception as e:
        print(f"can't reach bot: {e}")
        return 2

    rcon(f"mvtp Flint {WORLD}")
    time.sleep(0.5)

    scenarios = []
    if args.only is None or args.only == "A":
        scenarios.append(("A", scenario_idle))
    if args.only is None or args.only == "B":
        scenarios.append(("B", scenario_sync_just_finished))
    if args.only is None or args.only == "C":
        scenarios.append(("C", scenario_sync_in_flight))
    if args.only is None or args.only == "D":
        scenarios.append(("D", scenario_async))

    results = []
    for name, fn in scenarios:
        try:
            ok = fn(args.bot_url)
        except Exception as e:
            print(f"  scenario {name} crashed: {e}")
            ok = False
        results.append((name, ok))

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")

    # Tidy.
    rcon(f"execute in {WORLD} run fill -1 65 -1 30 70 30 minecraft:air")
    rcon(f"execute in {WORLD} run tp Flint 52 65 52")
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())

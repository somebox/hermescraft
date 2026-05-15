#!/usr/bin/env python3
"""F74: pathfinder failure responses surface walkable_to_target + next_hop_suggestion.

Companion to F73 (which adds the same fields on SUCCESSFUL goto_near).
When the pathfinder gives up (NAV_BLOCKED, no path) or stalls
(NAV_NO_PROGRESS, watchdog), the error now includes a BFS
reachability hint so the brain can route around the obstacle instead
of looping `mc escape` / `mc dig`.

Scenario:
  A — bot fully penned by an obsidian box; target outside.
      Pathfinder cannot find any path. Error code is NAV_BLOCKED or
      NAV_NO_PROGRESS. Either way, observed_state must include
      walkable_to_target=false and next_hop_suggestion.
"""
import json, subprocess, time, urllib.request, sys

WORLD = "landfolk-test"
from _test_lib import default_bot_url
URL = default_bot_url("flint")
def rcon(cmds):
    subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input="\n".join(cmds) + "\n", capture_output=True, text=True, timeout=60,
    )


def post(path, body):
    req = urllib.request.Request(f"{URL}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


print("=== A: bot boxed in, target across wall — expect NAV_NO_PROGRESS w/ next_hop ===")
# Build the arena BEFORE teleporting the bot in. If the bot is cross-dim
# from a previous test, the first tp lands in the target dim but the
# floor might not exist yet — leaving the bot mid-void at y=54.
rcon([
    f"execute in {WORLD} run forceload add -16 -16 16 16",
    f"execute in {WORLD} run difficulty peaceful",
    f"execute in {WORLD} run gamerule keepInventory true",
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:grass_block",
    # Pen: 5x5 obsidian box around (0,65,0), y=65..68 (4 tall, no jump
    # out). Inner 3x3 cell open. Target outside the pen so pathfinder
    # has nowhere to go.
    f"execute in {WORLD} run fill -2 65 -2 2 68 2 minecraft:obsidian",
    f"execute in {WORLD} run fill -1 65 -1 1 68 1 minecraft:air",
    f"execute in {WORLD} run clear Flint",
    f"execute as Flint at @s in {WORLD} run tp @s 0.5 65 0.5 0 0",
])
time.sleep(3)

r = post("/action/goto_near", {"x": 5, "y": 65, "z": 5, "range": 1})
ok = r.get("ok")
err = r.get("error") or {}
code = err.get("code")
obs = err.get("observed_state") or {}
walkable = obs.get("walkable_to_target")
hop = obs.get("next_hop_suggestion")
print(f"  ok={ok}  code={code}")
print(f"  observed_state: walkable_to_target={walkable}  next_hop_suggestion={hop}")
print(f"  message: {err.get('message','')[:240]}")
a_pass = (not ok) and code in {"NAV_BLOCKED", "NAV_NO_PROGRESS"} and walkable is False and (hop is not None)
print(f"  -> {'PASS' if a_pass else 'FAIL'}")

rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run forceload remove all",
])
print(f"\n=== Summary: A={'PASS' if a_pass else 'FAIL'} ===")
sys.exit(0 if a_pass else 1)

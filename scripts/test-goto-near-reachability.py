#!/usr/bin/env python3
"""F73: mc goto_near surfaces walkable_to_target + next_hop_suggestion.

When pathfinder's GoalNear lands the bot at a cell within `range`
euclidean distance but on the WRONG side of a wall, the response now
includes `walkable_to_target: false` and a `next_hop_suggestion` cell
that the bot CAN reach which is adjacent to (or close to) the target.

Scenarios:
  A — bot south of a wall, target north of the wall, ~2 blocks away.
      With range=2, GoalNear succeeds but bot can't reach target via
      walkable cells. Expect: walkable_to_target=false +
      next_hop_suggestion present.
  B — bot in open arena, target reachable. Expect:
      walkable_to_target=true, no next_hop_suggestion.
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
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


print("=== A: target on wrong side of a wall — expect walkable_to_target=false ===")
rcon([
    f"execute in {WORLD} run forceload add -16 -16 16 16",
    f"execute in {WORLD} run difficulty peaceful",
    f"execute in {WORLD} run gamerule keepInventory true",
    f"execute as Flint at @s in {WORLD} run tp @s 0 65 0",
])
time.sleep(2)
rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:grass_block",
    # Wall from (-3, 1) to (3, 1) at y=65..66, blocks z=0 (south) from z=2 (north of wall).
    f"execute in {WORLD} run fill -3 65 1 3 66 1 minecraft:obsidian",
    f"execute in {WORLD} run clear Flint",
    f"execute in {WORLD} run tp Flint 0 65 -1 0 0",
])
time.sleep(2)
# Bot is at z=-1 (north of wall at z=1). Target at (0, 65, 2) — south of wall.
# With range=2, bot can "arrive near" at z=0 (still north of wall) → can't reach target.
r = post("/action/goto_near", {"x": 0, "y": 65, "z": 2, "range": 2})
print(f"  ok={r.get('ok')}  result={str(r.get('result',''))[:200]}")
obs = r.get("observed_state") or r.get("data", {}).get("observed_state") or {}
walkable = obs.get("walkable_to_target")
hop = obs.get("next_hop_suggestion")
print(f"  observed_state: walkable_to_target={walkable}  next_hop_suggestion={hop}")
a_pass = (walkable is False) and (hop is not None)
print(f"  -> {'PASS' if a_pass else 'FAIL'}")

print("\n=== B: open arena, target directly reachable — expect walkable_to_target=true ===")
rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:grass_block",
    f"execute in {WORLD} run clear Flint",
    f"execute in {WORLD} run tp Flint 0 65 0 0 0",
])
time.sleep(2)
r = post("/action/goto_near", {"x": 5, "y": 65, "z": 5, "range": 1})
obs = r.get("observed_state") or r.get("data", {}).get("observed_state") or {}
walkable = obs.get("walkable_to_target")
hop = obs.get("next_hop_suggestion")
print(f"  ok={r.get('ok')}  walkable_to_target={walkable}  next_hop_suggestion={hop}")
b_pass = (walkable is True) and (hop is None)
print(f"  -> {'PASS' if b_pass else 'FAIL'}")

rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run forceload remove all",
])
print(f"\n=== Summary: A={'PASS' if a_pass else 'FAIL'}  B={'PASS' if b_pass else 'FAIL'} ===")
sys.exit(0 if (a_pass and b_pass) else 1)

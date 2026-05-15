#!/usr/bin/env python3
"""F71: mc goto_near must land at an LOS-valid cell when target is solid.

Setup mirrors the M3 M1 failure: bot enters maze at south, target andesite
is at (-2, 65, 2), and a cobble wall at (-2, 65, 1) sits between two
candidate landings ((-2, 65, 0) blocked, (-2, 65, 2)'s eastern/western
neighbors clear). Without F71, GoalNear lands at the southern (blocked)
side and the follow-up dig trips F67 NO_LINE_OF_SIGHT.
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


def get(path):
    with urllib.request.urlopen(f"{URL}{path}", timeout=10) as r:
        return json.loads(r.read().decode())


def post(path, body):
    req = urllib.request.Request(f"{URL}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


# Setup: clear arena, place floor, place andesite target with a cobble
# wall on the south face, leave the north face clear.
print("=== Setup: andesite at (-2,65,2), south wall at (-2,65,1) ===")
rcon([
    f"execute in {WORLD} run forceload add -16 -16 16 16",
    f"execute in {WORLD} run difficulty peaceful",
    f"execute in {WORLD} run gamerule keepInventory true",
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:grass_block",
    f"execute in {WORLD} run setblock -2 65 2 minecraft:andesite",
    # South-side wall — blocks LOS from any cell at z=0 or z=1 looking north.
    f"execute in {WORLD} run setblock -2 65 1 minecraft:cobblestone",
    f"execute in {WORLD} run setblock -2 66 1 minecraft:cobblestone",
    f"execute in {WORLD} run clear Flint",
    f"execute in {WORLD} run give Flint minecraft:stone_pickaxe 1",
    f"execute in {WORLD} run effect give Flint minecraft:instant_health 1 5",
    # Drop bot at the same (s=south) side of the target.
    f"execute in {WORLD} run tp Flint -2 65 -2 0 0",
])
time.sleep(2.5)

# A: F71 ON (default) — bot must land at an LOS-valid cell and dig succeeds.
print("\n=== A: goto_near -2 65 2 range=3 (los=auto, default ON) ===")
r = post("/action/goto_near", {"x": -2, "y": 65, "z": 2, "range": 3})
print(f"  goto_near ok={r.get('ok')}  result={str(r.get('result',''))[:120]}")
pos = get("/status?lean=true")["data"]["position"]
print(f"  landing pos={pos}")
dig = post("/action/dig", {"x": -2, "y": 65, "z": 2})
ok = dig.get("ok")
code = dig.get("error", {}).get("code") if not ok else None
print(f"  dig ok={ok}  code={code}")
a_pass = bool(ok)
print(f"  -> {'PASS' if a_pass else 'FAIL'}")

# Reset for B
rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:grass_block",
    f"execute in {WORLD} run setblock -2 65 2 minecraft:andesite",
    f"execute in {WORLD} run setblock -2 65 1 minecraft:cobblestone",
    f"execute in {WORLD} run setblock -2 66 1 minecraft:cobblestone",
    f"execute in {WORLD} run clear Flint",
    f"execute in {WORLD} run give Flint minecraft:stone_pickaxe 1",
    f"execute in {WORLD} run tp Flint -2 65 -2 0 0",
])
time.sleep(2.5)

# B: F71 OFF — confirm regression (without the guard, lands at blocked side).
print("\n=== B: goto_near -2 65 2 range=3 los=false (regression check) ===")
r = post("/action/goto_near", {"x": -2, "y": 65, "z": 2, "range": 3, "los": False})
print(f"  goto_near ok={r.get('ok')}  result={str(r.get('result',''))[:120]}")
pos = get("/status?lean=true")["data"]["position"]
print(f"  landing pos={pos}")
dig = post("/action/dig", {"x": -2, "y": 65, "z": 2})
ok = dig.get("ok")
code = dig.get("error", {}).get("code") if not ok else None
print(f"  dig ok={ok}  code={code}")
# Note: bot might still succeed via a lucky landing — we only require that
# F71 doesn't regress legitimate landings, not that legacy fails.
print(f"  -> info only (no assertion)")

rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run forceload remove all",
])
print(f"\n=== Summary: A={'PASS' if a_pass else 'FAIL'} ===")
sys.exit(0 if a_pass else 1)

#!/usr/bin/env python3
"""F68: mc through must refuse opening gates behind walls."""
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

# A: gate behind a wall (LOS blocked but euclidean reach passes)
print("=== A: gate behind wall — should fail with NO_LINE_OF_SIGHT ===")
rcon([
    f"execute in {WORLD} run forceload add -16 -16 16 16",
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:stone",
    # 2-block-thick obsidian wall at x=1..2, blocks LOS to gate at x=3.
    f"execute in {WORLD} run fill 1 65 -1 2 66 1 minecraft:obsidian",
    # Gate at (3, 65, 0), facing east, closed.
    f"execute in {WORLD} run setblock 3 65 0 minecraft:oak_fence_gate[facing=east,open=false,in_wall=false]",
    f"execute in {WORLD} run clear Flint",
    f"execute in {WORLD} run tp Flint 0 65 0 90 0",
])
time.sleep(2)
r = post("/action/through", {"gx": 3, "gy": 65, "gz": 0, "dx": 5, "dy": 65, "dz": 0})
ok = r.get("ok")
code = r.get("error", {}).get("code") if not ok else None
print(f"  ok={ok}  code={code}")
a_pass = (not ok) and code == "NO_LINE_OF_SIGHT"
print(f"  -> {'PASS' if a_pass else 'FAIL'}")

# B: gate in clear view (LOS open) — should succeed
print("\n=== B: gate in open view — should succeed ===")
rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:stone",
    f"execute in {WORLD} run setblock 3 65 0 minecraft:oak_fence_gate[facing=east,open=false,in_wall=false]",
    f"execute in {WORLD} run clear Flint",
    f"execute in {WORLD} run tp Flint 0 65 0 90 0",
])
time.sleep(2)
r = post("/action/through", {"gx": 3, "gy": 65, "gz": 0, "dx": 5, "dy": 65, "dz": 0})
ok = r.get("ok")
print(f"  ok={ok}")
b_pass = bool(ok)
print(f"  -> {'PASS' if b_pass else 'FAIL'}")

rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run forceload remove all",
])
print(f"\n=== Summary: A={'PASS' if a_pass else 'FAIL'}  B={'PASS' if b_pass else 'FAIL'} ===")
sys.exit(0 if (a_pass and b_pass) else 1)

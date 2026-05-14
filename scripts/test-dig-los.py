#!/usr/bin/env python3
"""F67: mc dig must refuse through-walls mining."""
import json, subprocess, time, urllib.request, sys

WORLD = "landfolk-test"
URL = "http://localhost:3002"

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

# A: target diorite behind a wall (LOS blocked)
print("=== A: target behind wall — should fail with NO_LINE_OF_SIGHT ===")
rcon([
    f"execute in {WORLD} run forceload add -16 -16 16 16",
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:stone",
    f"execute in {WORLD} run setblock 2 65 0 minecraft:diorite",
    f"execute in {WORLD} run setblock 1 65 0 minecraft:obsidian",
    f"execute in {WORLD} run setblock 1 66 0 minecraft:obsidian",
    f"execute in {WORLD} run clear Flint",
    f"execute in {WORLD} run give Flint minecraft:stone_pickaxe 1",
    f"execute in {WORLD} run tp Flint 0 65 0 90 0",
])
time.sleep(2)
r = post("/action/dig", {"x": 2, "y": 65, "z": 0})
ok = r.get("ok")
code = r.get("error", {}).get("code") if not ok else None
print(f"  ok={ok}  code={code}")
a_pass = (not ok) and code == "NO_LINE_OF_SIGHT"
print(f"  → {'PASS' if a_pass else 'FAIL'}")

# B: target in clear view (LOS open)
print("\n=== B: target in open view — should succeed ===")
rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:stone",
    f"execute in {WORLD} run setblock 2 65 0 minecraft:diorite",
    f"execute in {WORLD} run clear Flint",
    f"execute in {WORLD} run give Flint minecraft:stone_pickaxe 1",
    f"execute in {WORLD} run tp Flint 0 65 0 90 0",
])
time.sleep(2)
r = post("/action/dig", {"x": 2, "y": 65, "z": 0})
ok = r.get("ok")
print(f"  ok={ok}")
b_pass = bool(ok)
print(f"  → {'PASS' if b_pass else 'FAIL'}")

rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run forceload remove all",
])
print(f"\n=== Summary: A={'PASS' if a_pass else 'FAIL'}  B={'PASS' if b_pass else 'FAIL'} ===")
sys.exit(0 if (a_pass and b_pass) else 1)

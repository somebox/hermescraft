#!/usr/bin/env python3
"""Simplest possible test: open door in flat arena, bot walks past it."""
import json, subprocess, time, urllib.request

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
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())

# Setup
rcon([
    f"execute in {WORLD} run forceload add -16 -16 16 16",
    f"execute in {WORLD} run fill -15 60 -15 15 80 15 minecraft:air",
    f"execute in {WORLD} run fill -15 64 -15 15 64 15 minecraft:stone",
    # Single PRE-OPEN door at (0, 65, 0), no walls around it
    f"execute in {WORLD} run setblock 0 65 0 minecraft:oak_door[half=lower,facing=east,open=true,hinge=left]",
    f"execute in {WORLD} run setblock 0 66 0 minecraft:oak_door[half=upper,facing=east,open=true,hinge=left]",
    f"execute in {WORLD} run tp Flint -3 65 0 90 0",
])
time.sleep(2.0)

# Verify door is open
chk = subprocess.run(
    ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
    input=f"execute in {WORLD} if block 0 65 0 oak_door[open=true]\n",
    capture_output=True, text=True, timeout=10).stdout
print(f"door open at start: {'YES' if 'Test passed' in chk else 'NO'}")

t0 = time.time()
r = post("/action/goto_near", {"x": 3, "y": 65, "z": 0, "range": 1})
elapsed = time.time() - t0
pos = get("/status?lean=true")["data"]["position"]
print(f"elapsed={elapsed:.1f}s  ok={r.get('ok')}  pos={pos}")
print(f"result: {str(r.get('result', r.get('error')))[:200]}")

rcon([
    f"execute in {WORLD} run fill -15 60 -15 15 80 15 minecraft:air",
    f"execute in {WORLD} run forceload remove all",
])

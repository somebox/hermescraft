#!/usr/bin/env python3
"""F72: mc collect <item> N short-circuits when the bot just auto-picked
up the item from a recent mc dig.

The bug this fixes: after `mc dig X Y Z` the dropped item often
auto-magnets into inventory immediately (mineflayer's 1.5-block
pickup radius covers the dig target). A follow-up `mc collect <item> 1`
then returned NO_VISIBLE_BLOCKS because there were no drops left on
the ground, even though the bot had the item. Weak-model brains
misread this as "dig failed" and went into recovery loops, sometimes
digging maze walls.

Scenarios:
  A — dig + collect: dig an andesite, immediately collect andesite 1.
      Expect: ok=true with source="recent_pickup".
  B — collect with no recent dig: dig nothing, just call mc collect.
      Expect: normal NO_VISIBLE_BLOCKS path (or scout path) since
      recentPickups is empty.
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


def get(path):
    with urllib.request.urlopen(f"{URL}{path}", timeout=10) as r:
        return json.loads(r.read().decode())


print("=== A: dig andesite, then collect — short-circuit via recent pickup ===")
# Bot may be in another dimension from a previous test — cross-dim tp
# requires `execute as <player> in <world> run tp @s` because the
# selector resolves in the EXECUTOR's dim, not the bot's.
rcon([
    f"execute in {WORLD} run forceload add -16 -16 16 16",
    f"execute in {WORLD} run difficulty peaceful",
    f"execute in {WORLD} run gamerule keepInventory true",
    f"execute as Flint at @s in {WORLD} run tp @s 0 65 0",
])
time.sleep(2.5)
rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:grass_block",
    f"execute in {WORLD} run setblock -2 65 2 minecraft:andesite",
    f"execute in {WORLD} run clear Flint",
    f"execute in {WORLD} run give Flint minecraft:stone_pickaxe 1",
    f"execute in {WORLD} run effect give Flint minecraft:instant_health 1 5",
    f"execute in {WORLD} run tp Flint -2 65 1 0 0",
])
time.sleep(2.5)

# Walk a tiny step so the bot is centered above the floor cell adjacent
# to the andesite — keeps the dig-target drop reliably within pickup range.
post("/action/goto_near", {"x": -2, "y": 65, "z": 2, "range": 1})
time.sleep(1.0)

dig = post("/action/dig", {"x": -2, "y": 65, "z": 2})
print(f"  dig ok={dig.get('ok')} dropped={dig.get('data', {}).get('dropped_items')}")

# Auto-magnet has variable timing — the drop is within range but the
# physics tick may not have fired by the time we read inventory. Poll
# briefly, falling back to an explicit pickup verb if the magnet hasn't
# caught up. Either path populates the recentPickups cache that
# F72's mc-collect short-circuit reads from.
def andesite_in_inv() -> int:
    inv = get("/status?lean=true")["data"].get("inventory", [])
    return next((i["count"] for i in inv if i["name"] == "andesite"), 0)

deadline = time.time() + 2.0
andesite_count = 0
while time.time() < deadline:
    andesite_count = andesite_in_inv()
    if andesite_count > 0:
        break
    time.sleep(0.2)
if andesite_count == 0:
    post("/action/pickup", {})
    time.sleep(0.5)
    andesite_count = andesite_in_inv()
print(f"  inventory andesite count after dig: {andesite_count}")

c = post("/action/collect", {"block": "andesite", "count": 1})
ok = c.get("ok")
source = c.get("data", {}).get("source")
print(f"  collect ok={ok}  source={source}")
print(f"  result: {str(c.get('result', c.get('error')))[:200]}")
a_pass = bool(ok) and source == "recent_pickup"
print(f"  -> {'PASS' if a_pass else 'FAIL'}")

print("\n=== B: collect with no recent dig — normal path (or NO_VISIBLE_BLOCKS) ===")
rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:grass_block",
    f"execute in {WORLD} run clear Flint",
    f"execute in {WORLD} run give Flint minecraft:stone_pickaxe 1",
    f"execute in {WORLD} run tp Flint 0 65 0 0 0",
])
time.sleep(2)

c = post("/action/collect", {"block": "diamond_ore", "count": 1})
ok = c.get("ok")
source = c.get("data", {}).get("source") if ok else None
print(f"  collect diamond_ore ok={ok}  source={source}")
# Should NOT shortcut via recent_pickup — bot has no recent diamond_ore dig.
b_pass = (not ok) or (source != "recent_pickup")
print(f"  -> {'PASS' if b_pass else 'FAIL'}")

rcon([
    f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
    f"execute in {WORLD} run forceload remove all",
])
print(f"\n=== Summary: A={'PASS' if a_pass else 'FAIL'}  B={'PASS' if b_pass else 'FAIL'} ===")
sys.exit(0 if (a_pass and b_pass) else 1)

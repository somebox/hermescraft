#!/usr/bin/env python3
"""test-dig-walk-pickup-chain.py — pathfind-around-pillar regression.

The 3x3 pillar grid from test-mine-collect-grid.py is a useful substrate,
but `mc collect`'s internal optimised loop never forces the bot into the
specific failure mode we care about: **standing close to a pillar, with
a drop on the far side, having to walk AROUND the obstacle**.

This test uses the explicit primitives (`mc dig`, `mc goto_near`,
`mc pickup`) one block at a time. Per iteration:

  1. TP bot adjacent to a target pillar with clear LOS.
  2. `mc dig` the target — drop lands at the pillar's foot cell.
  3. TP bot to the opposite side of the grid, with **another standing
     pillar between bot and drop**. e.g. mining (6,65,6), then teleport
     to (6,65,2) — pillar (6,65,4) sits in the path.
  4. `mc goto_near drop` — bot must pathfind AROUND the obstacle.
  5. `mc pickup` — collect the dropped item.
  6. Assert cobble count incremented.

Scenarios:
  A — height=1 (single-block pillars). 3 representative pillars. Bot
      tp'd to the OPPOSITE end of the row — clean detour around one
      middle pillar.
  B — height=2 (2-block stacks). Same 3 pillars, mining top-down so
      gravity doesn't crush the drop. 6 dig+walk+pickup ops total.
  C — sandwich detour. Bot tp'd to a cell PINNED between two pillars
      cardinally (N+S or E+W blocked), with the drop on the far side
      of one of those pillars. Forces pathfinder to detour around a
      corner.
  D — corner pinch. Bot tp'd to a cell with two perpendicular cardinal
      pillars, drop on the diagonal far side. Forces a 90-degree turn
      around the corner of the pillar that sits between bot and drop.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request

DEFAULT_BOT_URL = "http://localhost:3001"
WORLD = "landfolk-test"

# Pillars chosen so each has a same-row pillar that can serve as the
# obstacle when bot is teleported to the opposite side.
#
# target (x, z) → (adjacent_x, adjacent_z) for clean mining-LOS approach,
#                 (opposite_x, opposite_z) for the obstacle-side stand
TEST_PILLARS = [
    # Back-right: mine from x=7 (east of grid), obstacle = pillar (6,4)
    {"target": (6, 6), "approach": (7, 6), "opposite": (6, 2)},
    # Back-left: mine from x=1 (west of grid), obstacle = pillar (2,4)
    {"target": (2, 6), "approach": (1, 6), "opposite": (2, 2)},
    # Front-center: mine from x=4, z=1 (south of grid), obstacle = pillar (4,4)
    {"target": (4, 2), "approach": (4, 1), "opposite": (4, 6)},
]


# ── rcon helpers ──────────────────────────────────────────────────────

def rcon(cmd: str) -> str:
    r = subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input=cmd + "\n",
        capture_output=True,
        text=True,
        timeout=20,
    )
    return r.stdout.strip()


def rcon_batch(cmds: list[str]) -> str:
    if not cmds:
        return ""
    r = subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input="\n".join(cmds) + "\n",
        capture_output=True,
        text=True,
        timeout=60,
    )
    return r.stdout


# ── HTTP helpers ─────────────────────────────────────────────────────

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


def cobble_count(bot_url: str) -> int:
    s = http_get(f"{bot_url}/status?lean=true")
    inv = (s.get("data") or {}).get("inventory") or []
    for it in inv:
        if it.get("name") == "cobblestone":
            return int(it.get("count") or 0)
    return 0


def bot_pos(bot_url: str) -> dict | None:
    try:
        s = http_get(f"{bot_url}/status?lean=true")
        return (s.get("data") or {}).get("position")
    except Exception:
        return None


# ── World setup ──────────────────────────────────────────────────────

def setup_grid(height: int) -> None:
    """Place the 3×3 cobble pillar grid (height blocks tall) and clear
    a flat staging area around it. Bot gets a stone pickaxe and full
    saturation so its inventory state is predictable."""
    cmds = [
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run time set noon",
        f"execute in {WORLD} run fill -1 65 -1 9 70 9 minecraft:air",
        f"execute in {WORLD} run fill -1 64 -1 9 64 9 minecraft:grass_block",
    ]
    for x in (2, 4, 6):
        for z in (2, 4, 6):
            for dy in range(height):
                cmds.append(
                    f"execute in {WORLD} run setblock {x} {65 + dy} {z} minecraft:cobblestone"
                )
    cmds.append("clear Flint")
    cmds.append(f"execute in {WORLD} run give Flint minecraft:stone_pickaxe")
    cmds.append("effect clear Flint")
    cmds.append("effect give Flint minecraft:saturation 600 1")
    rcon_batch(cmds)
    time.sleep(2.0)


def tp_bot(x: float, y: float, z: float, yaw: float = 0.0) -> None:
    rcon(f"execute in {WORLD} run tp Flint {x} {y} {z} {yaw} 0")
    time.sleep(0.5)


# ── One iteration of the dig→walk→pickup chain ───────────────────────

def dig_walk_pickup_iteration(
    bot_url: str,
    target_x: int,
    target_y: int,
    target_z: int,
    approach_x: int,
    approach_z: int,
    opposite_x: int,
    opposite_z: int,
    label: str,
) -> tuple[bool, str]:
    """Returns (ok, reason). ok=True iff bot mined the block, walked
    around the obstacle, and picked up the drop."""
    pre_cobble = cobble_count(bot_url)

    # 1. TP bot adjacent to the pillar with clear LOS.
    # Yaw 0 = south (+z); rotate so bot faces the target.
    dx = target_x - approach_x
    dz = target_z - approach_z
    if abs(dx) > abs(dz):
        yaw = 270 if dx > 0 else 90  # east / west
    else:
        yaw = 0 if dz > 0 else 180   # south / north
    tp_bot(approach_x + 0.5, 65, approach_z + 0.5, yaw)

    # 2. mc dig the target block.
    r = http_post(
        f"{bot_url}/action/dig",
        {"x": target_x, "y": target_y, "z": target_z},
        timeout=15,
    )
    if not r.get("ok"):
        err = r.get("error") or {}
        err_msg = err.get("message") if isinstance(err, dict) else str(err)
        return (False, f"dig failed: {str(err_msg)[:120]}")

    # 3. TP to the opposite side so a STANDING pillar is between bot and drop.
    tp_bot(opposite_x + 0.5, 65, opposite_z + 0.5, 0.0)

    # 4. goto_near drop coord — pathfinder MUST route around the obstacle.
    t0 = time.time()
    r = http_post(
        f"{bot_url}/action/goto_near",
        {"x": target_x, "y": target_y, "z": target_z, "range": 1},
        timeout=20,
    )
    nav_elapsed = time.time() - t0
    if not r.get("ok"):
        err = r.get("error") or {}
        code = err.get("code") if isinstance(err, dict) else ""
        msg = err.get("message") if isinstance(err, dict) else str(err)
        return (False, f"goto_near failed: code={code} elapsed={nav_elapsed:.1f}s msg={str(msg)[:100]}")

    final_pos = bot_pos(bot_url) or {}
    # 5. pickup the drop.
    r = http_post(f"{bot_url}/action/pickup", {}, timeout=10)
    if not r.get("ok"):
        # pickup with no drops nearby may return "no items" — only fail if
        # the cobble count didn't go up.
        pass

    post_cobble = cobble_count(bot_url)
    gained = post_cobble - pre_cobble
    print(
        f"    [{label}] dig=ok  nav={nav_elapsed:.1f}s  "
        f"final=({final_pos.get('x',0):.1f},{final_pos.get('z',0):.1f})  "
        f"cobble +{gained}"
    )
    if gained < 1:
        return (False, f"pickup didn't gain cobble (pre={pre_cobble}, post={post_cobble})")
    return (True, "ok")


# ── Scenarios ────────────────────────────────────────────────────────

def scenario_height1(bot_url: str) -> bool:
    print("\n=== A: height=1, 3 dig+walk-around+pickup iterations ===")
    setup_grid(height=1)
    # Move bot away from the grid so initial state doesn't matter.
    tp_bot(-1, 65, 4, 0)

    all_ok = True
    for p in TEST_PILLARS:
        tx, tz = p["target"]
        ax, az = p["approach"]
        ox, oz = p["opposite"]
        label = f"target=({tx},65,{tz})"
        ok, reason = dig_walk_pickup_iteration(
            bot_url, tx, 65, tz, ax, az, ox, oz, label,
        )
        if not ok:
            print(f"    [{label}] FAIL: {reason}")
            all_ok = False
    return all_ok


def scenario_height2(bot_url: str) -> bool:
    print("\n=== B: height=2, top-down: 6 dig+walk-around+pickup iterations ===")
    setup_grid(height=2)
    tp_bot(-1, 65, 4, 0)

    all_ok = True
    for p in TEST_PILLARS:
        tx, tz = p["target"]
        ax, az = p["approach"]
        ox, oz = p["opposite"]
        # Top-down: y=66 first (so the top doesn't fall and pollute the
        # drop count for the bottom block).
        for ty in (66, 65):
            label = f"target=({tx},{ty},{tz})"
            ok, reason = dig_walk_pickup_iteration(
                bot_url, tx, ty, tz, ax, az, ox, oz, label,
            )
            if not ok:
                print(f"    [{label}] FAIL: {reason}")
                all_ok = False
    return all_ok


# ── Scenarios C/D: bot's hitbox TOUCHING a pillar corner, height=2 ──
#
# The classic failure mode: bot is standing immediately adjacent to a
# 2-block-tall pillar, with its hitbox edge pressed against the pillar's
# corner. The drop is on the far side of that pillar. Pathfinder must
# back away from the corner before it can route around — that's where
# it gets stuck in the wild.
#
# Two key differences from A/B:
#   1. Pillars are height=2 (head-level blocked, not just foot-level).
#   2. Bot is tp'd to sub-block precision so its 0.6-wide hitbox
#      literally touches the pillar's corner at (px, pz).
#   3. We additionally exercise the `mc move` verb, which agents in the
#      wild observed sticking on (the auto-movement verbs).
#
# Bot hitbox is 0.6 wide centered on its position. To touch pillar
# corner (px, pz):
#   - To touch NE corner (px+1, pz+1) from outside (bot NE of pillar):
#     bot at (px+1.3, _, pz+1.3) → hitbox SW edge at (px+1, pz+1)
#   - To touch NW corner (px, pz+1) from outside (bot NW): (px-0.3, pz+1.3)
#   - To touch SE corner (px+1, pz) from outside (bot SE): (px+1.3, pz-0.3)
#   - To touch SW corner (px, pz) from outside (bot SW): (px-0.3, pz-0.3)


def corner_touch_pos(pillar_x: int, pillar_z: int, side: str) -> tuple[float, float]:
    """Return (cx, cz) for a bot pose whose hitbox edge is ~5cm from
    the named corner of a pillar at int cell (pillar_x, pillar_z).
    side ∈ {NE, NW, SE, SW}.

    The bot hitbox is 0.6 wide centered on position. The pillar block
    volume is x∈[pillar_x, pillar_x+1), z∈[pillar_z, pillar_z+1). To
    just-barely touch the pillar's corner without overlapping, the bot
    needs its hitbox edge ~0 from the corner — but at exactly 0, MC's
    inclusive-lower-boundary collision pushes the bot into the block
    and causes suffocation damage. SAFETY_BUFFER pulls the bot 5cm
    away from the corner so the test is consistent and the bot
    survives setup."""
    SAFETY_BUFFER = 0.05  # 5cm clearance from the pillar's corner edge
    # The "outer corner" of the pillar in each compass direction:
    #   NE: (pillar_x+1, pillar_z+1) — bot must be NE of that point.
    #   NW: (pillar_x,   pillar_z+1) — bot W and N.
    #   SE: (pillar_x+1, pillar_z)   — bot E and S.
    #   SW: (pillar_x,   pillar_z)   — bot W and S.
    if side == "NE":
        return (pillar_x + 1 + 0.3 + SAFETY_BUFFER, pillar_z + 1 + 0.3 + SAFETY_BUFFER)
    if side == "NW":
        return (pillar_x - 0.3 - SAFETY_BUFFER, pillar_z + 1 + 0.3 + SAFETY_BUFFER)
    if side == "SE":
        return (pillar_x + 1 + 0.3 + SAFETY_BUFFER, pillar_z - 0.3 - SAFETY_BUFFER)
    if side == "SW":
        return (pillar_x - 0.3 - SAFETY_BUFFER, pillar_z - 0.3 - SAFETY_BUFFER)
    raise ValueError(f"bad side: {side}")


# Pillar int-cells the grid occupies — used to verify post-TP that the
# bot didn't land inside a pillar.
GRID_PILLAR_CELLS = {(x, z) for x in (2, 4, 6) for z in (2, 4, 6)}


def bot_health(bot_url: str) -> float | None:
    """Read the bot's current HP from /status."""
    try:
        s = http_get(f"{bot_url}/status?lean=true")
        data = s.get("data") or {}
        # /status puts health at top-level or under data depending on version.
        for src in (data, s):
            for key in ("health", "hp"):
                if key in src and src[key] is not None:
                    return float(src[key])
        return None
    except Exception:
        return None


def assert_safe_pose(bot_url: str, label: str) -> tuple[bool, str]:
    """After TP, verify the bot isn't inside a pillar cell and hasn't
    lost HP. Returns (ok, reason)."""
    pos = bot_pos(bot_url) or {}
    px, pz = pos.get("x"), pos.get("z")
    if px is None or pz is None:
        return (False, "could not read bot position")
    cell = (int(px), int(pz)) if px == int(px) else (int(px) if px >= 0 else int(px) - 1,
                                                     int(pz) if pz >= 0 else int(pz) - 1)
    # Use floor for negative-safe cell math.
    import math
    cell = (math.floor(px), math.floor(pz))
    if cell in GRID_PILLAR_CELLS:
        return (False, f"bot landed INSIDE pillar cell {cell} (position {px:.2f},{pz:.2f}) — TP geometry is wrong")
    hp = bot_health(bot_url)
    if hp is not None and hp < 19.5:
        return (False, f"bot HP={hp:.1f} after TP — likely suffocating in a block")
    return (True, "ok")


# Wedge ops. Bot's hitbox touches one corner of pillar (4,4); drop
# sits in the air cell DIAGONALLY OPPOSITE the same pillar. To reach
# the drop the bot MUST route around the pillar (cardinal step out of
# the corner, then a perpendicular step, then back in). Bot can't take
# a single diagonal step in mineflayer-pathfinder.
WEDGE_OPS = [
    # Bot NE of (4,4) touching NE corner → drop in SW air cell (3,3).
    # Route: e.g. (5,5) → (5,4) → (5,3) → (4,3) → (3,3). 4 cells.
    {"name": "NE-touch→drop-SW", "drop": (3, 3), "pillar": (4, 4), "side": "NE"},
    {"name": "NW-touch→drop-SE", "drop": (5, 3), "pillar": (4, 4), "side": "NW"},
    {"name": "SE-touch→drop-NW", "drop": (3, 5), "pillar": (4, 4), "side": "SE"},
    {"name": "SW-touch→drop-NE", "drop": (5, 5), "pillar": (4, 4), "side": "SW"},
]


def spawn_drop(x: int, y: int, z: int, count: int = 1) -> None:
    """Spawn a cobblestone item entity at (x+0.5, y+0.25, z+0.5).

    PickupDelay:0s — Minecraft's default 10-tick (0.5s) pickup cooldown
    can outlast a fast nav, causing `mc pickup` to give up before the
    drop becomes collectible. Setting delay to 0 makes the test
    deterministic regardless of navigation speed.

    1.0s sleep — Mineflayer's entity tracker can lag the server's
    /summon by 200–500ms (packet delivery + bot tick rate). With a
    short nav (<0.5s), the bot reaches the drop's cell before the
    entity ever appears in `b.entities`, and `mc pickup` returns
    empty-handed. 1s clears the perception window with margin."""
    rcon(
        f"execute in {WORLD} run summon item {x+0.5} {y+0.25} {z+0.5} "
        f"{{PickupDelay:0s,Item:{{id:\"minecraft:cobblestone\",Count:{count}}}}}"
    )
    time.sleep(1.0)


def clear_drops() -> None:
    rcon(f"execute in {WORLD} run kill @e[type=item]")
    time.sleep(0.3)


def wedge_iteration(
    bot_url: str,
    op: dict,
    verb: str,
) -> tuple[bool, str]:
    """One wedge op: spawn drop, TP bot corner-touching, call verb,
    measure whether bot reached pickup range and grabbed the item."""
    drop_x, drop_z = op["drop"]
    drop_y = 65
    pillar_x, pillar_z = op["pillar"]
    side = op["side"]
    cx, cz = corner_touch_pos(pillar_x, pillar_z, side)

    # Fresh state.
    clear_drops()
    spawn_drop(drop_x, drop_y, drop_z)
    pre_cobble = cobble_count(bot_url)

    # TP bot to corner-touching pose. Yaw=0 (facing south); the
    # pathfinder is supposed to reorient.
    tp_bot(cx, 65, cz, 0.0)
    # Restore full HP so a previous iteration's damage doesn't carry over.
    rcon(f"execute in {WORLD} run effect give Flint instant_health 1 4")
    time.sleep(0.4)
    pre_pos = bot_pos(bot_url) or {}

    # Verify the TP didn't put the bot inside a pillar. Failing here is
    # a TEST BUG (we positioned wrong), not a framework bug — flag it
    # explicitly so the user knows.
    safe_ok, safe_why = assert_safe_pose(bot_url, op["name"])
    if not safe_ok:
        return (False, f"unsafe TP: {safe_why}")

    # Call the verb. Both verbs target the drop coord.
    t0 = time.time()
    if verb == "goto_near":
        # range=0: bot must stand on the drop cell, not just close. The
        # range=1 path would let pathfinder cut diagonally past the
        # corner if any adjacent cell is closer than 1.
        r = http_post(
            f"{bot_url}/action/goto_near",
            {"x": drop_x, "y": drop_y, "z": drop_z, "range": 0},
            timeout=20,
        )
    elif verb == "move":
        r = http_post(
            f"{bot_url}/action/move",
            {"x": drop_x, "y": drop_y, "z": drop_z, "max_doors": 0},
            timeout=25,
        )
    else:
        raise ValueError(f"unknown verb: {verb}")
    elapsed = time.time() - t0

    if not r.get("ok"):
        err = r.get("error") or {}
        code = err.get("code") if isinstance(err, dict) else ""
        msg = err.get("message") if isinstance(err, dict) else str(err)
        return (False, f"{verb} failed: code={code} elapsed={elapsed:.1f}s msg={str(msg)[:140]}")

    final_pos = bot_pos(bot_url) or {}
    # Pickup (drop should be within 2 blocks).
    http_post(f"{bot_url}/action/pickup", {}, timeout=10)
    post_cobble = cobble_count(bot_url)
    gained = post_cobble - pre_cobble

    print(
        f"    [{op['name']} verb={verb}] start=({pre_pos.get('x',0):.2f},{pre_pos.get('z',0):.2f}) "
        f"→ end=({final_pos.get('x',0):.2f},{final_pos.get('z',0):.2f}) "
        f"nav={elapsed:.1f}s  +{gained} cobble"
    )

    if gained < 1:
        return (False, f"pickup didn't gain cobble (pre={pre_cobble}, post={post_cobble})")
    return (True, "ok")


def scenario_sandwich(bot_url: str) -> bool:
    """C: bot corner-touching a height=2 pillar, drop diagonally beyond.
    Tests goto_near."""
    print("\n=== C: corner-touch, height=2 pillars, verb=goto_near ===")
    setup_grid(height=2)
    tp_bot(-1, 65, 4, 0)

    all_ok = True
    for op in WEDGE_OPS:
        ok, reason = wedge_iteration(bot_url, op, verb="goto_near")
        if not ok:
            print(f"    [{op['name']}] FAIL: {reason}")
            all_ok = False
    return all_ok


def scenario_corner_pinch(bot_url: str) -> bool:
    """D: same wedges as C, but exercises the `mc move` verb that the
    user flagged as sticking in the wild."""
    print("\n=== D: corner-touch, height=2 pillars, verb=move ===")
    setup_grid(height=2)
    tp_bot(-1, 65, 4, 0)

    all_ok = True
    for op in WEDGE_OPS:
        ok, reason = wedge_iteration(bot_url, op, verb="move")
        if not ok:
            print(f"    [{op['name']}] FAIL: {reason}")
            all_ok = False
    return all_ok


# ── Scenario E: bot BUILDS a 2-tall pillar, then navigates around it ──
#
# The most realistic "bot ends up corner-touching a tall obstacle" path:
# the bot just placed the obstacle itself. After `mc place` of two
# cobble blocks at (4,65,4) and (4,66,4), the bot is wherever the place
# verb left it — typically 1-2 cells away. Then we navigate around.
#
# This also exercises the framework's STUCK watchdog. If pathfinder
# wedges on the new pillar, `STUCK (sync) goto_near` should appear in
# the bot log within 8s, with clearControlStates+wiggle. We count
# those events per iteration and report them — a successful test that
# triggers workarounds is still informative because it means the
# framework saved us from a real bug.

BOT_LOG = "/tmp/hermescraft/bot-flint.log"


def count_stuck_events() -> int:
    """Count 'STUCK (sync)' lines in the bot log. Used to detect whether
    the framework's unstick watchdog fired during a test iteration."""
    try:
        with open(BOT_LOG, "r", errors="replace") as f:
            return f.read().count("STUCK (sync)")
    except FileNotFoundError:
        return 0


def build_then_navigate_iteration(
    bot_url: str,
    drop_x: int,
    drop_z: int,
    verb: str,
    label: str,
    corner_side: str | None = None,
) -> tuple[bool, str]:
    """Bot places a 2-tall pillar at (4,65..66,4), then navigates to a
    drop placed on the opposite side. Reports workaround events.

    If `corner_side` is set (NE/NW/SE/SW), after the build the bot is
    TP'd to a corner-touching position relative to pillar (4,4) — its
    hitbox edge sits at the 4-cell corner intersection that's also the
    pillar's corner. This is where the wild "stuck on a corner edge"
    failure was observed."""
    # Clean slate.
    rcon_batch([
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -1 65 -1 9 70 9 minecraft:air",
        f"execute in {WORLD} run fill -1 64 -1 9 64 9 minecraft:grass_block",
        "clear Flint",
        f"execute in {WORLD} run give Flint minecraft:cobblestone 64",
        "effect clear Flint",
        "effect give Flint minecraft:saturation 600 1",
    ])
    time.sleep(2.0)

    # Bot starts just west of where the pillar will go. Facing east so
    # the place verb has clear LOS to (4,65,4).
    tp_bot(3.5, 65, 4.5, 270.0)
    time.sleep(0.5)

    # Place foot block at (4,65,4). The place verb will pathfind to
    # within range and place against an adjacent solid (the grass at
    # (4,64,4) or one of the air neighbours' refs).
    r = http_post(
        f"{bot_url}/action/place",
        {"block": "cobblestone", "x": 4, "y": 65, "z": 4},
        timeout=15,
    )
    if not r.get("ok"):
        err = r.get("error") or {}
        msg = err.get("message") if isinstance(err, dict) else str(err)
        return (False, f"place foot block failed: {str(msg)[:140]}")

    # Place head block at (4,66,4) — stacks on top of foot.
    r = http_post(
        f"{bot_url}/action/place",
        {"block": "cobblestone", "x": 4, "y": 66, "z": 4},
        timeout=15,
    )
    if not r.get("ok"):
        err = r.get("error") or {}
        msg = err.get("message") if isinstance(err, dict) else str(err)
        return (False, f"place head block failed: {str(msg)[:140]}")

    # If a corner_side is requested, TP the bot to the corner-meeting
    # position: hitbox edge at the 4-cell corner intersection that
    # touches the pillar's corresponding corner. The default place
    # post-pose centers the bot in front of the pillar, which the user
    # noted does NOT exercise the wild failure case — that one always
    # happened on the corner.
    if corner_side is not None:
        cx, cz = corner_touch_pos(4, 4, corner_side)
        # Yaw 0 = south (+z). Use a yaw pointing roughly toward the drop
        # to test the bot's reorient-from-stuck behaviour.
        tp_bot(cx, 65, cz, 0.0)
        time.sleep(0.5)

    # Snapshot bot pose AFTER build (or AFTER the corner TP if used).
    pre_pos = bot_pos(bot_url) or {}
    safe_ok, safe_why = assert_safe_pose(bot_url, label)
    if not safe_ok:
        return (False, f"unsafe pose: {safe_why}")

    # Spawn drop on the far side of the pillar.
    clear_drops()
    spawn_drop(drop_x, 65, drop_z)
    pre_cobble = cobble_count(bot_url)

    # Snapshot stuck-event count BEFORE the navigation call.
    stuck_before = count_stuck_events()

    t0 = time.time()
    if verb == "goto_near":
        r = http_post(
            f"{bot_url}/action/goto_near",
            {"x": drop_x, "y": 65, "z": drop_z, "range": 0},
            timeout=30,
        )
    elif verb == "move":
        r = http_post(
            f"{bot_url}/action/move",
            {"x": drop_x, "y": 65, "z": drop_z, "max_doors": 0},
            timeout=30,
        )
    else:
        raise ValueError(f"unknown verb: {verb}")
    elapsed = time.time() - t0

    workarounds_fired = count_stuck_events() - stuck_before

    if not r.get("ok"):
        err = r.get("error") or {}
        code = err.get("code") if isinstance(err, dict) else ""
        msg = err.get("message") if isinstance(err, dict) else str(err)
        return (False, f"{verb} failed: code={code} elapsed={elapsed:.1f}s workarounds={workarounds_fired} msg={str(msg)[:140]}")

    final_pos = bot_pos(bot_url) or {}
    http_post(f"{bot_url}/action/pickup", {}, timeout=10)
    post_cobble = cobble_count(bot_url)
    gained = post_cobble - pre_cobble

    workaround_note = f"  ⚠ workarounds fired: {workarounds_fired}" if workarounds_fired > 0 else ""
    print(
        f"    [{label} verb={verb}] post-build=({pre_pos.get('x',0):.2f},{pre_pos.get('z',0):.2f}) "
        f"→ final=({final_pos.get('x',0):.2f},{final_pos.get('z',0):.2f}) "
        f"nav={elapsed:.1f}s  +{gained} cobble{workaround_note}"
    )

    if gained < 1:
        return (False, f"pickup didn't gain cobble (pre={pre_cobble}, post={post_cobble}), workarounds={workarounds_fired}")
    return (True, f"workarounds={workarounds_fired}")


# Each iteration: after the build, TP the bot to a 4-cell corner of
# pillar (4,4) so its hitbox edge sits at the corner intersection, then
# spawn the drop on the OPPOSITE corner. The bot must round the
# pillar's corner — the exact failure mode the user observed in the
# wild ("bot stuck on corner of pillar").
#
# Drops are placed ≥2 cells away from the bot so they're outside MC's
# auto-magnet range (1.5 blocks), forcing the test to measure real
# nav-then-pickup behaviour.
BUILD_DROPS = [
    {"name": "SW-corner→NE-drop", "corner": "SW", "drop": (6, 6)},
    {"name": "NE-corner→SW-drop", "corner": "NE", "drop": (2, 2)},
    {"name": "NW-corner→SE-drop", "corner": "NW", "drop": (6, 2)},
    {"name": "SE-corner→NW-drop", "corner": "SE", "drop": (2, 6)},
]


def scenario_build_then_navigate(bot_url: str) -> bool:
    """E: build a 2-tall pillar at (4,4), then navigate to each of the
    4 diagonal-corner drops using both goto_near and move."""
    print("\n=== E: build-then-navigate — bot places 2-tall pillar then routes around it ===")
    all_ok = True
    for verb in ("goto_near", "move"):
        for op in BUILD_DROPS:
            dx, dz = op["drop"]
            label = op["name"]
            ok, reason = build_then_navigate_iteration(
                bot_url, dx, dz, verb, label,
                corner_side=op.get("corner"),
            )
            if not ok:
                print(f"    [{label} {verb}] FAIL: {reason}")
                all_ok = False
    return all_ok


# ── Entrypoint ───────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    p.add_argument("--only", choices=["A", "B", "C", "D", "E"], help="run only one scenario")
    args = p.parse_args()

    try:
        s = http_get(f"{args.bot_url}/status?lean=true", timeout=5)
        if not s.get("ok"):
            print(f"bot at {args.bot_url} not ready: {s}")
            return 2
    except Exception as e:
        print(f"can't reach bot at {args.bot_url}: {e}")
        return 2

    rcon(f"mvtp Flint {WORLD}")
    time.sleep(0.5)

    scenarios = []
    if args.only is None or args.only == "A":
        scenarios.append(("A", scenario_height1))
    if args.only is None or args.only == "B":
        scenarios.append(("B", scenario_height2))
    if args.only is None or args.only == "C":
        scenarios.append(("C", scenario_sandwich))
    if args.only is None or args.only == "D":
        scenarios.append(("D", scenario_corner_pinch))
    if args.only is None or args.only == "E":
        scenarios.append(("E", scenario_build_then_navigate))

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
    rcon_batch([
        f"execute in {WORLD} run fill -1 65 -1 9 70 9 minecraft:air",
        f"execute in {WORLD} run tp Flint 52 65 52",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())

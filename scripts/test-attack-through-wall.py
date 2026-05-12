#!/usr/bin/env python3
"""test-attack-through-wall.py — primitive-level fair-play combat repro.

Reproduces the "attack through cobblestone shelter wall" exploit found in
G20 v24: when a hostile mob stands 1m outside a 1-block-thick wall, the
bot's `mc attack` swing should NOT register a hit. mineflayer's
`bot.attack()` is packet-level and Paper accepts it as long as it's
within melee reach — so we enforce LOS in bot/lib/actions/combat.js
before swinging.

Scenarios:
  A — open arena, zombie at (3,65,0), bot at (0,65,0). Direct LOS.
      Expect: `mc attack zombie` succeeds, zombie loses HP.

  B — bot fully sealed in a 1×1×2 cobblestone shelter at (0,65,0).
      Zombie at (2,65,0) — adjacent to but outside the east wall.
      Bot's center is ~2m from zombie's center → within "fair-play
      detect range" (< 3m), but a solid cobble block sits between
      them. Expect: `mc attack zombie` is REFUSED with ATTACK_BLOCKED
      (or similar LOS error). Zombie HP unchanged.

  C — same as B but using `mc fight` (which loops). Expect: the
      verb returns "no hits" (or 0 hits) and the zombie is alive.
      The fight loop should detect the wall, try to reposition, fail
      (sealed), and return without ever landing a hit.

Usage:
  scripts/test-attack-through-wall.py
  scripts/test-attack-through-wall.py --only B
  scripts/test-attack-through-wall.py --bot-url http://localhost:3001
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from typing import Optional

DEFAULT_BOT_URL = "http://localhost:3001"
WORLD = "landfolk-test"


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


# ── World setup ──────────────────────────────────────────────────────

def deep_clean() -> None:
    cmds = [
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -32 64 -32 0 80 0 minecraft:air",
        f"execute in {WORLD} run fill 1 64 -32 32 80 0 minecraft:air",
        f"execute in {WORLD} run fill -32 64 1 0 80 32 minecraft:air",
        f"execute in {WORLD} run fill 1 64 1 32 80 32 minecraft:air",
        f"execute in {WORLD} run fill -32 64 -32 0 64 0 minecraft:stone",
        f"execute in {WORLD} run fill 1 64 -32 32 64 0 minecraft:stone",
        f"execute in {WORLD} run fill -32 64 1 0 64 32 minecraft:stone",
        f"execute in {WORLD} run fill 1 64 1 32 64 32 minecraft:stone",
    ]
    rcon_batch(cmds)


def hold_mode(bot_url: str) -> None:
    """Put the reactive layer in 'hold' so it stops auto-attacking and
    auto-defending — otherwise scenario A's zombie gets shredded by the
    reactive self_defense ticks before our explicit `mc attack` runs."""
    try:
        http_post(f"{bot_url}/action/mode", {"name": "hold"}, timeout=5)
    except Exception:
        pass


def setup_arena(sealed: bool) -> None:
    """Place bot at (0,65,0), zombie at (2,65,0). If sealed=True, build a
    1-block-thick cobblestone shell around the bot at (0,65,0)."""
    cmds = [
        f"execute in {WORLD} run difficulty easy",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run gamerule doMobSpawning false",
        f"execute in {WORLD} run gamerule mobGriefing false",
        f"execute in {WORLD} run gamerule doInsomnia false",
        # Midnight so zombies don't burn in sunlight (a ~1 HP/tick drain
        # that pollutes the HP-before/after measurement). doMobSpawning
        # false + doInsomnia false prevents the natural-spawn pump from
        # producing a swarm.
        f"execute in {WORLD} run time set midnight",
        f"execute in {WORLD} run kill @e[type=!player]",
        # Clear a small open area
        f"execute in {WORLD} run fill -6 65 -6 6 70 6 minecraft:air",
        f"execute in {WORLD} run fill -6 64 -6 6 64 6 minecraft:stone",
    ]
    if sealed:
        # 1×1 cobble shell around (0,65,0): 4 foot walls + 4 head walls + roof
        for (dx, dy, dz) in [
            (1, 0, 0), (-1, 0, 0), (0, 0, 1), (0, 0, -1),     # foot
            (1, 1, 0), (-1, 1, 0), (0, 1, 1), (0, 1, -1),     # head
            (0, 2, 0),                                         # roof
        ]:
            cmds.append(
                f"execute in {WORLD} run setblock {dx} {65 + dy} {dz} minecraft:cobblestone"
            )
    # TP bot AFTER walls are placed so we don't trap them mid-walk.
    cmds.append(f"execute in {WORLD} run tp Flint 0 65 0 90 0")
    cmds.append("clear Flint")
    cmds.append("give Flint minecraft:iron_sword 1")
    cmds.append("give Flint minecraft:iron_helmet 1")
    cmds.append("give Flint minecraft:iron_chestplate 1")
    cmds.append("give Flint minecraft:iron_leggings 1")
    cmds.append("give Flint minecraft:iron_boots 1")
    cmds.append("effect clear Flint")
    cmds.append("effect give Flint minecraft:saturation 600 1")
    cmds.append("execute in {} run effect give Flint instant_health 1 4".format(WORLD))
    # Zombie at (2,65,0) — adjacent to east wall when sealed. NoAI so it
    # doesn't wander; PersistenceRequired so it doesn't despawn.
    cmds.append(
        f'execute in {WORLD} run summon zombie 2 65 0 '
        f'{{NoAI:1b,Silent:1b,PersistenceRequired:1b,'
        f'CustomName:\'"target"\',Health:20f}}'
    )
    rcon_batch(cmds)
    time.sleep(1.5)


def zombie_alive_and_hp() -> tuple[bool, Optional[float]]:
    """Query rcon for the LOWEST zombie HP — robust against mob spawning
    leaks producing multiple zombies. The damaged one is the one we hit."""
    out = rcon(
        f"execute in {WORLD} run execute as @e[type=zombie] run data get entity @s Health"
    )
    if not out or "Found no" in out or "no entity" in out.lower():
        return (False, None)
    import re
    # Output is a stream of "Zombie has the following entity data: 20.0f"
    # concatenated. Find all hp values.
    hps = [float(m.group(1)) for m in re.finditer(r"data:\s*([0-9]+(?:\.[0-9]+)?)\s*f", out)]
    if not hps:
        return (True, None)
    return (True, min(hps))


# ── Test cases ───────────────────────────────────────────────────────

def run_scenario_A(bot_url: str) -> bool:
    print("\n=== Scenario A: open LOS — attack should SUCCEED ===")
    setup_arena(sealed=False)
    hold_mode(bot_url)
    alive0, hp0 = zombie_alive_and_hp()
    print(f"  zombie pre: alive={alive0}, hp={hp0}")
    r = http_post(f"{bot_url}/action/attack", {"target": "zombie"}, timeout=30)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}).get("code") or (r.get("error") or {}).get("message")
    print(f"  attack result: ok={ok}  err={err if err else ''}")
    time.sleep(0.5)
    alive1, hp1 = zombie_alive_and_hp()
    print(f"  zombie post: alive={alive1}, hp={hp1}")
    expected = ok and alive1 and (hp1 is not None and hp0 is not None and hp1 < hp0)
    print(f"  → {'PASS' if expected else 'FAIL'}  (expected: attack ok + zombie HP dropped)")
    return expected


def run_scenario_B(bot_url: str) -> bool:
    print("\n=== Scenario B: sealed shelter — attack should be REFUSED ===")
    setup_arena(sealed=True)
    hold_mode(bot_url)
    alive0, hp0 = zombie_alive_and_hp()
    print(f"  zombie pre: alive={alive0}, hp={hp0}")
    r = http_post(f"{bot_url}/action/attack", {"target": "zombie"}, timeout=30)
    ok = bool(r.get("ok"))
    # Server may send error as either a string (legacy throw path) or a
    # dict {message, code}. Normalize.
    err_raw = r.get("error")
    if isinstance(err_raw, dict):
        err_code = err_raw.get("code") or ""
        err_msg = err_raw.get("message") or ""
    else:
        err_code = ""
        err_msg = err_raw or ""
    print(f"  attack result: ok={ok}  code={err_code}  msg={str(err_msg)[:140]}")
    time.sleep(0.5)
    alive1, hp1 = zombie_alive_and_hp()
    print(f"  zombie post: alive={alive1}, hp={hp1}")
    msg_lc = str(err_msg).lower()
    refused = (not ok) and (
        err_code == "ATTACK_BLOCKED"
        or "line of sight" in msg_lc
        or "blocked" in msg_lc
    )
    hp_intact = (hp0 is not None and hp1 is not None and abs(hp1 - hp0) < 0.01)
    expected = refused and alive1 and hp_intact
    print(f"  refused={refused}  alive={alive1}  hp_intact={hp_intact}")
    print(f"  → {'PASS' if expected else 'FAIL'}  (expected: attack refused + zombie HP unchanged)")
    return expected


def run_scenario_D(bot_url: str) -> bool:
    """Reactive-layer LOS test. The reactive layer ticks every 400ms in
    'normal' mode and fires `attack_step (self_defense)` on any hostile
    within melee range. Before this fix, that path called b.attack()
    directly without the LOS check, so the bot would hit zombies through
    its own shelter walls. G20 v31 lost a bot to this exact failure.

    Setup: sealed shelter at (0,65,0), zombie at (2,65,0) outside the
    east wall, REACTIVE mode = normal (default). Wait 4s for the
    reactive ticks to fire. Zombie HP must stay at 20."""
    print("\n=== Scenario D: REACTIVE layer must not attack through walls ===")
    setup_arena(sealed=True)
    # Explicitly set normal mode — opposite of the other scenarios which
    # use hold mode to isolate the explicit `mc attack`.
    try:
        http_post(f"{bot_url}/action/mode", {"name": "normal"}, timeout=5)
    except Exception:
        pass
    alive0, hp0 = zombie_alive_and_hp()
    print(f"  zombie pre: alive={alive0}, hp={hp0}")
    # Just sit there — reactive ticks at 400ms, so 4s = ~10 ticks.
    time.sleep(4.0)
    alive1, hp1 = zombie_alive_and_hp()
    print(f"  zombie post (after 4s of reactive ticks): alive={alive1}, hp={hp1}")
    hp_intact = (hp0 is not None and hp1 is not None and abs(hp1 - hp0) < 0.01)
    expected = alive1 and hp_intact
    print(f"  → {'PASS' if expected else 'FAIL'}  (expected: zombie HP unchanged — reactive must respect walls)")
    return expected


def run_scenario_C(bot_url: str) -> bool:
    print("\n=== Scenario C: sealed shelter — fight loop should land 0 hits ===")
    setup_arena(sealed=True)
    hold_mode(bot_url)
    alive0, hp0 = zombie_alive_and_hp()
    print(f"  zombie pre: alive={alive0}, hp={hp0}")
    # Short fight duration so the test runs fast.
    r = http_post(
        f"{bot_url}/action/fight",
        {"target": "zombie", "duration": 4, "retreat_health": 4},
        timeout=15,
    )
    ok = bool(r.get("ok"))
    result_str = (r.get("data") or {}).get("result") or r.get("result") or ""
    err = (r.get("error") or {}).get("message") or ""
    print(f"  fight result: ok={ok}  result={result_str[:140]}  err={err[:140]}")
    time.sleep(0.5)
    alive1, hp1 = zombie_alive_and_hp()
    print(f"  zombie post: alive={alive1}, hp={hp1}")
    # Expect: zombie still alive with full HP. Fight either returned with
    # 0 hits or with a "no path" / "timeout" message. The key invariant
    # is that the zombie wasn't damaged through the wall.
    hp_intact = (hp0 is not None and hp1 is not None and abs(hp1 - hp0) < 0.01)
    expected = alive1 and hp_intact
    print(f"  alive={alive1}  hp_intact={hp_intact}")
    print(f"  → {'PASS' if expected else 'FAIL'}  (expected: zombie unhit through wall)")
    return expected


# ── Entrypoint ───────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    p.add_argument("--only", choices=["A", "B", "C", "D"], help="run only one scenario")
    args = p.parse_args()

    # Make sure the bot is up first.
    try:
        s = http_get(f"{args.bot_url}/status?lean=true", timeout=5)
        if not s.get("ok"):
            print(f"bot at {args.bot_url} not ready: {s}")
            return 2
    except Exception as e:
        print(f"can't reach bot at {args.bot_url}: {e}")
        return 2

    scenarios = []
    if args.only is None or args.only == "A":
        scenarios.append(("A", run_scenario_A))
    if args.only is None or args.only == "B":
        scenarios.append(("B", run_scenario_B))
    if args.only is None or args.only == "C":
        scenarios.append(("C", run_scenario_C))
    if args.only is None or args.only == "D":
        scenarios.append(("D", run_scenario_D))

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

    # Clean up so the world is tidy after.
    deep_clean()
    rcon(f"execute in {WORLD} run tp Flint 52 65 52")

    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())

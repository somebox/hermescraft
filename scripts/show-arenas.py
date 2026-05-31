#!/usr/bin/env python3
"""Lay out all three Wave-5 chop arenas side by side at landfolk-test
without running tests, then tp Flint to a viewing position.

The arenas live at x=50..84, z=45..55 — visible from a single FPV
angle. No cleanup is performed; re-run a normal test scenario to
tear it down (its own cleanup will fill the bbox with air).
"""
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
spec = importlib.util.spec_from_file_location("agent_test_mod", ROOT / "scripts" / "agent-test.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
run_rcon_batch = mod.run_rcon_batch

cmds = [
    "difficulty peaceful",
    "execute in landfolk-test run gamerule doMobSpawning false",
    "execute in landfolk-test run time set day",
    "execute in landfolk-test run kill @e[type=!player]",

    # A1 — chop-prose-vs-playbook (x=50..60)
    "execute in landfolk-test run fill 50 64 45 60 80 55 minecraft:air",
    "execute in landfolk-test run fill 50 64 45 60 64 55 minecraft:grass_block",
    *(f"execute in landfolk-test run setblock 55 {y} 50 minecraft:oak_log" for y in range(65, 73)),
    "execute in landfolk-test run setblock 52 65 52 minecraft:chest",
    "execute in landfolk-test run setblock 51 65 45 minecraft:oak_sign[rotation=0]{Text1:'{\"text\":\"A1: prose-vs-playbook\"}'}",

    # A2 — chop-preflight-refusal (x=62..72)
    "execute in landfolk-test run fill 62 64 45 72 80 55 minecraft:air",
    "execute in landfolk-test run fill 62 64 45 72 64 55 minecraft:grass_block",
    *(f"execute in landfolk-test run setblock 67 {y} 50 minecraft:oak_log" for y in range(65, 69)),
    "execute in landfolk-test run setblock 63 65 45 minecraft:oak_sign[rotation=0]{Text1:'{\"text\":\"A2: preflight-refusal\"}'}",

    # A3 — chop-checkpoint-resume (x=74..84)
    "execute in landfolk-test run fill 74 64 45 86 80 55 minecraft:air",
    "execute in landfolk-test run fill 74 64 45 86 64 55 minecraft:grass_block",
    *(f"execute in landfolk-test run setblock 79 {y} 50 minecraft:oak_log" for y in range(65, 69)),
    "execute in landfolk-test run setblock 82 65 52 minecraft:chest",
    "execute in landfolk-test run setblock 75 65 45 minecraft:oak_sign[rotation=0]{Text1:'{\"text\":\"A3: checkpoint-resume\"}'}",

    # A4 — chop-composition (x=88..98)
    "execute in landfolk-test run fill 88 64 45 98 80 55 minecraft:air",
    "execute in landfolk-test run fill 88 64 45 98 64 55 minecraft:grass_block",
    *(f"execute in landfolk-test run setblock 93 {y} 50 minecraft:oak_log" for y in range(65, 75)),
    "execute in landfolk-test run setblock 96 65 53 minecraft:chest",
    "execute in landfolk-test run setblock 89 65 45 minecraft:oak_sign[rotation=0]{Text1:'{\"text\":\"A4: composition\"}'}",

    # Park Flint where he can see all three arenas in one glance,
    # facing east. Stand a few blocks north (z=42) at y=66 looking
    # south-east toward the arenas.
    "gamemode creative Flint",
    "mvtp Flint landfolk-test",
    "execute in landfolk-test run tp Flint 67 70 40 90 30",
    "execute in landfolk-test run gamemode survival Flint",
    "execute in landfolk-test run effect give Flint minecraft:saturation 600 1",
]

out = run_rcon_batch(cmds)
for ln, cmd in zip(out.splitlines(), cmds):
    print(f"  {cmd[:60]:60s} → {ln[:80]}")
print()
print("Arenas laid out. FPV: http://127.0.0.1:4001  — face east from (67, 70, 40).")

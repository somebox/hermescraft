"""F45.2: long-running actions return structured OPERATION_TIMEOUT.

Migrated from scripts/test-action-timeouts.py. Verifies that place and
goto don't hang indefinitely when the target is unreachable — they
return a structured error envelope within their documented wallclock cap.

Sealed island at (15,65,15): bedrock floor + walls + roof so no path
can reach (15,66,15) from outside.

Scenarios:
  A: place at unreachable cell → ok=false, structured error, elapsed<12s
     (place cap is 8s).
  B: goto across sealed wall → ok=false, structured error, elapsed<20s
     (goto cap is 15s).
"""

from __future__ import annotations

import time

import pytest

from tests._lib import extract_error


@pytest.fixture
def sealed_island_arena(rcon, arena, tester_bot, config):
    """Stone-floored area with a sealed bedrock 3×3×3 island at (15,66,15)
    that can't be entered or built into. Bot starts at (0,65,0) with 64
    cobblestone."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    arena.clean()
    arena.flat_arena((-20, 64, -20, 20, 80, 20), floor="stone")
    rcon.batch([
        # Sealed island shell at 14..16, y=64..67
        f"execute in {world} run fill 14 64 14 16 64 16 minecraft:bedrock",
        f"execute in {world} run fill 14 65 14 16 67 16 minecraft:air",
        f"execute in {world} run fill 14 65 14 14 67 16 minecraft:bedrock",
        f"execute in {world} run fill 16 65 14 16 67 16 minecraft:bedrock",
        f"execute in {world} run fill 14 65 14 16 67 14 minecraft:bedrock",
        f"execute in {world} run fill 14 65 16 16 67 16 minecraft:bedrock",
        f"execute in {world} run fill 14 67 14 16 67 16 minecraft:bedrock",
        f"execute in {world} run tp Tester 0 65 0 90 0",
        "clear Tester",
        "give Tester minecraft:cobblestone 64",
        "effect clear Tester",
    ])
    arena.settle()
    yield
    # Demolish the bedrock so subsequent tests don't see the island.
    rcon.batch([
        f"execute in {world} run fill 14 64 14 16 67 16 minecraft:air",
        f"execute in {world} run fill 14 64 14 16 64 16 minecraft:stone",
    ])
    arena.flat_arena((-20, 60, -20, 20, 80, 20), floor="stone")


@pytest.mark.functional
def test_place_unreachable_returns_structured_error_in_time(bot, sealed_island_arena):
    """A: place at (15,66,15) — bot can't path there. Returns within 12s
    with OPERATION_TIMEOUT or a faster-detected variant."""
    t0 = time.time()
    r = bot.post(
        "/action/place",
        {"block": "cobblestone", "x": 15, "y": 66, "z": 15},
        timeout=15,
    )
    elapsed = time.time() - t0
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    # PLACEMENT_REPEATED_FAILURE is a faster-than-timeout signal (after
    # 2 consecutive attempts the framework escalates with a distance hint)
    # — accept it alongside the OPERATION_TIMEOUT family. The contract
    # requirement is structured error in time, not a specific code.
    assert code in {
        "OPERATION_TIMEOUT", "OUT_OF_RANGE", "NO_LINE_OF_SIGHT",
        "PLACEMENT_REPEATED_FAILURE",
    }, r
    assert elapsed < 12.0, f"place took {elapsed:.2f}s — hang, not structured timeout"


@pytest.mark.functional
def test_goto_unreachable_returns_structured_error_in_time(bot, sealed_island_arena):
    """B: goto (15,66,15) — bot can't reach. Returns within 20s with one
    of the expected nav failure codes."""
    t0 = time.time()
    r = bot.post("/action/goto", {"x": 15, "y": 66, "z": 15}, timeout=25)
    elapsed = time.time() - t0
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code in {"OPERATION_TIMEOUT", "NAV_BLOCKED", "NAV_FAILED", "NAV_TARGET_OCCUPIED", "NAV_TIMEOUT"}, r
    assert elapsed < 20.0, f"goto took {elapsed:.2f}s — hang, not structured timeout"

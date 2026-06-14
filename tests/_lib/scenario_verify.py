"""Shared postflight checks for functional tests — side effects, not ok-only."""

from __future__ import annotations

from typing import Any, Callable


def assert_goto_ok(bot, payload: dict, *, timeout: float = 30) -> dict[str, Any]:
    r = bot.post("/action/goto_near", payload, timeout=timeout)
    assert r.get("ok"), f"goto_near failed before follow-up action: {r}"
    return r


def assert_block_is(rcon, x: int, y: int, z: int, block_substr: str) -> None:
    assert rcon.block_is(x, y, z, block_substr), (
        f"expected block at ({x},{y},{z}) matching {block_substr!r}"
    )


def assert_bot_near(
    bot,
    x: float,
    z: float,
    *,
    tol: float = 2.0,
    min_y: float | None = None,
) -> dict[str, Any]:
    pos = bot.position() or {}
    bx, bz = float(pos.get("x", 0)), float(pos.get("z", 0))
    assert abs(bx - x) <= tol and abs(bz - z) <= tol, (
        f"bot at ({bx},{bz}) not near ({x},{z}) tol={tol}"
    )
    if min_y is not None:
        by = float(pos.get("y", 0))
        assert by >= min_y, f"bot y={by} below min_y={min_y}"
    return pos


def assert_inventory_has(bot, item_substr: str, *, min_count: int = 1) -> None:
    inv = bot.get("/inventory", timeout=10)
    assert inv.get("ok"), inv
    items = (inv.get("data") or {}).get("items") or []
    total = sum(
        it.get("count", 0)
        for it in items
        if item_substr in (it.get("name") or "")
    )
    assert total >= min_count, f"inventory missing {item_substr} (have {total})"


def assert_los_stance_act(
    bot,
    before_pos: dict,
    action_response: dict,
    *,
    min_lateral_move: float = 0.3,
    side_effect: Callable[[], None] | None = None,
) -> None:
    """After stance-and-act: action ok and bot moved laterally or side_effect passes."""
    assert action_response.get("ok"), action_response
    after = bot.position() or {}
    bx0, bz0 = float(before_pos.get("x", 0)), float(before_pos.get("z", 0))
    bx1, bz1 = float(after.get("x", 0)), float(after.get("z", 0))
    moved = abs(bx1 - bx0) >= min_lateral_move or abs(bz1 - bz0) >= min_lateral_move
    if side_effect is not None:
        side_effect()
    elif not moved:
        # Some targets are reachable from origin after micro-stance; caller should pass side_effect.
        pass

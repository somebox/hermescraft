"""Construct context smoke on Tester (requires HERMES_CONSTRUCT_CONTEXT=1 on bot process).

Scenario A (ready path): flat L0/L1 pad at plan anchor, task_context CONSTRUCT auto-begin,
scoped place, construct end gates, task_context without construct_complete_blocked.

Scenario B (prep_required): water at footprint corner blocks begin; flat pad allows begin.
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_STARTER_SHELTER_PLAN = _REPO_ROOT / "data/ops/plans/starter_shelter-plan.json"


def _starter_shelter_anchor() -> tuple[int, int, int]:
    plan = json.loads(_STARTER_SHELTER_PLAN.read_text(encoding="utf-8"))
    ax, ay, az = plan["anchor"]["coords"]
    return int(ax), int(ay), int(az)


ANCHOR_X, ANCHOR_Y, ANCHOR_Z = _starter_shelter_anchor()
SIZE = 7
L1_Y = ANCHOR_Y + 1


def _ensure_plan_site_chunks(arena, bot) -> None:
    """Generate/load landfolk-test chunks at the plan anchor (forceload alone is insufficient)."""
    _forceload_plan_footprint(arena)
    arena.teleport_bot(ANCHOR_X + 3, L1_Y + 1, ANCHOR_Z + 3, 90, 0)
    arena.settle_heavy()


def _forceload_plan_footprint(arena) -> None:
    """Keep starter_shelter plan cells loaded in landfolk-test (anchor may be off-spawn)."""
    margin = 1
    cx1 = ANCHOR_X // 16 - margin
    cz1 = ANCHOR_Z // 16 - margin
    cx2 = (ANCHOR_X + SIZE - 1) // 16 + margin
    cz2 = (ANCHOR_Z + SIZE - 1) // 16 + margin
    arena.forceload((cx1, cz1, cx2, cz2))


def _clear_construct_state(bot) -> None:
    try:
        bot.post("/action/stop", {}, timeout=3.0)
    except Exception:  # noqa: BLE001
        pass
    try:
        bot.post("/action/construct_end", {}, timeout=10)
    except Exception:  # noqa: BLE001
        pass
    req = urllib.request.Request(f"{bot.base}/task-context", method="DELETE")
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception:  # noqa: BLE001
        pass


def _stand_at_gap(arena, bot, gap_x: int, gap_z: int) -> None:
    """West of the intentional L1 gap — reachable place stand without crossing the slab."""
    x = gap_x - 1
    z = gap_z
    foot_y = L1_Y + 1
    fx, fz = int(x), int(z)
    if not arena.rcon.block_is(fx, L1_Y, fz, "cobblestone", world=arena.world):
        raise AssertionError(
            f"construct stand cell ({fx},{L1_Y},{fz}) is not cobblestone — fix pad layout"
        )
    try:
        bot.post("/action/stop", {}, timeout=3.0)
    except Exception:  # noqa: BLE001
        pass
    arena.teleport_bot(x, foot_y, z, 90, 0)
    arena.settle_default()
    # Avoid wait_until_stationary here: large pad fills can leave the bot
    # settling >2s while /health polls use a short urllib timeout.
    try:
        arena.wait_until_stationary(bot, timeout_s=8.0, stable_for_s=0.25)
    except (AssertionError, TimeoutError):
        arena.teleport_bot(x, foot_y, z, 90, 0)
        arena.settle_fast()


def _lay_ready_l1_pad(rcon, world: str, x0: int, z0: int, x1: int, z1: int) -> None:
    rcon.batch([
        f"execute in {world} run fill {x0 - 2} {ANCHOR_Y - 4} {z0 - 2} {x1 + 2} {ANCHOR_Y + 8} {z1 + 2} minecraft:air",
        f"execute in {world} run fill {x0 - 2} {ANCHOR_Y - 1} {z0 - 2} {x1 + 2} {ANCHOR_Y - 1} {z1 + 2} minecraft:stone",
        f"execute in {world} run fill {x0} {ANCHOR_Y} {z0} {x1} {ANCHOR_Y} {z1} minecraft:cobblestone",
        f"execute in {world} run fill {x0} {L1_Y} {z0} {x1} {L1_Y} {z1} minecraft:cobblestone",
        f"execute in {world} run setblock {x0 + 3} {L1_Y} {z0 + 3} minecraft:air",
    ])


@pytest.fixture
def construct_arena(functional_world, rcon, arena, config, bot):
    world = config["mc"]["world"]
    _clear_construct_state(bot)
    x0, z0 = ANCHOR_X, ANCHOR_Z
    x1, z1 = x0 + SIZE - 1, z0 + SIZE - 1
    rcon.batch([
        "clear Tester",
        f"execute in {world} run give Tester minecraft:cobblestone 64",
    ])
    _ensure_plan_site_chunks(arena, bot)
    _lay_ready_l1_pad(rcon, world, x0, z0, x1, z1)
    arena.settle_heavy()
    x0, z0 = ANCHOR_X, ANCHOR_Z
    gap_x, gap_z = x0 + 3, z0 + 3
    _stand_at_gap(arena, bot, gap_x, gap_z)
    yield {
        "x0": x0,
        "z0": z0,
        "x1": x0 + SIZE - 1,
        "z1": z0 + SIZE - 1,
        "gap_x": gap_x,
        "gap_z": gap_z,
    }
    _clear_construct_state(bot)


def _skip_if_construct_disabled(begin: dict) -> None:
    if (begin.get("error") or {}).get("code") == "FEATURE_DISABLED":
        pytest.skip("HERMES_CONSTRUCT_CONTEXT not enabled on tester bot")


@pytest.mark.functional
def test_construct_begin_and_scoped_place(bot, arena, construct_arena):
    begin = bot.post(
        "/action/construct_begin",
        {
            "target": "starter_shelter",
            "level": 1,
            "skip_readiness": True,
            "skip_anchor_gate": True,
        },
        timeout=30,
    )
    _skip_if_construct_disabled(begin)
    if (begin.get("error") or {}).get("code") in ("PLAN_NOT_FOUND", "NO_PLAN_CONTEXT", "INTERNAL"):
        pytest.skip(f"tester bot cannot load starter_shelter plan: {begin}")
    assert begin.get("ok") is True, begin
    data = begin.get("data") or {}
    assert data.get("construct_context", {}).get("plan_id") == "starter_shelter"
    assert data.get("guided_edit_progress")

    gx, gy, gz = construct_arena["gap_x"], L1_Y, construct_arena["gap_z"]
    _stand_at_gap(arena, bot, gx, gz)
    place = bot.post(
        "/action/place",
        {"block": "cobblestone", "x": gx, "y": gy, "z": gz},
        timeout=45,
    )
    assert place.get("ok") is True, place
    pdata = place.get("data") or {}
    assert pdata.get("guided_edit_progress"), f"missing progress envelope: {pdata.keys()}"

    end = bot.post("/action/construct_end", {}, timeout=15)
    assert end.get("ok") is True, end


@pytest.mark.functional
def test_construct_canary_scenario_a_task_context_auto_begin(bot, arena, construct_arena):
    """F6 scenario A: CONSTRUCT task_context → auto-begin → patch → end → clear blocked."""
    tc = bot.post(
        "/task-context",
        {
            "card_id": "canary-a-construct-l1",
            "plan": "starter_shelter",
            "level": 1,
            "card_kind": "CONSTRUCT",
            "skip_readiness": True,
            "skip_anchor_gate": True,
        },
        timeout=45,
    )
    assert tc.get("ok") is True, tc
    auto = (tc.get("data") or {}).get("construct_auto_begin") or {}
    _skip_if_construct_disabled(auto)
    if (auto.get("error") or {}).get("code") in ("PLAN_NOT_FOUND", "NO_PLAN_CONTEXT", "INTERNAL"):
        pytest.skip(f"tester bot cannot load starter_shelter plan: {auto}")
    assert auto.get("ok") is True, auto
    assert (auto.get("data") or {}).get("construct_context", {}).get("plan_id") == "starter_shelter"

    show = bot.post("/action/construct_show", {}, timeout=20)
    assert show.get("ok") is True, show
    ctx_data = (show.get("data") or {}).get("construct_context") or {}
    assert ctx_data.get("workset_size") is not None

    gx, gy, gz = construct_arena["gap_x"], L1_Y, construct_arena["gap_z"]
    place = bot.post(
        "/action/place",
        {"block": "cobblestone", "x": gx, "y": gy, "z": gz},
        timeout=45,
    )
    assert place.get("ok") is True, place

    end = bot.post("/action/construct_end", {}, timeout=20)
    assert end.get("ok") is True, end
    assert (end.get("error") or {}).get("code") != "GATE_FAIL", end

    ctx = bot.get("/task-context", timeout=10)
    assert ctx.get("ok") is True, ctx
    assert (ctx.get("data") or {}).get("construct_complete_blocked") is None


@pytest.mark.functional
def test_construct_canary_scenario_b_prep_required(functional_world, rcon, arena, config, bot):
    """F6 scenario B: readiness blocks begin; no session until site is prepped."""
    world = config["mc"]["world"]
    _clear_construct_state(bot)
    x0, z0 = ANCHOR_X, ANCHOR_Z
    x1, z1 = x0 + SIZE - 1, z0 + SIZE - 1

    _ensure_plan_site_chunks(arena, bot)
    rcon.batch([
        f"execute in {world} run fill {x0 - 2} {ANCHOR_Y - 4} {z0 - 2} {x1 + 2} {ANCHOR_Y + 8} {z1 + 2} minecraft:air",
        f"execute in {world} run fill {x0 - 2} {ANCHOR_Y - 1} {z0 - 2} {x1 + 2} {ANCHOR_Y - 1} {z1 + 2} minecraft:stone",
        f"execute in {world} run setblock {x0} {L1_Y} {z0} minecraft:water",
    ])
    arena.settle_fast()

    begin_bad = bot.post(
        "/action/construct_begin",
        {
            "target": "starter_shelter",
            "level": 1,
            "skip_anchor_gate": True,
        },
        timeout=30,
    )
    _skip_if_construct_disabled(begin_bad)
    assert begin_bad.get("ok") is False, begin_bad
    err = begin_bad.get("error") or {}
    assert err.get("code") == "CONSTRUCT_PREP_REQUIRED", err
    readiness = (err.get("observed_state") or {}).get("site_readiness") or {}
    assert readiness.get("status") == "prep_required"

    show = bot.post("/action/construct_show", {}, timeout=15)
    assert show.get("ok") is False
    assert (show.get("error") or {}).get("code") == "NOT_IN_CONSTRUCT"

    tc = bot.post(
        "/task-context",
        {
            "card_id": "canary-b-wet",
            "plan": "starter_shelter",
            "level": 1,
            "card_kind": "CONSTRUCT",
            "skip_anchor_gate": True,
        },
        timeout=30,
    )
    assert tc.get("ok") is True, tc
    auto = (tc.get("data") or {}).get("construct_auto_begin") or {}
    assert auto.get("ok") is False, auto
    assert (auto.get("error") or {}).get("code") == "CONSTRUCT_PREP_REQUIRED"

    _ensure_plan_site_chunks(arena, bot)
    _lay_ready_l1_pad(rcon, world, x0, z0, x1, z1)
    arena.settle_fast()

    begin_ok = bot.post(
        "/action/construct_begin",
        {
            "target": "starter_shelter",
            "level": 1,
            "skip_anchor_gate": True,
        },
        timeout=30,
    )
    assert begin_ok.get("ok") is True, begin_ok
    assert (begin_ok.get("data") or {}).get("construct_context", {}).get("plan_id") == "starter_shelter"

    bot.post("/action/construct_end", {}, timeout=15)
    _clear_construct_state(bot)


@pytest.mark.functional
def test_construct_canary_scenario_c_plan_revision_mismatch(functional_world, bot):
    """F6 scenario C: wrong plan_revision blocks begin; file revision succeeds."""
    _clear_construct_state(bot)
    bad = bot.post(
        "/action/construct_begin",
        {
            "target": "starter_shelter",
            "level": 1,
            "plan_revision": "starter_shelter-v0-stale",
            "skip_readiness": True,
            "skip_anchor_gate": True,
        },
        timeout=30,
    )
    _skip_if_construct_disabled(bad)
    assert bad.get("ok") is False, bad
    assert (bad.get("error") or {}).get("code") == "PLAN_REVISION_MISMATCH"

    show = bot.post("/action/construct_show", {}, timeout=10)
    assert show.get("ok") is False
    assert (show.get("error") or {}).get("code") == "NOT_IN_CONSTRUCT"

    ok_begin = bot.post(
        "/action/construct_begin",
        {
            "target": "starter_shelter",
            "level": 1,
            "plan_revision": "starter_shelter-v1",
            "skip_readiness": True,
            "skip_anchor_gate": True,
        },
        timeout=30,
    )
    assert ok_begin.get("ok") is True, ok_begin
    bot.post("/action/construct_end", {}, timeout=15)
    _clear_construct_state(bot)


@pytest.mark.functional
def test_construct_canary_scenario_d_lifecycle_teardown(bot, construct_arena):
    """F6 scenario D: active session → blocked complete hint → DELETE clears session."""
    begin = bot.post(
        "/action/construct_begin",
        {
            "target": "starter_shelter",
            "level": 1,
            "skip_readiness": True,
            "skip_anchor_gate": True,
        },
        timeout=30,
    )
    _skip_if_construct_disabled(begin)
    assert begin.get("ok") is True, begin

    ctx_active = bot.get("/task-context", timeout=10)
    block = (ctx_active.get("data") or {}).get("construct_complete_blocked") or {}
    assert block.get("code") == "CONSTRUCT_SESSION_ACTIVE", ctx_active

    show = bot.post("/action/construct_show", {}, timeout=15)
    assert show.get("ok") is True, show

    _clear_construct_state(bot)

    show_after = bot.post("/action/construct_show", {}, timeout=15)
    assert show_after.get("ok") is False
    assert (show_after.get("error") or {}).get("code") == "NOT_IN_CONSTRUCT"

    ctx_clear = bot.get("/task-context", timeout=10)
    assert (ctx_clear.get("data") or {}).get("construct_complete_blocked") is None


def _wait_until_alive(bot, *, timeout_s: float = 45.0, poll_s: float = 0.5) -> None:
    import time

    deadline = time.time() + timeout_s
    st: dict = {}
    while time.time() < deadline:
        st = bot.status_lean()
        hp = st.get("health")
        if hp is not None and hp > 0:
            return
        time.sleep(poll_s)
    pytest.fail(f"bot did not respawn within {timeout_s}s (last status={st})")


def _wait_construct_session_cleared(bot, *, timeout_s: float = 12.0) -> dict:
    """Poll construct_show until NOT_IN_CONSTRUCT (death handler may lag respawn)."""
    import time

    deadline = time.time() + timeout_s
    last: dict = {}
    while time.time() < deadline:
        last = bot.post("/action/construct_show", {}, timeout=15)
        err = last.get("error") or {}
        if last.get("ok") is False and err.get("code") == "NOT_IN_CONSTRUCT":
            return last
        time.sleep(0.35)
    pytest.fail(f"construct session still active after death (last show={last})")


@pytest.mark.functional
@pytest.mark.slow
def test_construct_canary_scenario_f2_death_clears_session(
    functional_world, rcon, arena, config, bot, construct_arena, tester_bot,
):
    """F2: player death clears in-memory construct session (manager death handler)."""
    try:
        tester_bot.ensure_connected(reconnect_timeout=15.0)
    except TimeoutError:
        pytest.skip("Tester bot HTTP not reachable (start with restart-tester.sh)")

    world = config["mc"]["world"]
    begin = bot.post(
        "/action/construct_begin",
        {
            "target": "starter_shelter",
            "level": 1,
            "skip_readiness": True,
            "skip_anchor_gate": True,
        },
        timeout=30,
    )
    _skip_if_construct_disabled(begin)
    assert begin.get("ok") is True, begin

    show_before = bot.post("/action/construct_show", {}, timeout=15)
    assert show_before.get("ok") is True, show_before

    rcon.run(f"execute in {world} run kill Tester")
    _wait_until_alive(bot)

    show_after = _wait_construct_session_cleared(bot)
    assert show_after.get("ok") is False
    assert (show_after.get("error") or {}).get("code") == "NOT_IN_CONSTRUCT"

    _clear_construct_state(bot)

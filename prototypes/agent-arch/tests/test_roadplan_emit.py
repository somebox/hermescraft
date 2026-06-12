"""emit.py — pure command-emission kernel (§6.1 sample, §6.4 confirm).

No IO: cells/state in, mc command strings out. Covers the cap arithmetic
(pack_rects), coarse/refine planning, leg splitting, waypoint allocation,
and confirm block shape.
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from roadplan.emit import (  # noqa: E402
    allocate_waypoints, confirm_blocks, coarse_plan, pack_rects, refine_plan,
    sample_commands, _split_leg,
)


def _rect_cells(r):
    return (r["x2"] - r["x1"] + 1) * (r["z2"] - r["z1"] + 1)


def test_pack_rects_respects_cap_and_span():
    # A dense 60x60 block: must split into rects each <=512 cells, <=48 span.
    cells = [(x, z) for x in range(60) for z in range(60)]
    rects = pack_rects(cells, cap=512, max_span=48)
    assert rects
    for r in rects:
        assert _rect_cells(r) <= 512, r
        assert r["x2"] - r["x1"] + 1 <= 48
        assert r["z2"] - r["z1"] + 1 <= 48


def test_pack_rects_single_cell():
    rects = pack_rects([(5, 7)])
    assert rects == [{"x1": 5, "z1": 7, "x2": 5, "z2": 7, "move": (5, 7)}]


def test_pack_rects_empty():
    assert pack_rects([]) == []


def test_pack_rects_move_is_center():
    rects = pack_rects([(0, 0), (10, 20)], cap=512, max_span=48)
    assert len(rects) == 1
    assert rects[0]["move"] == (5, 10)


def test_coarse_plan_skips_known_cells():
    start, end = (0, 0), (0, 10)
    swath = 3
    # First plan: nothing known -> rects cover the swath.
    rects = coarse_plan(set(), start, end, swath)
    assert rects
    covered = set()
    for r in rects:
        for x in range(r["x1"], r["x2"] + 1):
            for z in range(r["z1"], r["z2"] + 1):
                covered.add((x, z))
    # Mark everything covered as known -> next plan is empty (converged).
    assert coarse_plan(covered, start, end, swath) == []


def test_coarse_plan_partial_known_requests_remainder():
    start, end = (0, 0), (0, 20)
    rects = coarse_plan({(0, 0), (0, 1)}, start, end, 1)
    requested = set()
    for r in rects:
        for z in range(r["z1"], r["z2"] + 1):
            for x in range(r["x1"], r["x2"] + 1):
                requested.add((x, z))
    assert (0, 0) not in requested and (0, 1) not in requested
    assert (0, 10) in requested


def test_refine_plan_packs_requests():
    reqs = [{"x": 0, "z": z, "reason": "swath"} for z in range(10)]
    rects = refine_plan(reqs)
    assert sum(_rect_cells(r) for r in rects) >= 10


def test_sample_commands_shape():
    rects = [{"x1": -2, "z1": 0, "x2": 2, "z2": 8, "move": (0, 4)}]
    lines = sample_commands(rects, "/tmp/L", y=66)
    # Approach via goto_near (tolerant of inexact Y), then sample + ingest.
    assert lines[0] == "mc goto_near 0 66 4 8"
    assert lines[1] == (
        "mc corridor_sample -2 0 2 8 full=true --json "
        "| roadplan --ledger /tmp/L ingest")


def test_split_leg_under_cap_is_single():
    assert _split_leg((0, 0), (0, 50)) == [((0, 0), (0, 50))]


def test_split_leg_over_cap_splits():
    segs = _split_leg((0, 0), (0, 200), max_len=96)
    assert len(segs) > 1
    # Consecutive and covering the full span.
    assert segs[0][0] == (0, 0)
    assert segs[-1][1] == (0, 200)
    for a, b in segs:
        # each sub-leg <= 96 cells
        assert abs(b[1] - a[1]) + 1 <= 96


def _state_with_route(waypoints, start=(0, 0)):
    return {
        "endpoints": {"start": list(start), "end": list(waypoints[-1])},
        "routes": [{"waypoints": [list(w) for w in waypoints]}],
    }


def test_allocate_waypoints_names_and_idempotent():
    state = _state_with_route([(0, 64, 0), (5, 65, 10), (10, 66, 20)])
    allocate_waypoints(state, (0, 0))
    names = [w["name"] for w in state["waypoints"]]
    assert names == ["wp_1", "wp_2", "wp_3"]
    assert all(w["status"] == "proposed" for w in state["waypoints"])
    # Re-running with the same route adds nothing.
    allocate_waypoints(state, (0, 0))
    assert [w["name"] for w in state["waypoints"]] == ["wp_1", "wp_2", "wp_3"]


def test_confirm_blocks_emits_unconfirmed_only():
    state = _state_with_route([(0, 64, 0), (5, 65, 10)])
    allocate_waypoints(state, (0, 0))
    blocks, n_conf, n_total = confirm_blocks(state, (0, 0), "Mox", "/tmp/L")
    assert n_conf == 0 and n_total == 2
    assert len(blocks) == 2
    # First waypoint block: move, waypoint+ingest, survey+ingest, promote.
    b0 = blocks[0]
    assert b0[0] == "mc goto_near 0 64 0 2"   # stand ADJACENT, not on the cell
    assert b0[1].startswith("mc waypoint wp_1 0 64 0 --json")
    assert "roadplan --ledger /tmp/L ingest" in b0[1]
    assert b0[2].startswith("mc survey_line 0 0 0 0 --json")
    assert b0[-1] == "roadplan promote wp_1 --bot Mox"
    # Mark wp_1 confirmed -> only wp_2 remains.
    state["waypoints"][0]["status"] = "confirmed"
    blocks2, n_conf2, _ = confirm_blocks(state, (0, 0), "Mox", "/tmp/L")
    assert n_conf2 == 1
    assert len(blocks2) == 1
    assert blocks2[0][1].startswith("mc waypoint wp_2")


def test_confirm_blocks_prev_is_preceding_waypoint():
    state = _state_with_route([(0, 64, 0), (5, 65, 10)])
    allocate_waypoints(state, (0, 0))
    blocks, _, _ = confirm_blocks(state, (0, 0), "Mox", "/tmp/L")
    # Second waypoint's survey runs from wp_1 (0,0) to wp_2 (5,10).
    survey = next(L for L in blocks[1] if L.startswith("mc survey_line"))
    assert survey.startswith("mc survey_line 0 0 5 10 --json")


def test_confirm_near_end_walks_in_reverse():
    # Chain wp_1..wp_3; bot near the END (wp_3). Confirm should start at wp_3
    # (no long backtrack to wp_1) and walk back toward the start.
    state = _state_with_route([(0, 64, 0), (5, 65, 10), (10, 66, 20)],
                              start=(0, 0))
    allocate_waypoints(state, (0, 0))
    blocks, _, _ = confirm_blocks(state, (0, 0), "Mox", "/tmp/L",
                                  near=(10, 20), end=(10, 20))
    first_wp = next(L for L in blocks[0] if L.startswith("mc waypoint"))
    assert first_wp.startswith("mc waypoint wp_3 "), first_wp
    # First survey leg runs from the END endpoint to wp_3 (short).
    first_survey = next(L for L in blocks[0] if L.startswith("mc survey_line"))
    assert first_survey.startswith("mc survey_line 10 20 10 20")


def test_confirm_near_start_walks_forward():
    state = _state_with_route([(0, 64, 0), (5, 65, 10), (10, 66, 20)],
                              start=(0, 0))
    allocate_waypoints(state, (0, 0))
    blocks, _, _ = confirm_blocks(state, (0, 0), "Mox", "/tmp/L",
                                  near=(0, 0), end=(10, 20))
    first_wp = next(L for L in blocks[0] if L.startswith("mc waypoint"))
    assert first_wp.startswith("mc waypoint wp_1 "), first_wp

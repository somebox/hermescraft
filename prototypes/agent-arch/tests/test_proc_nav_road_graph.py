"""Proc-scout-road graph contracts (two-bot corridor)."""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "prototypes" / "agent-arch"))

from capstone.author import author_colony_lane  # noqa: E402
from capstone.graph_loader import load_graph  # noqa: E402
from capstone.proc_scout_road_graph import (  # noqa: E402
    ROAD_CENTERLINE_BLOCKS_CATALOG,
    ROAD_SEGMENT_COUNT,
    ROAD_WIDTH_M,
)
from capstone.road_config import road_segments  # noqa: E402
from capstone.wheat_graph import EPIC_BOT  # noqa: E402


def test_road_graph_card_count():
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    expected = 3 + ROAD_SEGMENT_COUNT * 2 + 2
    assert len(g.cards) == expected
    slugs = [c.slug for c in g.cards]
    assert slugs[0] == "pn-plan"
    assert slugs[-1] == "pn-plan-2"
    assert f"pn-meas-{ROAD_SEGMENT_COUNT}" in slugs


def test_four_segments_agent_midpoints():
    assert ROAD_CENTERLINE_BLOCKS_CATALOG == 48
    assert ROAD_SEGMENT_COUNT == 4
    segs = road_segments()
    assert len(segs) == 4
    assert segs[0][1:] == ("overlook", "road_bound_1")
    assert segs[-1][1:] == ("road_bound_3", "return_post")


def test_road_cites_width_and_agent_marks():
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    plan = next(c for c in g.cards if c.slug == "pn-plan")
    assert str(ROAD_WIDTH_M) in plan.body
    assert "road_bound_1" in plan.body
    assert "return_post" in plan.body
    explore = next(c for c in g.cards if c.slug == "pn-explore")
    assert "mc mark" in explore.body
    assert "road_bound" in explore.body


def test_dual_bot_alternation():
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    inv = author_colony_lane(g, epic_bot=EPIC_BOT, board="proc-nav-lab")
    by_slug = {i.slug: i for i in inv}
    assert "[bot:mox]" in by_slug["pn-meas-1"].cmd[-1].lower()
    assert "[bot:pip]" in by_slug["pn-meas-2"].cmd[-1].lower()


def test_parallel_measure_same_parent():
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    by_slug = {c.slug: c for c in g.cards}
    for n in range(1, ROAD_SEGMENT_COUNT + 1):
        assert by_slug[f"pn-meas-{n}"].depends_on == ("pn-segments",)


def test_clear_depends_own_measure_only():
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    by_slug = {c.slug: c for c in g.cards}
    for n in range(1, ROAD_SEGMENT_COUNT + 1):
        assert by_slug[f"pn-clear-{n}"].depends_on == (f"pn-meas-{n}",)


def test_planner_cites_road_plan_and_length():
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    plan = next(c for c in g.cards if c.slug == "pn-plan")
    assert "road_plan" in plan.body
    assert "48" in plan.body
    assert "ground-anchored" in plan.body


def test_explore_card_enforces_target_y_from_terrain_top():
    """The scout/explore card must derive target_y from terrain_top median,
    NOT from the catalog overlook/return_post Y. This is the root cause of the
    Y=67 propagation observed in run proc-nav-1780970837 (postmortem R2)."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    explore = next(c for c in g.cards if c.slug == "pn-explore")
    body = explore.body.lower()
    assert "mc terrain_top" in body, "explore card must instruct terrain_top sampling"
    assert "median" in body, "explore card must mention median (target_y derivation)"
    assert "elevation_median" in body, "explore must emit elevation_median in corridor_profile"
    assert "never" in body and "catalog" in body, (
        "explore card must explicitly forbid using catalog endpoint Y as target_y"
    )


def test_measure_cards_enforce_target_y_from_terrain_top():
    """Each pn-meas-N card must require the agent to compute target_y from
    terrain_top samples, run a level_ground dispositions check, and emit
    passage = dig|fill|deck|reroute. Pins the doctrine fix from the same
    postmortem."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    for n in range(1, ROAD_SEGMENT_COUNT + 1):
        meas = next(c for c in g.cards if c.slug == f"pn-meas-{n}")
        body = meas.body.lower()
        assert "terrain_top" in body, f"meas-{n} must require terrain_top sampling"
        assert "median" in body, f"meas-{n} must derive target_y as median"
        assert "level_ground" in body, f"meas-{n} must run level_ground dispositions check"
        assert "dispositions" in body, f"meas-{n} must read dispositions output"
        assert "deck" in body and "reroute" in body, (
            f"meas-{n} must enumerate passage options including deck and reroute"
        )
        assert "catalog" in body, (
            f"meas-{n} must explicitly forbid catalog Y (anti-pattern from W2-NAV-001)"
        )


def test_segment_table_planner_enforces_target_y_from_elevation_median():
    """The pn-segments planner card produced road_plan.json with
    target_y=67 in proc-nav-1780989125 despite the scout having computed
    elevation_median=80 — because its card body only said 'merge elevation'
    without specifying which value to use. This test pins the bite criterion
    that the postmortem identified."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    plan = next(c for c in g.cards if c.slug == "pn-segments")
    body = plan.body.lower()
    assert "elevation_median" in body, (
        "pn-segments must reference elevation_median as the target_y source"
    )
    assert "never" in body and ("catalog" in body or "overlook" in body), (
        "pn-segments must explicitly forbid copying catalog endpoint Y as target_y"
    )
    assert "catalog_y_drift" in body, (
        "pn-segments must require an obstacles[] entry when catalog Y drifts from median"
    )
    assert "target_y_default" in body or "road_plan.target_y" in body, (
        "pn-segments must explicitly bind target_y_default to elevation_median"
    )


def test_segment_plan_writes_to_persistent_path():
    """W2-NAV-008 fix: pn-segments must write road_plan.json to a persistent
    path (data/runtime/...) not its ephemeral workspace, so downstream
    measure/clear cards can read it after the planner workspace is GC'd."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    plan = next(c for c in g.cards if c.slug == "pn-segments")
    assert "data/runtime/proc-nav-road-plan.json" in plan.body, (
        "pn-segments must instruct planner to write road_plan to "
        "data/runtime/proc-nav-road-plan.json (persistent across workspace GC)"
    )
    assert "$HERMESCRAFT_REPO" in plan.body, (
        "pn-segments must resolve the write path via $HERMESCRAFT_REPO"
    )


def test_measure_and_clear_read_road_plan_from_persistent_path():
    """Each pn-meas-N and pn-clear-N must read the road_plan from
    data/runtime/proc-nav-road-plan.json, not the planner's ephemeral
    workspace. This is the consumer side of W2-NAV-008."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    persistent_path = "data/runtime/proc-nav-road-plan.json"
    for n in range(1, ROAD_SEGMENT_COUNT + 1):
        meas = next(c for c in g.cards if c.slug == f"pn-meas-{n}")
        assert persistent_path in meas.body, (
            f"pn-meas-{n} must read road_plan from {persistent_path}"
        )
        clear = next(c for c in g.cards if c.slug == f"pn-clear-{n}")
        assert persistent_path in clear.body, (
            f"pn-clear-{n} must read road_plan from {persistent_path}"
        )


def test_measure_cards_contain_literal_terrain_top_calls():
    """Pip in proc-nav-1780989125 accepted the planner's target_y=67
    uncritically; Mox correctly rejected it. The difference was judgment.
    Mitigation: replace procedural 'mc terrain_top X Z' with literal
    commands per segment. Literal commands are harder to skip than
    procedure text."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    # Segments along +Z, each 12 blocks long starting at z = (id-1)*12.
    # x ∈ {-1, 0, 1} for the 3-wide cross-section.
    for n in range(1, ROAD_SEGMENT_COUNT + 1):
        meas = next(c for c in g.cards if c.slug == f"pn-meas-{n}")
        body = meas.body
        z_start = (n - 1) * 12
        z_mid = z_start + 6
        z_end = z_start + 12
        # All 9 literal terrain_top calls (3 z × 3 x) must appear verbatim.
        for z in (z_start, z_mid, z_end):
            for x in (-1, 0, 1):
                literal = f"mc terrain_top {x} {z}"
                assert literal in body, (
                    f"pn-meas-{n} must include the literal '{literal}' "
                    f"(not a procedural 'mc terrain_top X Z at start/mid/end')"
                )


def test_clear_cards_use_new_road_primitives():
    """Builders should compose with mc clear_strip + mc level_ground
    (the new road-tier verbs), not invent their own dig+fill choreography.
    Pins this so a future regression to the old prose card body
    ('repeat standard clear contract: dig/fill/stairs per obstacles')
    fails fast."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    for n in range(1, ROAD_SEGMENT_COUNT + 1):
        clear = next(c for c in g.cards if c.slug == f"pn-clear-{n}")
        body = clear.body
        assert "mc clear_strip" in body, (
            f"pn-clear-{n} must instruct mc clear_strip (the new tree+headroom verb)"
        )
        assert "road_mode=true" in body, (
            f"pn-clear-{n} must set road_mode=true so wood is cleared, not preserved"
        )
        assert "mc level_ground" in body, (
            f"pn-clear-{n} must instruct mc level_ground (with execute=true) for the bed"
        )
        assert "mc deck" in body, (
            f"pn-clear-{n} must mention mc deck as the deep-dip/ravine option"
        )

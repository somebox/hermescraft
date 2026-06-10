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
    ROAD_CORRIDOR_X_MAX,
    ROAD_CORRIDOR_X_MIN,
    ROAD_CORRIDOR_Z_START,
    ROAD_SEGMENT_COUNT,
    ROAD_SEGMENT_LENGTH,
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


def test_segments_correct_count_and_endpoint_marks():
    """Test pulls config-driven values rather than hardcoded counts so a
    legitimate bump (48→96 blocks, 4→8 segments on 2026-06-09) doesn't
    require editing the test alongside the config."""
    segs = road_segments()
    assert len(segs) == ROAD_SEGMENT_COUNT
    assert segs[0][1] == "overlook"
    assert segs[-1][2] == "return_post"
    # Interior boundary marks: road_bound_1 .. road_bound_(N-1).
    if ROAD_SEGMENT_COUNT > 1:
        assert segs[0][2] == "road_bound_1"
        assert segs[-1][1] == f"road_bound_{ROAD_SEGMENT_COUNT - 1}"


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
    """The scout/explore card must derive target_y from a real terrain sample
    median, NOT from the catalog overlook/return_post Y. This is the root cause
    of the Y=67 propagation observed in run proc-nav-1780970837 (postmortem R2).
    As of W2-NAV-018 follow-up the sampling verb is mc corridor_sample (batch
    terrain_top with exclude_foliage)."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    explore = next(c for c in g.cards if c.slug == "pn-explore")
    body = explore.body.lower()
    assert "mc corridor_sample" in body or "mc terrain_top" in body, (
        "explore card must instruct one of: mc corridor_sample (preferred) or "
        "mc terrain_top (legacy) for the surface sampling"
    )
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


def test_measure_cards_contain_literal_corridor_sample_call():
    """Replaces the 9-call mc terrain_top loop with a single mc corridor_sample.
    Same intent: a literal command per segment is harder to skip than a
    procedure description (Pip in proc-nav-1780989125 accepted the planner's
    target_y=67 uncritically). Coords are livemap-derived (proc-nav-1781079999
    fix): X from corridor centerline, Z anchored at overlook (not catalog
    origin). corridor_sample defaults to exclude_foliage=true so tree canopies
    don't read as ground (W2-NAV-015)."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    for n in range(1, ROAD_SEGMENT_COUNT + 1):
        meas = next(c for c in g.cards if c.slug == f"pn-meas-{n}")
        body = meas.body
        z_start = ROAD_CORRIDOR_Z_START + (n - 1) * ROAD_SEGMENT_LENGTH
        z_end = z_start + ROAD_SEGMENT_LENGTH
        literal = (
            f"mc corridor_sample {ROAD_CORRIDOR_X_MIN} {z_start} "
            f"{ROAD_CORRIDOR_X_MAX} {z_end}"
        )
        assert literal in body, (
            f"pn-meas-{n} must include the literal '{literal}' so the agent samples "
            f"the segment in one round-trip in livemap coords"
        )


def test_measure_cards_pin_target_y_to_corridor_median():
    """W2-NAV-017 fix. Measure cards must say target_y MUST equal corridor median
    (allowing a per-segment override only when divergence >= 2). The prior trial
    produced 78, 79, 78, 78 per-segment medians, creating ±1 boundary steps
    at z=12, 24, 36."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    for n in range(1, ROAD_SEGMENT_COUNT + 1):
        meas = next(c for c in g.cards if c.slug == f"pn-meas-{n}")
        body = meas.body
        assert "MUST equal" in body, (
            f"pn-meas-{n} must use 'MUST equal' language for target_y discipline "
            f"(soft 'may revise' produced ±1 boundary steps in trial 1780994801)"
        )
        assert "corridor_median" in body, (
            f"pn-meas-{n} must reference corridor_median as the pinned target_y source"
        )
        assert "segment_y_anomaly" in body, (
            f"pn-meas-{n} must require segment_y_anomaly obstacle when divergence ≥ 2"
        )


def test_explore_card_uses_corridor_sample():
    """W2-NAV-018 + feedback efficiency. The scout's corridor walk should use
    mc corridor_sample (one call) instead of N individual mc terrain_top calls.
    Both navigators independently requested this verb. exclude_foliage is now
    the default (proc-nav-1781079999 doctrine flip), so the explicit flag is
    no longer required."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    explore = next(c for c in g.cards if c.slug == "pn-explore")
    body = explore.body
    assert "mc corridor_sample" in body, (
        "pn-explore must call mc corridor_sample for the full-corridor survey"
    )


def test_verify_card_runs_dispositions_sweep_and_can_emit_cleanup():
    """W2-NAV-018 fix. The verify card must re-run mc level_ground dispositions
    across the full corridor and emit a [CLEANUP] kanban card on failure.
    Trial proc-nav-1780994801 had verify pass despite ±1 cells still un-leveled
    because verify only checked anchors."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    verify = next(c for c in g.cards if c.slug == "pn-road-verify")
    body = verify.body
    assert "mc level_ground" in body, (
        "verify card must run mc level_ground for a dispositions sweep"
    )
    assert "dispositions" in body, (
        "verify card must reference dispositions in its assertion"
    )
    # exclude_foliage is now the default (proc-nav-1781079999 doctrine flip),
    # so the explicit flag is no longer required in the verify sweep.
    assert "[CLEANUP]" in body, (
        "verify card must mention [CLEANUP] kanban card emission on failure"
    )
    assert "kanban_create" in body, (
        "verify card must instruct kanban_create for the follow-up CLEANUP card"
    )
    # Per-segment sweeps must be literally present (one per segment).
    for n in range(1, ROAD_SEGMENT_COUNT + 1):
        z_start = ROAD_CORRIDOR_Z_START + (n - 1) * ROAD_SEGMENT_LENGTH
        z_end = z_start + ROAD_SEGMENT_LENGTH
        literal = (
            f"mc level_ground {ROAD_CORRIDOR_X_MIN} {z_start} "
            f"{ROAD_CORRIDOR_X_MAX} {z_end} target=<target_y>"
        )
        assert literal in body, (
            f"verify card must include the literal '{literal}' for segment {n}"
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
        # Y-vocabulary contract (surface-y migration phase 1): the bed Y is a
        # block_y and must be passed as y=, never surface_y= (clear_strip
        # rejects surface_y while its semantics migrate to canonical feet).
        assert "y=<target_y>" in body, (
            f"pn-clear-{n} must pass the bed as y=<target_y> (block_y)"
        )
        assert "surface_y=<target_y>" not in body, (
            f"pn-clear-{n} must NOT pass surface_y= to clear_strip — the param "
            f"is rejected during the Y-semantics migration"
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
def test_card_bodies_use_livemap_corridor_geometry():
    """proc-nav-1781079999 hypothesis A+B fix. Pre-fix, _meas_body and
    _clear_body hardcoded catalog coords (X=-1..1, Z=(seg-1)*12); the
    materialized world placed the corridor at livemap X=-21..-19,
    Z=-12..84, so every segment card was off-by-12 in Z and off-by-20 in
    X versus road_plan.json. Workers spent 1-2 orientation rounds per card
    reconciling. This test pins the corridor geometry to last-scenario-map.json
    placements so seg-1 = Z=-12..0, seg-2 = Z=0..12, ... and X bounds align
    with the corridor centerline."""
    g = load_graph("proc-scout-road", repo_root=REPO_ROOT)
    for n in range(1, ROAD_SEGMENT_COUNT + 1):
        meas = next(c for c in g.cards if c.slug == f"pn-meas-{n}")
        clear = next(c for c in g.cards if c.slug == f"pn-clear-{n}")
        z_start = ROAD_CORRIDOR_Z_START + (n - 1) * ROAD_SEGMENT_LENGTH
        z_end = z_start + ROAD_SEGMENT_LENGTH

        # Measure card header: "Z≈{z_start}) → ... (Z≈{z_end})"
        assert f"Z≈{z_start}" in meas.body, (
            f"pn-meas-{n}: header must cite Z≈{z_start} (livemap), got body without it"
        )
        assert f"Z≈{z_end}" in meas.body, (
            f"pn-meas-{n}: header must cite Z≈{z_end} (livemap), got body without it"
        )
        # Clear card scope preamble: "Z={z_start}..{z_end} (X={x_min}..{x_max})"
        assert f"Z={z_start}..{z_end}" in clear.body, (
            f"pn-clear-{n}: scope must cite Z={z_start}..{z_end} (livemap)"
        )
        assert f"X={ROAD_CORRIDOR_X_MIN}..{ROAD_CORRIDOR_X_MAX}" in clear.body, (
            f"pn-clear-{n}: scope must cite X={ROAD_CORRIDOR_X_MIN}..{ROAD_CORRIDOR_X_MAX} (livemap)"
        )
        # Body should not still carry the broken catalog coords.
        assert "X=-1..1" not in clear.body, (
            f"pn-clear-{n}: must not hardcode X=-1..1 (catalog) — use livemap from "
            f"road_plan / last-scenario-map.json"
        )

from unittest.mock import patch

import json
import pytest

from mapcatalog.find_run import find_results
from mapcatalog.models import Arena, FindSpec, Requirements
from mapcatalog.pass1 import Pass1Result
from mapcatalog.pass1_options import Pass1Options
from mapcatalog.placements import parse_placement_value
from mapcatalog.server_config import ServerConfig
from mapcatalog.try_run import TryOutcome
from mapcatalog.verify_live import should_run_verify_live


def _req() -> Requirements:
    return Requirements(
        id="test_find",
        path="x",
        arena=Arena((0, 0), 32),
        gates=[],
        placements=[parse_placement_value("spawn", "random_safe radius 1 attempts 8")],
        find=FindSpec(solutions=2, max_seeds=10),
    )


def _cfg() -> ServerConfig:
    return ServerConfig(
        minecraft_version="1.21.4",
        ssh_host="h",
        container="c",
        cli="rcon-cli",
        world_name="proc-lab",
        generator="NORMAL",
        hub_world="landfolk-test",
        hub_xyz=(0, 65, 0),
        use_unsafe_mvtp=True,
    )


@pytest.mark.unit
def test_find_stops_at_target_solutions(tmp_path):
    calls = {"n": 0}

    def fake_try(*_a, **_k):
        calls["n"] += 1
        seed = str(calls["n"])
        if calls["n"] <= 2:
            return TryOutcome({"ok": True, "seed": seed, "requirements_id": "test_find"}, 0)
        return TryOutcome({"ok": False, "seed": seed, "stage": "pass1", "reasons": ["x"]}, 1)

    out = tmp_path / "catalog"
    with patch("mapcatalog.find_run.try_seed", side_effect=fake_try):
        report = find_results(_req(), _cfg(), out, write_rejects=False)
    assert report.ok
    assert report.stats.accepts == 2
    assert len(report.paths) == 2
    assert report.lint_actual["pass2_materializations"] == 2.0


@pytest.mark.unit
def test_find_solutions_override_and_max_seeds(tmp_path, capsys):
    calls = {"n": 0}

    def fake_try(*_a, **_k):
        calls["n"] += 1
        return TryOutcome(
            {"ok": False, "seed": str(calls["n"]), "stage": "pass1", "reasons": ["x"]},
            1,
        )

    out = tmp_path / "catalog"
    import io

    prog = io.StringIO()
    with patch("mapcatalog.find_run.try_seed", side_effect=fake_try):
        report = find_results(
            _req(),
            _cfg(),
            out,
            solutions=1,
            max_seeds=3,
            write_rejects=False,
            progress_stream=prog,
        )
    assert not report.ok
    assert report.stats.seeds_tried == 3
    assert report.target_solutions == 1
    assert report.max_seeds_limit == 3
    state = json.loads((out / ".find_state.json").read_text())
    assert state["seeds_tried"] == 3
    assert "find[test_find] try 1/3" in prog.getvalue()


@pytest.mark.unit
def test_find_json_lines_emits_per_seed(tmp_path):
    calls = {"n": 0}

    def fake_try(*_a, **_k):
        calls["n"] += 1
        return TryOutcome(
            {"ok": False, "seed": "1", "stage": "pass1", "reasons": ["x"]},
            1,
        )

    out = tmp_path / "catalog"
    import io

    jl = io.StringIO()
    with patch("mapcatalog.find_run.try_seed", side_effect=fake_try):
        find_results(
            _req(),
            _cfg(),
            out,
            solutions=5,
            max_seeds=1,
            write_rejects=False,
            json_lines_stream=jl,
            quiet=True,
        )
    lines = [json.loads(ln) for ln in jl.getvalue().strip().splitlines()]
    assert len(lines) == 1
    assert lines[0]["type"] == "seed"
    assert lines[0]["seeds_tried"] == 1


@pytest.mark.unit
def test_find_tries_seed_candidates_first():
    from mapcatalog.find_run import _iter_find_seeds
    import random

    req = _req()
    req.find.seed_candidates = ["800", "2024"]
    rng = random.Random(0)
    it = _iter_find_seeds(req, rng)
    seeds = [next(it) for _ in range(4)]
    assert seeds[0] == "800"
    assert seeds[1] == "2024"
    assert seeds[2] != seeds[3]


@pytest.mark.unit
def test_verify_live_runs_on_cubiomes_pass():
    from mapcatalog.gates import parse_gate_line
    from mapcatalog.load import load_requirements
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    req = load_requirements(root / "requirements/mine_plains_iron.yaml")
    p1 = Pass1Result(
        continue_pass2=True,
        metrics={"biome_fraction": 0.9},
        audit={"rejected": False},
    )
    opts = Pass1Options(verify_live=True, verify_live_when="always")
    assert should_run_verify_live(p1, req, opts)

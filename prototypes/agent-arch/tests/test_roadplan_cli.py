"""`roadplan` CLI — ingest loud-failure contract + render/solve smoke (S2).

Contract under test (plan §8.0.3): on success exactly one stdout line
`ingested <N> cells`, exit 0. On every enumerated failure case — empty
stdin, error envelope, garbage, partial JSON, payload missing samples —
exit ≠0 with NO `ingested` line.
"""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from roadplan.cli import main  # noqa: E402
from roadplan.fixtures import build_all, samples_from_fixture  # noqa: E402
from roadplan.ledger import read_state, samples_for_solver  # noqa: E402
from roadplan.spec import load_spec  # noqa: E402

SPEC = load_spec()


def _envelope_for(fx):
    """Synthesize the corridor_sample envelope a worker would pipe in."""
    samples = []
    for col in fx["columns"]:
        # The K1 sampler is the source of truth — use it so kind mapping is
        # exercised end-to-end via block_name, not pre-derived.
        ksample = next(
            s for s in samples_from_fixture(fx, SPEC)
            if s["x"] == col["x"] and s["z"] == col["z"])
        if ksample["kind"] == "gap":
            block_name, surface_y, block_y = None, None, None
        elif ksample["kind"] == "water":
            block_name, surface_y, block_y = "water", ksample["y"], None
        elif ksample["kind"] == "tree":
            block_name, surface_y, block_y = "oak_log", ksample["y"], None
        else:
            block_name, surface_y, block_y = (
                "grass_block", ksample["y"], int(ksample["y"] - 1))
        samples.append({"x": col["x"], "z": col["z"],
                        "block_y": block_y, "surface_y": surface_y,
                        "block_name": block_name})
    return {
        "ok": True,
        "bot": "tester",
        "data": {
            "bounds": {"x1": -2, "z1": 0, "x2": 2, "z2": 31},
            "step": 1,
            "samples": samples,
        },
    }


def _run(args, stdin="", capsys=None, monkeypatch=None):
    if monkeypatch is not None:
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    rc = main(args)
    out, err = capsys.readouterr()
    return rc, out, err


def test_ingest_empty_stdin_loud_fails(tmp_path, capsys, monkeypatch):
    rc, out, err = _run(["--ledger", str(tmp_path), "ingest"],
                        stdin="", capsys=capsys, monkeypatch=monkeypatch)
    assert rc != 0
    assert "ingested" not in out
    assert "no envelope" in err


def test_ingest_error_envelope_loud_fails(tmp_path, capsys, monkeypatch):
    env = {"ok": False, "error": {"code": "NO_SURFACE",
                                  "message": "chunks unloaded?"}}
    rc, out, err = _run(["--ledger", str(tmp_path), "ingest"],
                        stdin=json.dumps(env),
                        capsys=capsys, monkeypatch=monkeypatch)
    assert rc != 0
    assert "ingested" not in out
    assert "NO_SURFACE" in err


def test_ingest_flat_string_error_envelope_loud_fails(
        tmp_path, capsys, monkeypatch):
    # mc's flat error shape: error is a top-level string, code a sibling
    # (e.g. `mc waypoint` with no torch). Must loud-fail, not crash.
    env = {"ok": False, "error": "No torch in inventory.",
           "error_type": "missing_item", "code": "INVENTORY_MISSING"}
    rc, out, err = _run(["--ledger", str(tmp_path), "ingest"],
                        stdin=json.dumps(env),
                        capsys=capsys, monkeypatch=monkeypatch)
    assert rc != 0
    assert "ingested" not in out
    assert "INVENTORY_MISSING" in err


def test_ingest_garbage_loud_fails(tmp_path, capsys, monkeypatch):
    rc, out, err = _run(["--ledger", str(tmp_path), "ingest"],
                        stdin="not json at all",
                        capsys=capsys, monkeypatch=monkeypatch)
    assert rc != 0
    assert "ingested" not in out
    assert "malformed JSON" in err


def test_ingest_partial_json_loud_fails(tmp_path, capsys, monkeypatch):
    rc, out, err = _run(["--ledger", str(tmp_path), "ingest"],
                        stdin='{"ok": true, "data":',
                        capsys=capsys, monkeypatch=monkeypatch)
    assert rc != 0
    assert "ingested" not in out
    assert "malformed JSON" in err


def test_ingest_envelope_without_samples_loud_fails(
        tmp_path, capsys, monkeypatch):
    # corridor_sample default full=false returns aggregates only.
    env = {"ok": True, "data": {"bounds": {}, "elevation_median": 64}}
    rc, out, err = _run(["--ledger", str(tmp_path), "ingest"],
                        stdin=json.dumps(env),
                        capsys=capsys, monkeypatch=monkeypatch)
    assert rc != 0
    assert "ingested" not in out
    assert "no recognized cell payload" in err


def test_ingest_happy_path_writes_ledger(tmp_path, capsys, monkeypatch):
    fx = build_all()["river"]
    env = _envelope_for(fx)
    rc, out, err = _run(["--ledger", str(tmp_path), "ingest"],
                        stdin=json.dumps(env),
                        capsys=capsys, monkeypatch=monkeypatch)
    assert rc == 0, err
    assert out.strip() == f"ingested {len(env['data']['samples'])} cells"
    assert (tmp_path / "samples.jsonl").exists()
    cells = samples_for_solver(tmp_path)
    kinds = {(s["x"], s["z"]): s["kind"] for s in cells}
    # The river fixture has a 4-block water gap centered on z=14..17.
    for z in range(14, 18):
        assert kinds[(0, z)] == "water"
    assert kinds[(0, 0)] == "ground"


def test_ingest_accepts_jsonl_batch(tmp_path, capsys, monkeypatch):
    fx = build_all()["flat"]
    env = _envelope_for(fx)
    # Two envelopes back-to-back as JSONL: ledger should accumulate.
    payload = json.dumps(env) + "\n" + json.dumps(env)
    rc, out, _ = _run(["--ledger", str(tmp_path), "ingest"],
                      stdin=payload, capsys=capsys, monkeypatch=monkeypatch)
    assert rc == 0
    n = len(env["data"]["samples"])
    assert out.strip() == f"ingested {2 * n} cells"


def test_solve_writes_state_and_render_shows_route(
        tmp_path, capsys, monkeypatch):
    fx = build_all()["river"]
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(_envelope_for(fx))))
    assert main(["--ledger", str(tmp_path), "ingest"]) == 0
    capsys.readouterr()

    rc = main(["--ledger", str(tmp_path), "solve",
               "--start", "0,0", "--end", "0,31"])
    out, err = capsys.readouterr()
    assert rc == 0, err
    assert "bridge" in out

    state = read_state(tmp_path)
    assert state["endpoints"] == {"start": [0, 0], "end": [0, 31]}
    assert state["routes"][-1]["route_class"] == "bridge"

    rc = main(["--ledger", str(tmp_path), "render"])
    art, err = capsys.readouterr()
    assert rc == 0, err
    assert "o" in art  # route overlay
    assert "~" in art  # water glyph
    assert "W" in art  # waypoints


def test_render_without_samples_loud_fails(tmp_path, capsys):
    rc = main(["--ledger", str(tmp_path), "render"])
    out, err = capsys.readouterr()
    assert rc != 0
    assert "no samples" in err


# ── sample subcommand (§6.1) ────────────────────────────────────────────

def test_sample_empty_ledger_emits_commands(tmp_path, capsys):
    rc = main(["--ledger", str(tmp_path), "sample", "0,0", "0,31"])
    out, err = capsys.readouterr()
    assert rc == 0
    lines = [L for L in out.splitlines() if L.strip()]
    assert lines and all(L.startswith("mc ") for L in lines)
    assert any(L.startswith("mc goto_near") for L in lines)
    assert any("corridor_sample" in L and "roadplan" in L for L in lines)
    assert "segment" in err  # status on stderr, not stdout


def _ground_envelope_for_bounds(x1, z1, x2, z2):
    """A corridor_sample envelope of flat ground over a rectangle — what a
    worker running the emitted `mc corridor_sample` line would pipe back."""
    samples = [{"x": x, "z": z, "block_y": 63, "surface_y": 64,
                "block_name": "grass_block"}
               for x in range(x1, x2 + 1) for z in range(z1, z2 + 1)]
    return {"ok": True, "bot": "mox", "data": {"samples": samples}}


def _bounds_from_sample_lines(out):
    """Parse `mc corridor_sample x1 z1 x2 z2 ...` lines into bound tuples."""
    bounds = []
    for line in out.splitlines():
        if line.startswith("mc corridor_sample"):
            toks = line.split()
            bounds.append(tuple(int(t) for t in toks[2:6]))
    return bounds


def test_sample_converges_after_running_emitted_commands(
        tmp_path, capsys, monkeypatch):
    # Round-trip: run `sample`, ingest exactly the rectangles it asked for,
    # then `sample` again must converge (nothing left to observe).
    rc = main(["--ledger", str(tmp_path), "sample", "0,0", "0,31"])
    out, _ = capsys.readouterr()
    assert rc == 0
    for x1, z1, x2, z2 in _bounds_from_sample_lines(out):
        env = _ground_envelope_for_bounds(x1, z1, x2, z2)
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(env)))
        assert main(["--ledger", str(tmp_path), "ingest"]) == 0
        capsys.readouterr()
    rc = main(["--ledger", str(tmp_path), "sample", "0,0", "0,31"])
    out, err = capsys.readouterr()
    assert rc == 0
    assert out.strip() == ""
    assert "converged" in err


def test_sample_refine_without_samples_loud_fails(tmp_path, capsys):
    rc = main(["--ledger", str(tmp_path), "sample", "0,0", "0,31", "--refine"])
    out, err = capsys.readouterr()
    assert rc != 0
    assert "coarse sample first" in err


def test_sample_refine_converged_when_fully_observed(
        tmp_path, capsys, monkeypatch):
    fx = build_all()["river"]
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(_envelope_for(fx))))
    main(["--ledger", str(tmp_path), "ingest"])
    main(["--ledger", str(tmp_path), "solve", "--start", "0,0", "--end", "0,31"])
    capsys.readouterr()
    rc = main(["--ledger", str(tmp_path), "sample", "0,0", "0,31", "--refine"])
    out, err = capsys.readouterr()
    assert rc == 0
    assert out.strip() == ""
    assert "converged" in err


# ── ingest extensions: survey_line + waypoint envelopes ─────────────────

def _survey_env(frm, to, *, walkable=True, deficits=None):
    return {
        "ok": True, "bot": "mox",
        "data": {
            "from": list(frm), "to": list(to),
            "runs": [{"kind": "walk", "length": 10}],
            "deficits": deficits or [],
            "walkable": walkable,
            "fix_commands": [],
            "envelope_schema": "roadplan-survey/v1",
        },
    }


def _waypoint_env(name, x, y, z):
    return {
        "ok": True, "bot": "mox",
        "data": {
            "waypoint": name,
            "position": {"x": x, "y": y, "z": z},
            "torch_at": {"x": x, "y": y, "z": z},
            "anchor_at": {"x": x, "y": y - 1, "z": z},
            "placement": "placed", "moved": False,
        },
    }


def test_ingest_survey_appends_observation_and_leg(
        tmp_path, capsys, monkeypatch):
    # A solved route in state.json so the leg can attach.
    fx = build_all()["river"]
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(_envelope_for(fx))))
    main(["--ledger", str(tmp_path), "ingest"])
    main(["--ledger", str(tmp_path), "solve", "--start", "0,0", "--end", "0,31"])
    capsys.readouterr()
    monkeypatch.setattr(
        "sys.stdin", io.StringIO(json.dumps(_survey_env((0, 0), (0, 10)))))
    rc = main(["--ledger", str(tmp_path), "ingest"])
    out, err = capsys.readouterr()
    assert rc == 0, err
    assert out.startswith("ingested survey")
    assert (tmp_path / "observations.jsonl").exists()
    state = read_state(tmp_path)
    leg = next(L for L in state["legs"]
               if L["from"] == [0, 0] and L["to"] == [0, 10])
    assert leg["status"] == "surveyed" and leg["walkable"] is True


def test_ingest_survey_error_envelope_still_loud(tmp_path, capsys, monkeypatch):
    env = {"ok": False, "error": {"code": "UNLOADED_CHUNKS",
                                  "message": "move closer"}}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(env)))
    rc = main(["--ledger", str(tmp_path), "ingest"])
    out, err = capsys.readouterr()
    assert rc != 0
    assert "ingested" not in out
    assert "UNLOADED_CHUNKS" in err


def test_ingest_waypoint_confirms_status(tmp_path, capsys, monkeypatch):
    fx = build_all()["river"]
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(_envelope_for(fx))))
    main(["--ledger", str(tmp_path), "ingest"])
    main(["--ledger", str(tmp_path), "solve", "--start", "0,0", "--end", "0,31"])
    # confirm allocates wp_* names into state.json (river=bridge -> --force)
    main(["--ledger", str(tmp_path), "confirm", "--bot", "Mox", "--force"])
    capsys.readouterr()
    state = read_state(tmp_path)
    wp = state["waypoints"][0]
    x, y, z = wp["pos"]
    monkeypatch.setattr(
        "sys.stdin", io.StringIO(json.dumps(_waypoint_env(wp["name"], x, y, z))))
    rc = main(["--ledger", str(tmp_path), "ingest"])
    out, err = capsys.readouterr()
    assert rc == 0, err
    assert out.startswith(f"ingested waypoint {wp['name']} confirmed")
    state2 = read_state(tmp_path)
    w2 = next(w for w in state2["waypoints"] if w["name"] == wp["name"])
    assert w2["status"] == "confirmed"
    assert w2["torch_at"] == [x, y, z]


# ── confirm subcommand (§6.4) ───────────────────────────────────────────

def _setup_route(tmp_path, monkeypatch):
    fx = build_all()["river"]
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(_envelope_for(fx))))
    main(["--ledger", str(tmp_path), "ingest"])
    main(["--ledger", str(tmp_path), "solve", "--start", "0,0", "--end", "0,31"])


def test_confirm_allocates_waypoints_and_emits_blocks(
        tmp_path, capsys, monkeypatch):
    _setup_route(tmp_path, monkeypatch)
    capsys.readouterr()
    rc = main(["--ledger", str(tmp_path), "confirm", "--bot", "Mox", "--force"])
    out, err = capsys.readouterr()
    assert rc == 0
    lines = [L for L in out.splitlines() if L.strip()]
    assert any(L.startswith("mc waypoint wp_1") for L in lines)
    assert any(L.startswith("roadplan promote wp_1 --bot Mox") for L in lines)
    state = read_state(tmp_path)
    names = [w["name"] for w in state["waypoints"]]
    assert names[0] == "wp_1" and len(names) == len(set(names))


def test_confirm_idempotent_names_and_skips_confirmed(
        tmp_path, capsys, monkeypatch):
    _setup_route(tmp_path, monkeypatch)
    main(["--ledger", str(tmp_path), "confirm", "--bot", "Mox", "--force"])
    state = read_state(tmp_path)
    names_first = [w["name"] for w in state["waypoints"]]
    # Confirm wp_1 via a waypoint ingest, then re-run confirm.
    wp = state["waypoints"][0]
    x, y, z = wp["pos"]
    monkeypatch.setattr(
        "sys.stdin", io.StringIO(json.dumps(_waypoint_env(wp["name"], x, y, z))))
    main(["--ledger", str(tmp_path), "ingest"])
    capsys.readouterr()
    rc = main(["--ledger", str(tmp_path), "confirm", "--bot", "Mox", "--force"])
    out, err = capsys.readouterr()
    assert rc == 0
    # Names stable across reruns; wp_1 no longer emitted.
    state2 = read_state(tmp_path)
    assert [w["name"] for w in state2["waypoints"]] == names_first
    assert "mc waypoint wp_1 " not in out


def test_confirm_without_route_loud_fails(tmp_path, capsys):
    rc = main(["--ledger", str(tmp_path), "confirm", "--bot", "Mox"])
    out, err = capsys.readouterr()
    assert rc != 0
    assert "no solved route" in err


def test_confirm_refuses_construction_route(tmp_path, capsys, monkeypatch):
    # river -> bridge: not yet walkable, so confirm must refuse and hand off.
    _setup_route(tmp_path, monkeypatch)
    capsys.readouterr()
    rc = main(["--ledger", str(tmp_path), "confirm", "--bot", "Mox"])
    out, err = capsys.readouterr()
    assert rc == 3
    assert out.strip() == ""              # no commands emitted
    assert "needs construction" in err
    assert "bridge" in err


def test_confirm_natural_route_no_force_needed(tmp_path, capsys, monkeypatch):
    # flat -> natural: walkable as-is, confirm proceeds without --force.
    fx = build_all()["flat"]
    zs = [c["z"] for c in fx["columns"]]
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(_envelope_for(fx))))
    main(["--ledger", str(tmp_path), "ingest"])
    main(["--ledger", str(tmp_path), "solve",
          "--start", f"0,{min(zs)}", "--end", f"0,{max(zs)}"])
    capsys.readouterr()
    rc = main(["--ledger", str(tmp_path), "confirm", "--bot", "Mox"])
    out, err = capsys.readouterr()
    assert rc == 0
    assert any(L.startswith("mc waypoint wp_1") for L in out.splitlines())

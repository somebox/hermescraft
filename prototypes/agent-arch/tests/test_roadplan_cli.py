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

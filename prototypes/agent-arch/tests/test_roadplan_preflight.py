"""roadplan preflight (Track S4) — checks return loud-fail / warn / ok
in the documented cases. The W1 env_passthrough lesson is exercised
indirectly via `check_worker_env_passthrough` (which can't reach into a
worker's shell — only report what's missing from the current one)."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from roadplan import preflight as pf  # noqa: E402
from roadplan.cli import main  # noqa: E402


def test_bin_wrapper_present_and_executable_in_real_repo():
    c = pf.check_bin_wrapper(REPO_ROOT)
    assert c.status == "ok", c.detail


def test_bin_wrapper_missing_loud_fails(tmp_path):
    c = pf.check_bin_wrapper(tmp_path)
    assert c.status == "fail"
    assert "bin/roadplan" in c.name


def test_bin_wrapper_not_executable_loud_fails(tmp_path):
    (tmp_path / "bin").mkdir()
    p = tmp_path / "bin" / "roadplan"
    p.write_text("#!/bin/sh\n")
    p.chmod(0o644)
    c = pf.check_bin_wrapper(tmp_path)
    assert c.status == "fail"
    assert "+x" in c.detail


def test_python_imports_subprocess_succeeds():
    c = pf.check_python_imports(REPO_ROOT)
    assert c.status == "ok", c.detail
    payload = json.loads(c.detail)
    assert all(payload.values())


def test_spec_file_loads_with_required_keys():
    c = pf.check_spec_file(REPO_ROOT)
    assert c.status == "ok", c.detail


def test_spec_file_missing_loud_fails(tmp_path):
    # No data/walkability-spec.json under the tmp root.
    c = pf.check_spec_file(tmp_path)
    assert c.status == "fail"


def test_ledger_writable_round_trips_state_json(tmp_path):
    c = pf.check_ledger_writable(tmp_path / "rp")
    assert c.status == "ok", c.detail
    # The probe must clean up — no leftover state.json.
    assert not (tmp_path / "rp" / "state.json").exists()


def test_worker_env_passthrough_reports_missing():
    c = pf.check_worker_env_passthrough(env={"PATH": "/usr/bin"})
    assert c.status == "warn"
    assert "MC_API_URL" in c.detail
    assert "MC_USERNAME" in c.detail


def test_worker_env_passthrough_ok_when_all_present():
    env = {"MC_API_URL": "http://127.0.0.1:3007",
           "MC_USERNAME": "Mox",
           "PATH": "/usr/bin"}
    c = pf.check_worker_env_passthrough(env=env)
    assert c.status == "ok"


def test_run_checks_real_repo_no_hard_failures():
    checks = pf.run_checks()
    assert checks, "no checks emitted"
    failures = [c for c in checks if c.status == "fail"]
    assert not failures, "\n".join(c.line() for c in failures)


def test_cli_preflight_exits_zero_human_output(capsys):
    rc = main(["preflight"])
    out, _ = capsys.readouterr()
    assert rc == 0
    assert "bin/roadplan executable" in out
    assert "walkability-spec.json schema" in out


def test_cli_preflight_json_mode(capsys):
    rc = main(["preflight", "--json"])
    out, _ = capsys.readouterr()
    assert rc == 0
    payload = json.loads(out)
    names = {c["name"] for c in payload}
    assert "bin/roadplan executable" in names
    assert "ledger writable" in names


def test_cli_preflight_loud_fails_on_broken_root(tmp_path, capsys):
    rc = main(["preflight", "--repo-root", str(tmp_path)])
    out, _ = capsys.readouterr()
    assert rc == 1
    assert "✗" in out

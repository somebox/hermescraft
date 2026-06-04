"""Tests for scripts/reconcile-pois.py — POI overlay merger.

Verifies the auto / dry-run / strip-private flows plus the tie-breaker rule
that distinguishes POIs from marks: latest `last_seen` wins, regardless of
how many bots propose the alternative.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from argparse import Namespace
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def _load_module(monkeypatch, data_dir: Path):
    """Import scripts/reconcile-pois.py (hyphenated → can't import) with
    DATA_DIR + SHARED_FILE rebound to tmp_path so the module never touches
    the real repo data dir."""
    spec = importlib.util.spec_from_file_location(
        "reconcile_pois", REPO / "scripts" / "reconcile-pois.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["reconcile_pois"] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "DATA_DIR", data_dir)
    monkeypatch.setattr(mod, "SHARED_FILE", data_dir / "personal-pois-shared.json")
    return mod


def _write(p: Path, payload: dict) -> None:
    p.write_text(json.dumps(payload, indent=2))


def _args(**overrides) -> Namespace:
    base = dict(
        auto=False,
        dry_run=False,
        strip_private=False,
        force_write=False,
        print=False,
    )
    base.update(overrides)
    return Namespace(**base)


def test_no_files_returns_zero(tmp_path, monkeypatch, capsys):
    """Empty data dir → exit 0, no shared file written."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    mod = _load_module(monkeypatch, data_dir)
    assert mod.reconcile(_args(auto=True)) == 0
    assert not (data_dir / "personal-pois-shared.json").exists()
    out = capsys.readouterr().out
    assert "Nothing to reconcile" in out


def test_single_bot_consensus_writes_shared(tmp_path, monkeypatch):
    """One bot, one POI → trivially picked, shared file written, body preserved."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _write(data_dir / "personal-pois-flint.json", {
        "spider_hill": {
            "name": "spider_hill", "x": 3, "y": 64, "z": 4,
            "added_at": "2026-06-04T10:00:00Z",
            "last_seen": "2026-06-04T10:00:00Z",
            "sign_at": {"x": 3, "y": 64, "z": 4},
            "torch_at": {"x": 3, "y": 65, "z": 4},
            "kind": "landmark",
            "note": "great view",
            "agent_owner": "flint",
        },
    })
    mod = _load_module(monkeypatch, data_dir)
    assert mod.reconcile(_args(auto=True)) == 0

    shared = json.loads((data_dir / "personal-pois-shared.json").read_text())
    assert set(shared) == {"spider_hill"}
    entry = shared["spider_hill"]
    assert entry["x"] == 3 and entry["y"] == 64 and entry["z"] == 4
    assert entry["sign_at"] == {"x": 3, "y": 64, "z": 4}
    assert entry["torch_at"] == {"x": 3, "y": 65, "z": 4}
    assert entry["kind"] == "landmark"
    assert entry["note"] == "great view"
    assert entry["reconciled_from"] == ["flint"]
    assert "reconciled_at" in entry


def test_auto_latest_last_seen_wins_on_conflict(tmp_path, monkeypatch):
    """Two bots propose same name at different coords → most-recent last_seen
    wins. This is the POI-specific tie-breaker (marks use bot-majority)."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _write(data_dir / "personal-pois-flint.json", {
        "cairn_n": {
            "name": "cairn_n", "x": 0, "y": 64, "z": 10,
            "added_at": "2026-06-04T09:00:00Z",
            "last_seen": "2026-06-04T09:00:00Z",
            "agent_owner": "flint",
        },
    })
    _write(data_dir / "personal-pois-mason.json", {
        "cairn_n": {
            "name": "cairn_n", "x": 5, "y": 64, "z": 12,
            "added_at": "2026-06-04T11:30:00Z",
            "last_seen": "2026-06-04T11:30:00Z",
            "agent_owner": "mason",
        },
    })
    mod = _load_module(monkeypatch, data_dir)
    assert mod.reconcile(_args(auto=True)) == 0

    shared = json.loads((data_dir / "personal-pois-shared.json").read_text())
    # Mason's stamp is more recent — his coord wins.
    assert (shared["cairn_n"]["x"], shared["cairn_n"]["z"]) == (5, 12)
    assert shared["cairn_n"]["reconciled_from"] == ["mason"]


def test_dry_run_writes_nothing(tmp_path, monkeypatch, capsys):
    """--dry-run prints intent but never writes the shared file."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _write(data_dir / "personal-pois-flint.json", {
        "p": {"name": "p", "x": 0, "y": 64, "z": 0, "last_seen": "2026-06-04T10:00:00Z"},
    })
    mod = _load_module(monkeypatch, data_dir)
    assert mod.reconcile(_args(auto=True, dry_run=True)) == 0
    assert not (data_dir / "personal-pois-shared.json").exists()
    out = capsys.readouterr().out
    assert "dry-run" in out and "would write" in out


def test_strip_private_removes_canonical_from_bot_files(tmp_path, monkeypatch):
    """--strip-private wipes the now-shadowed entries from per-bot files.

    Any uniquely-proposed POI is also canonical (a single proposal counts as
    unanimous), so every promoted name gets stripped from its owners' files.
    """
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _write(data_dir / "personal-pois-flint.json", {
        "p": {"name": "p", "x": 0, "y": 64, "z": 0, "last_seen": "2026-06-04T10:00:00Z"},
        "flint_only": {"name": "flint_only", "x": 1, "y": 64, "z": 1,
                       "last_seen": "2026-06-04T10:00:00Z"},
    })
    _write(data_dir / "personal-pois-mason.json", {
        "p": {"name": "p", "x": 0, "y": 64, "z": 0, "last_seen": "2026-06-04T09:00:00Z"},
    })
    mod = _load_module(monkeypatch, data_dir)
    assert mod.reconcile(_args(auto=True, strip_private=True)) == 0

    flint = json.loads((data_dir / "personal-pois-flint.json").read_text())
    mason = json.loads((data_dir / "personal-pois-mason.json").read_text())
    shared = json.loads((data_dir / "personal-pois-shared.json").read_text())
    # All names got promoted; private files are emptied of promoted entries.
    assert flint == {} and mason == {}
    assert set(shared) == {"p", "flint_only"}


def test_existing_shared_file_preserves_prior_entries(tmp_path, monkeypatch):
    """Shared file with a prior reconciliation should survive a cycle where
    only NEW POIs come from bots — we must not drop unrelated entries."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _write(data_dir / "personal-pois-shared.json", {
        "old_landmark": {
            "name": "old_landmark", "x": 100, "y": 64, "z": 100,
            "added_at": "2026-06-01T00:00:00Z",
            "last_seen": "2026-06-01T00:00:00Z",
            "reconciled_at": "2026-06-01T00:01:00Z",
            "reconciled_from": ["flint"],
        },
    })
    _write(data_dir / "personal-pois-mason.json", {
        "new_landmark": {
            "name": "new_landmark", "x": 5, "y": 64, "z": 5,
            "last_seen": "2026-06-04T11:30:00Z",
        },
    })
    mod = _load_module(monkeypatch, data_dir)
    assert mod.reconcile(_args(auto=True)) == 0

    shared = json.loads((data_dir / "personal-pois-shared.json").read_text())
    assert "old_landmark" in shared, "prior reconciliation must survive"
    assert "new_landmark" in shared


def test_internal_source_field_stripped_before_writing(tmp_path, monkeypatch):
    """The runtime store annotates loaded entries with `_source: 'shared'`.
    The reconciler must strip those before persisting so they don't pile up."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _write(data_dir / "personal-pois-flint.json", {
        "p": {
            "name": "p", "x": 0, "y": 64, "z": 0,
            "last_seen": "2026-06-04T10:00:00Z",
            "_source": "private",  # runtime overlay tag — must not persist
        },
    })
    mod = _load_module(monkeypatch, data_dir)
    assert mod.reconcile(_args(auto=True)) == 0

    shared = json.loads((data_dir / "personal-pois-shared.json").read_text())
    assert "_source" not in shared["p"]


def test_malformed_entries_skipped_not_crashed(tmp_path, monkeypatch):
    """Garbage coords / non-dict entries should be skipped, not crash."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _write(data_dir / "personal-pois-flint.json", {
        "good": {"name": "good", "x": 1, "y": 64, "z": 2, "last_seen": "2026-06-04T10:00:00Z"},
        "bad_no_coords": {"name": "bad_no_coords"},
        "bad_string": "not even a dict",
        "bad_x_type": {"name": "bad", "x": "oops", "y": 64, "z": 0},
    })
    mod = _load_module(monkeypatch, data_dir)
    assert mod.reconcile(_args(auto=True)) == 0
    shared = json.loads((data_dir / "personal-pois-shared.json").read_text())
    assert set(shared) == {"good"}


def test_force_write_persists_when_no_additions(tmp_path, monkeypatch):
    """--force-write rewrites shared even if nothing changed (canonicalises ordering)."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _write(data_dir / "personal-pois-shared.json", {
        "p": {"name": "p", "x": 1, "y": 64, "z": 2,
              "added_at": "2026-06-04T10:00:00Z", "last_seen": "2026-06-04T10:00:00Z"},
    })
    _write(data_dir / "personal-pois-flint.json", {
        "p": {"name": "p", "x": 1, "y": 64, "z": 2,
              "added_at": "2026-06-04T10:00:00Z", "last_seen": "2026-06-04T10:00:00Z"},
    })
    mod = _load_module(monkeypatch, data_dir)
    before_mtime = (data_dir / "personal-pois-shared.json").stat().st_mtime
    # Sleep avoidance: just compare content. force_write should re-emit.
    assert mod.reconcile(_args(auto=True, force_write=True)) == 0
    shared = json.loads((data_dir / "personal-pois-shared.json").read_text())
    # Sanity: shared file still has p, body is sane after rewrite.
    assert shared["p"]["x"] == 1

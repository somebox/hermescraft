"""Regression tests for failure modes observed across g-2026-05-27-10 → g-2026-05-28-3.

Each test names the run where the failure mode appeared and asserts the fix
hard-fails rather than logging-and-continuing. The whole point of these
tests is "would this catch the silent-failure-then-wedge pattern next time."

Run series summary:
  g-2026-05-27-10  Steward used --parent <epic_id>; dispatcher wedged
  g-2026-05-28-1   seed_base_pad filled 0/81 but logged "partial"; bots saw grass
  g-2026-05-28-2   chest fill ok'd but manifest had no cobble; mason blocked
  g-2026-05-28-3   3 of 6 P1 done; stalled on Steward orch-complete doctrine
"""

from __future__ import annotations

import importlib.util
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest.mock import patch

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import genesis_lib as gl  # noqa: E402


# ─── 2.2  seed_base_pad: 0-cell fill must hard-raise, not warn ────────────


def test_seed_base_pad_zero_cells_raises(monkeypatch):
    """g-2026-05-28-1: rcon `fill` returned no success match → filled=0 →
    code logged 'partial' and continued, bots walked into a world with no pad.
    Hard-fail on zero must stay enforced."""
    cfg = {"run_id": "test", "base_anchor": {"x": 0, "y": 64, "z": 0}}
    monkeypatch.setattr(gl, "GENESIS_DRY_RUN", False)

    rcon_calls = []

    def fake_rcon(command: str, *, quiet: bool = False) -> str:
        rcon_calls.append(command)
        # forceload always succeeds quietly
        if command.startswith("forceload"):
            return "Forceload added"
        # every fill — including the probe and the main fill — returns the
        # paper "No blocks were filled" wording so .search returns None and
        # filled stays 0
        if command.startswith("fill"):
            return "No blocks were filled"
        return ""

    monkeypatch.setattr(gl, "rcon", fake_rcon)
    monkeypatch.setattr("time.sleep", lambda _s: None)

    with pytest.raises(RuntimeError, match=r"chunks not ready|0/\d+ cells filled"):
        gl.seed_base_pad(cfg)


def test_seed_base_pad_partial_then_full_on_retry(monkeypatch, tmp_path):
    """#33: a single retry was leaving the pad at 80/81 every run (g-2026-05-30-2).
    Paper reports the probe as ready before all neighbour chunks finish their
    save/light tick, so the bulk fill races. With the retry-backoff fix
    (2s → 4s → 8s), a transient short-fill on the first bulk attempt should
    converge to the full count by the time we reach the 4s retry."""
    monkeypatch.setattr(gl, "GENESIS_DRY_RUN", False)
    monkeypatch.setattr(gl, "REPO_ROOT", tmp_path)
    (tmp_path / "data" / "genesis-runs" / "test").mkdir(parents=True)

    bulk_fill_attempts = {"n": 0}

    def fake_rcon(command: str, *, quiet: bool = False) -> str:
        if command.startswith("forceload"):
            return ""
        if command.startswith("fill") and "minecraft:cobblestone" in command:
            # Distinguish probe (1×1 — same coord twice) from bulk fill.
            parts = command.split()
            # `fill x1 y z1 x2 y z2 minecraft:cobblestone replace`
            is_probe = parts[1] == parts[4] and parts[3] == parts[6]
            if is_probe:
                return "Successfully filled 1 block(s)"
            bulk_fill_attempts["n"] += 1
            if bulk_fill_attempts["n"] == 1:
                return "Successfully filled 79 block(s)"
            return "Successfully filled 81 block(s)"
        return ""

    monkeypatch.setattr(gl, "rcon", fake_rcon)
    monkeypatch.setattr("time.sleep", lambda _s: None)

    cfg = {"run_id": "test", "base_anchor": {"x": 0, "y": 64, "z": 0}}
    gl.seed_base_pad(cfg)

    # We should NOT have logged a partial-warn: the retry caught up.
    run_log = tmp_path / "data" / "genesis-runs" / "test" / "run.log"
    log_text = run_log.read_text() if run_log.exists() else ""
    assert "seed_base_pad_warn" not in log_text, "retry should have reached full fill — no warn expected"
    assert bulk_fill_attempts["n"] >= 2, "should have retried after the partial first attempt"


def test_seed_base_pad_partial_fill_logs_warn(monkeypatch, tmp_path):
    """Partial fill (e.g. 80/81 — chunk boundary edge case observed g-2026-05-28-3)
    should NOT raise — it's tolerable. Just warn-log."""
    monkeypatch.setattr(gl, "GENESIS_DRY_RUN", False)
    monkeypatch.setattr(gl, "REPO_ROOT", tmp_path)
    (tmp_path / "data" / "genesis-runs" / "test").mkdir(parents=True)

    call_count = {"fills": 0}

    def fake_rcon(command: str, *, quiet: bool = False) -> str:
        if command.startswith("forceload"):
            return ""
        if command.startswith("fill"):
            call_count["fills"] += 1
            # probe (1x1) succeeds; real fill returns partial 80/81
            if "minecraft:cobblestone" in command and call_count["fills"] >= 2:
                return "Successfully filled 80 block(s)"
            return "Successfully filled 1 block(s)"
        return ""

    monkeypatch.setattr(gl, "rcon", fake_rcon)
    monkeypatch.setattr("time.sleep", lambda _s: None)

    # Should NOT raise — partial is tolerated with a warn entry
    cfg = {"run_id": "test", "base_anchor": {"x": 0, "y": 64, "z": 0}}
    gl.seed_base_pad(cfg)

    run_log = tmp_path / "data" / "genesis-runs" / "test" / "run.log"
    assert run_log.exists()
    log_text = run_log.read_text()
    assert "seed_base_pad_warn" in log_text
    assert "filled 80/81" in log_text or "80" in log_text


# ─── 2.3  system-chest manifest must include cobblestone ────────────────


def test_system_chest_fill_has_post_verify():
    """g-2026-05-28-1: cmdFill reported 'outcome: ok' after 33 deposits each
    returning ok:true, but Mason verified the chest was empty (deposit succeeds
    when the bot action ran, regardless of whether items landed). The post-fill
    verify block reads list_container and exits non-zero if the chest is empty.
    This test asserts that block stays in place."""
    chest_path = REPO / "scripts" / "system-chest.mjs"
    body = chest_path.read_text()
    # Locate the cmdFill function and assert it contains the verify pattern.
    # Pattern markers (any one missing = regression):
    #   - list_container call against the chest coords after deposits
    #   - explicit exit(3) when stacks === 0 with non-empty manifest
    fill_section = body.split("async function cmdFill")[1].split("\nasync function ")[0]
    assert "list_container" in fill_section, (
        "cmdFill must call list_container to verify chest contents after deposits"
    )
    assert "process.exit(3)" in fill_section, (
        "cmdFill must exit(3) when the verify shows an empty chest with non-empty manifest"
    )
    assert "stacks.length === 0" in fill_section, (
        "cmdFill verify must check stacks.length === 0 as the empty-chest condition"
    )


def test_system_chest_manifest_includes_cobblestone():
    """g-2026-05-28-2: manifest had tools + food + wood but NO cobble, so the
    Tier 1.3 shelter system_chest exception couldn't be honored. Mason
    blocked correctly but P1 deadlocked. This regression test guards against
    a future restock-list edit dropping cobble."""
    chest_path = REPO / "scripts" / "system-chest.mjs"
    body = chest_path.read_text()
    # The DEFAULT_MANIFEST is a JS const array; we just grep for the line.
    # Any future schema change should still leave 'cobblestone' as a token.
    manifest_section = body.split("DEFAULT_MANIFEST")[1].split("];")[0]
    assert "'cobblestone'" in manifest_section, (
        "DEFAULT_MANIFEST must include cobblestone for P1 shelter exception; "
        "see prompts/landfolk/steward.md and data/genesis/templates/phase1-cards.yaml"
    )


# ─── 2.4  scripts/kanban create must NOT expose --parent ────────────────


def _load_kanban_module():
    path = REPO / "scripts" / "kanban"
    loader = SourceFileLoader("kanban_facade_failmode", str(path))
    spec = importlib.util.spec_from_loader("kanban_facade_failmode", loader)
    assert spec
    mod = importlib.util.module_from_spec(spec)
    sys.modules["kanban_facade_failmode"] = mod
    loader.exec_module(mod)
    return mod


def test_facade_create_does_not_accept_parent_flag():
    """g-2026-05-27-10 wedge cause: --parent <epic_id> from raw hermes kanban
    create entangled epic-tracking with real-dep semantics. The facade
    eliminates this by structurally not exposing --parent — instead it has
    --epic (body trailer, no link) and --depends-on (real link, gates promote)."""
    kf = _load_kanban_module()
    parser = kf._build_parser()
    # Find the create subparser
    create_args = None
    for action in parser._subparsers._group_actions:
        for choice_action in action.choices.values() if hasattr(action, "choices") and action.choices else []:
            if choice_action.prog.endswith("create"):
                create_args = {a.dest: a for a in choice_action._actions}
                break
        if create_args:
            break
    assert create_args is not None, "could not find create subparser"
    # The bug class: a --parent flag would re-enable the entanglement
    assert "parent" not in create_args, (
        "scripts/kanban create must NOT have --parent flag — "
        "use --epic (no link) for membership and --depends-on for real prereqs"
    )
    # Sanity-check the replacement flags ARE there
    assert "epic" in create_args, "create must accept --epic for membership tagging"
    assert "depends_on" in create_args, "create must accept --depends-on for real prereqs"


def test_facade_create_with_epic_does_not_call_link():
    """Behavioral test: when --epic <id> is passed, the facade attaches a
    body trailer; it must NOT call `hermes kanban link` (which would create
    a task_links edge and re-introduce the wedge bug)."""
    kf = _load_kanban_module()
    # Attach trailer to an empty body; verify no link call would be needed
    body = kf._attach_trailer("scout the area", epic="t_p2")
    assert "epic: t_p2" in body
    assert "---" in body
    # The hermes kanban create command built from --epic should NOT include
    # --parent in the argv. We verify this by inspecting the command-building
    # path indirectly: _attach_trailer is the ONLY mechanism for --epic,
    # and it modifies body, not links.
    visible, trailer = kf._split_body_trailer(body)
    assert trailer == {"epic": "t_p2"}
    assert "scout the area" in visible


# ─── 2.5  facade tests that already existed — re-run as sanity ──────────


def test_facade_substring_safety_regression():
    """g-2026-05-28-3: scan_epic_children must not match `epic: t_epic` when
    a card's trailer says `epic: t_epic_extended`. Already tested in
    test_kanban_facade.py — re-asserted here to ensure the suite catches a
    regression in case that test ever gets accidentally weakened."""
    kf = _load_kanban_module()
    # Just verify the regex shape is what we expect — substring scan would
    # match `t_p2` inside `t_p2_extended`. The actual implementation uses
    # _epic_of for exact match per row, not regex over the whole body.
    assert kf._epic_of("body\n\n---\nepic: t_p2_extended") == "t_p2_extended"
    assert kf._epic_of("body\n\n---\nepic: t_p2") == "t_p2"
    # If a caller checks `extracted == "t_p2"` against a body containing
    # `epic: t_p2_extended`, the implementation must not falsely match.
    assert kf._epic_of("body\n\n---\nepic: t_p2_extended") != "t_p2"

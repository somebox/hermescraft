#!/usr/bin/env python3
"""No-agent test for genesis-v2 phase transitions.

Proves the poller-authoritative epic state machine holds WITHOUT running any LLM
agents — the thing that bit us live (a Steward worker finishing instead of parking
cascaded P1->P5 on empty work). Two parts:

  Part 1 (pure logic, fast): drive advance_phases() with injected gate/status and
    assert it completes + unblocks in the right order, never skips an unmet gate,
    and never promotes the next phase off a prematurely-`done` epic when the gate
    has not actually passed (anti-cascade at the logic layer).

  Part 2 (real kanban, on a throwaway board): assert the actual hermes transitions
    the design relies on — block parks a card, completing one epic does NOT promote
    a blocked sibling (no depends_on => no cascade), unblock opens it, and an epic
    can be completed straight from `blocked` (so the poller can close a parked epic
    on gate-pass).

Run:  .venv/bin/python3 scripts/test-phase-transitions.py
Exit: 0 all pass, 1 on first failure.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
import genesis2_lib as g2  # noqa: E402

TTEST_BOARD = "genesis-v2-ttest"
_fails = 0


def check(label: str, cond: bool) -> None:
    global _fails
    mark = "ok  " if cond else "FAIL"
    if not cond:
        _fails += 1
    print(f"  [{mark}] {label}")


# --------------------------------------------------------------------------- #
# Part 1 — pure advance_phases logic (no board, no marks)
# --------------------------------------------------------------------------- #
def part1_logic() -> None:
    print("Part 1 — advance_phases logic (injected gates/status)")
    EPICS = ["e1", "e2", "e3", "e4", "e5"]
    PHASES = ["P1", "P2", "P3", "P4", "P5"]

    orig_load, orig_hermes = g2.load_config, g2._hermes
    g2.load_config = lambda rid: {"epic_ids": EPICS}
    calls: list[tuple[str, str]] = []

    class _R:  # fake CompletedProcess
        returncode = 0

    def fake_hermes(args, **kw):
        # args like ["complete", eid, ...] or ["unblock", eid, ...]
        if args and args[0] in ("complete", "unblock"):
            calls.append((args[0], args[1]))
        return _R()

    g2._hermes = fake_hermes

    def run(gate_pass: dict[str, bool], status: dict[str, str]):
        calls.clear()
        gates = {p: {"pass": gate_pass.get(p, False)} for p in PHASES}
        advanced = g2.advance_phases("rid", status_by_id=dict(status), gates=gates)
        return advanced, list(calls)

    try:
        # all gates fail -> nothing happens
        adv, calls_ = run({}, {e: ("blocked" if e != "e1" else "ready") for e in EPICS})
        check("all-fail: no advance, no calls", adv == [] and calls_ == [])

        # P1 passes, P1 still open -> complete e1 + unblock e2
        adv, calls_ = run({"P1": True}, {"e1": "ready", "e2": "blocked", "e3": "blocked",
                                          "e4": "blocked", "e5": "blocked"})
        check("P1 pass: advanced==[P1]", adv == ["P1"])
        check("P1 pass: complete e1 then unblock e2",
              calls_ == [("complete", "e1"), ("unblock", "e2")])

        # P1 passes but e1 ALREADY done -> no re-complete, still unblock e2 if parked
        adv, calls_ = run({"P1": True}, {"e1": "done", "e2": "blocked"})
        check("P1 pass, e1 done: no complete, unblock e2",
              adv == [] and calls_ == [("unblock", "e2")])

        # P1 + P2 pass, P3 fails -> close e1,e2; unblock e2,e3; stop before P3 promote
        adv, calls_ = run({"P1": True, "P2": True},
                          {"e1": "ready", "e2": "blocked", "e3": "blocked"})
        check("P1+P2 pass: advanced==[P1,P2]", adv == ["P1", "P2"])
        check("P1+P2 pass: e3 unblocked, e4 NOT",
              ("unblock", "e3") in calls_ and ("unblock", "e4") not in calls_)

        # ANTI-CASCADE: P1 gate FAILS but e1 is prematurely `done` -> must NOT
        # unblock e2 (the live bug: a finished Steward marked the epic done).
        adv, calls_ = run({"P1": False}, {"e1": "done", "e2": "blocked"})
        check("anti-cascade: premature done e1 + gate fail -> e2 stays parked",
              adv == [] and calls_ == [])

        # ANTI-SKIP: P1 fails, P2 passes -> must stop at P1, touch nothing.
        adv, calls_ = run({"P1": False, "P2": True}, {"e1": "ready", "e2": "blocked"})
        check("anti-skip: P1 fail blocks P2 advance", adv == [] and calls_ == [])
    finally:
        g2.load_config, g2._hermes = orig_load, orig_hermes


# --------------------------------------------------------------------------- #
# Part 2 — real kanban transitions on a throwaway board
# --------------------------------------------------------------------------- #
def _kb(args: list[str], timeout: int = 20) -> subprocess.CompletedProcess:
    return subprocess.run(["hermes", "kanban", "--board", TTEST_BOARD, *args],
                          capture_output=True, text=True, timeout=timeout)


def _status(tid: str) -> str | None:
    r = _kb(["list", "--json"])
    try:
        lst = json.loads(r.stdout or "[]")
        rows = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        return None
    for t in rows:
        if str(t.get("id")) == tid:
            return (t.get("status") or "").lower()
    return None


def _create(title: str) -> str:
    r = _kb(["create", title, "--assignee", "colony-steward", "--json"])
    return str(json.loads(r.stdout).get("id"))


def part2_real_kanban() -> None:
    print(f"Part 2 — real kanban transitions (board {TTEST_BOARD})")
    _kb(["boards", "create", TTEST_BOARD])
    _kb(["init"])
    # clean slate
    try:
        lst = json.loads(_kb(["list", "--json"]).stdout or "[]")
        for t in (lst if isinstance(lst, list) else lst.get("tasks", [])):
            _kb(["archive", str(t.get("id"))], timeout=15)
    except Exception:
        pass

    e1 = _create("[TTEST] P1 epic")
    e2 = _create("[TTEST] P2 epic")
    # Seed shape: P1 dispatchable, P2 parked (mirror seed_board).
    _kb(["block", e2, "parked"])
    check("seed: P1 ready", _status(e1) in ("ready", "running", "todo"))
    check("seed: P2 blocked", _status(e2) == "blocked")

    # Premature completion of P1 must NOT promote the parked P2 (no depends_on).
    _kb(["complete", e1, "--result", "premature finish (simulated Steward)"])
    check("P1 completed", _status(e1) == "done")
    check("anti-cascade: P2 STILL blocked after P1 done", _status(e2) == "blocked")

    # Poller opens P2 on gate-pass.
    _kb(["unblock", e2, "--reason", "P1 gate passed"])
    check("unblock: P2 -> ready", _status(e2) == "ready")

    # An epic parked in `blocked` can be completed directly (poller closes it).
    _kb(["block", e2, "re-park for complete-from-blocked check"])
    check("re-park: P2 blocked", _status(e2) == "blocked")
    _kb(["complete", e2, "--result", "gate passed from blocked"])
    check("complete-from-blocked: P2 -> done", _status(e2) == "done")

    # cleanup
    _kb(["archive", e1], timeout=15)
    _kb(["archive", e2], timeout=15)


if __name__ == "__main__":
    part1_logic()
    if "--logic-only" not in sys.argv:
        part2_real_kanban()
    print()
    if _fails:
        print(f"RESULT: {_fails} FAILURE(S)")
        sys.exit(1)
    print("RESULT: all transitions hold ✓")

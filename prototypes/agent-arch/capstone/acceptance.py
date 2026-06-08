"""Acceptance gate — runs ``mc verify`` against an epic's predicate.

This module is the bridge from Concern 2 (done-ness predicates) to the
capstone trial: at the end of a run, we ask Tester to evaluate the
same predicate that the colony lane and the wide baseline both target.

**Narrowed scope.** Current ``mc verify`` (Session 2) supports only
``inventory_contains`` and ``chest_contains``. The walkthrough's full
acceptance list (tilled-plot grid via ``region_blocks``, water source
via ``at_mark``, sign with text) needs verbs not yet landed. Until
those land in a follow-up session, the capstone uses a single
``chest_contains`` predicate — wheat deposited at ``:chest_food:``
above a min count. This is honest: it tests A2 (vocab map) end to
end on a real predicate, and the binary outcome (did the deposit
happen?) is what A6/A7 care about anyway.

The verify call goes to Tester :3004 (the colony harness's neutral
bot) using its ``mc verify`` CLI. We do NOT run verify on the bound
bot (mox) — verify must be run by an observer, not the worker that
just completed the work.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from typing import Optional


# Tester runs on port 3004 per the test rig convention
# (see scripts/run-tester-bot.sh).
DEFAULT_TESTER_URL = "http://127.0.0.1:3004"

# Supported predicate kinds in the current `mc verify` build. Update
# this set when new verbs land. The runner refuses to dispatch a
# predicate not in this set, so the freeze rule is enforced
# mechanically rather than by hope.
SUPPORTED_KINDS = frozenset({
    "inventory_contains",
    "chest_contains",
    "at_mark",
    "region_blocks",
})


@dataclass(frozen=True)
class AcceptanceResult:
    """What the verify call returned, normalised."""

    satisfied: bool  # the predicate evaluated AND held
    evaluable: bool  # the bot could evaluate (false → ok:false / error)
    detail: dict     # raw response body for the report
    stderr: str = ""


@dataclass(frozen=True)
class AcceptanceSet:
    """The all-of result of evaluating a list of predicates against
    Tester. Used by the wheat-farm capstone (multi-predicate acceptance:
    plot, crop, water, sign) and any future card that needs more than
    one done-ness check.

    ``per_predicate`` preserves order so the postmortem can attribute
    misses to specific predicates. ``satisfied`` is True iff every
    predicate satisfied; ``evaluable`` is True iff every predicate
    evaluated successfully (regardless of result).
    """
    satisfied: bool
    evaluable: bool
    per_predicate: tuple[AcceptanceResult, ...]


class UnsupportedPredicate(ValueError):
    """Raised when the runner is asked to evaluate a kind the current
    ``mc verify`` build does not support."""


def evaluate_all(
    predicates: list[dict],
    *,
    tester_url: str = DEFAULT_TESTER_URL,
    mc_bin: Optional[str] = None,
) -> AcceptanceSet:
    """Evaluate every predicate; report all-of result.

    Runs predicates in order — no short-circuit on first failure. This
    gives a postmortem-friendly attribution: if the wheat capstone
    fails because the sign is missing OR the water source is in the
    wrong cell, the AcceptanceSet records WHICH predicate(s) missed.

    Per-predicate failures and per-predicate UnsupportedPredicate
    errors are both surfaced via the per_predicate list. The set is
    `satisfied` iff every predicate satisfied; `evaluable` iff every
    predicate evaluated (regardless of result).
    """
    results: list[AcceptanceResult] = []
    for predicate in predicates:
        try:
            results.append(evaluate(predicate, tester_url=tester_url, mc_bin=mc_bin))
        except UnsupportedPredicate as exc:
            # Record as "not evaluable" instead of raising — the rest
            # of the predicates should still be checked. The detail
            # carries the failure reason so the postmortem can read it.
            results.append(AcceptanceResult(
                satisfied=False, evaluable=False,
                detail={"error": "UnsupportedPredicate", "message": str(exc),
                        "predicate": predicate},
            ))
    all_satisfied = all(r.satisfied for r in results) if results else False
    all_evaluable = all(r.evaluable for r in results) if results else False
    return AcceptanceSet(
        satisfied=all_satisfied,
        evaluable=all_evaluable,
        per_predicate=tuple(results),
    )


def evaluate(
    predicate: dict,
    *,
    tester_url: str = DEFAULT_TESTER_URL,
    mc_bin: Optional[str] = None,
) -> AcceptanceResult:
    """Run ``mc verify <kind> <args...>`` against Tester.

    Refuses to evaluate predicates whose kind isn't in ``SUPPORTED_KINDS``
    — better to fail loudly than to silently report ``satisfied=false``
    when the bot literally couldn't compute the answer.

    *mc_bin* defaults to ``mc`` on PATH; tests inject a stub.
    """
    kind = str(predicate.get("kind", "")).lower()
    if kind not in SUPPORTED_KINDS:
        raise UnsupportedPredicate(
            f"acceptance.evaluate: predicate kind '{kind}' not supported by "
            f"current `mc verify` build. Supported: {sorted(SUPPORTED_KINDS)}. "
            f"Extend bot/lib/actions/verify.js in a follow-up session."
        )

    mc_bin = mc_bin or os.environ.get("MC_BIN", "mc")
    cmd = [mc_bin, "verify", kind]
    cmd.extend(_predicate_args(predicate))

    env = dict(os.environ)
    env["MC_API_URL"] = tester_url

    proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    return _parse_verify_response(proc.stdout, proc.stderr, proc.returncode)


def _predicate_args(predicate: dict) -> list[str]:
    """Lay out the positional args ``mc verify`` expects per kind."""
    kind = predicate["kind"]
    if kind == "inventory_contains":
        args = [str(predicate["item"])]
        if "min_count" in predicate:
            args.append(str(int(predicate["min_count"])))
        return args
    if kind == "chest_contains":
        args = [
            str(predicate["mark"]),
            str(predicate["item"]),
        ]
        if "min_count" in predicate:
            args.append(str(int(predicate["min_count"])))
        return args
    if kind == "at_mark":
        args = [str(predicate["mark"])]
        if "block" in predicate:
            args.extend(["--block", str(predicate["block"])])
        elif "near" in predicate:
            args.extend(["--near", str(int(predicate["near"]))])
        return args
    if kind == "region_blocks":
        c1 = predicate["corner1"]
        c2 = predicate["corner2"]
        args = [
            str(int(c1["x"])), str(int(c1["y"])), str(int(c1["z"])),
            str(int(c2["x"])), str(int(c2["y"])), str(int(c2["z"])),
            str(predicate["block"]),
        ]
        if "min_count" in predicate:
            args.append(str(int(predicate["min_count"])))
        return args
    raise UnsupportedPredicate(f"_predicate_args: kind '{kind}' not in switch")


def _parse_verify_response(
    stdout: str, stderr: str, rc: int,
) -> AcceptanceResult:
    """``mc verify`` returns one JSON line on stdout matching the action
    contract envelope: ``{ok: bool, satisfied?: bool, ...}``."""
    if rc != 0 and not stdout.strip():
        return AcceptanceResult(
            satisfied=False, evaluable=False,
            detail={"exit_code": rc}, stderr=stderr,
        )

    try:
        body = json.loads(stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return AcceptanceResult(
            satisfied=False, evaluable=False,
            detail={"raw_stdout": stdout, "exit_code": rc},
            stderr=stderr,
        )

    ok = bool(body.get("ok"))
    # Bot HTTP envelope nests the predicate result under `data.satisfied`
    # (matches action-contract.js). The Session 2 spec doc shows the
    # nested form ({ok:true, data:{satisfied:true, ...}}); flat-form was
    # an early-draft mistake in the bridge spec. Read both for safety —
    # if either reports satisfied, we trust the predicate fired.
    nested = body.get("data") or {}
    nested_satisfied = nested.get("satisfied")
    flat_satisfied = body.get("satisfied")

    # READ_FAILED / chunk-unloaded guard: if mc verify couldn't read every
    # cell in the region, the predicate is NOT evaluable — return
    # evaluable=false so the acceptance band doesn't conflate "we couldn't
    # measure" with "we measured a fail". Heuristic: presence of unreadable
    # > 0 in either layer, or known error markers in raw_stdout.
    unreadable = (nested.get("unreadable") if isinstance(nested.get("unreadable"), int) else None)
    if unreadable is None:
        unreadable = body.get("unreadable") if isinstance(body.get("unreadable"), int) else 0
    raw_marker = "READ_FAILED" in (body.get("raw_stdout") or "") or "chunk unloaded" in (body.get("raw_stdout") or "")
    if (unreadable and unreadable > 0) or raw_marker:
        return AcceptanceResult(
            satisfied=False,
            evaluable=False,
            detail=body,
            stderr=stderr,
        )

    satisfied = bool(nested_satisfied if nested_satisfied is not None else flat_satisfied) if ok else False
    return AcceptanceResult(
        satisfied=satisfied,
        evaluable=ok,
        detail=body,
        stderr=stderr,
    )

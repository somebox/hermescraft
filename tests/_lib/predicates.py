"""Predicates — declarative end-state checks.

Extracted from scripts/agent-test.py:218–431 (the predicate_results function)
and turned into a class so any test can reuse the same vocabulary. Each
method evaluates one predicate and returns a structured PredicateResult.

The same predicate names that the existing YAML fixtures use (bot_at,
bot_inventory, world_block_at, etc.) are kept for compatibility — Round 3
migration of agent-test.py will swap in this class with no schema change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class PredicateResult:
    kind: str
    passed: bool
    detail: str = ""

    def __bool__(self) -> bool:
        return self.passed


def _inv_check(item: str, want: Any, inv: dict[str, int]) -> tuple[bool, int, int, str]:
    """Returns (ok, have, threshold, label). want may be int or '>=N' / '>N' string."""
    have = inv.get(item, 0)
    if isinstance(want, str) and want.startswith(">="):
        threshold = int(want[2:])
        return have >= threshold, have, threshold, f"{item}>={threshold}"
    if isinstance(want, str) and want.startswith(">"):
        threshold = int(want[1:])
        return have > threshold, have, threshold, f"{item}>{threshold}"
    threshold = int(want)
    return have >= threshold, have, threshold, f"{item}>={threshold}"


class Predicates:
    """Evaluate end-state predicates against an observed bot state.

    Typical usage:
        end_state = bot.observe().get("state") or {}
        chat_lines = "\\n".join(m.get("message", "") for m in (end_state.get("new_chat") or []))
        p = Predicates(end_state=end_state, agent_chat=chat_lines)
        results = p.evaluate({
            "bot_hp_at_least": 15,
            "bot_inventory": {"cobblestone": ">=3"},
            "bot_at": {"x": 0, "y": 65, "z": 6, "range": 2},
        })
    """

    def __init__(
        self,
        end_state: dict | None = None,
        agent_chat: str = "",
        mc_verbs: list[str] | None = None,
        pre_deaths: int = 0,
    ):
        self.end_state = end_state or {}
        self.agent_chat = agent_chat or ""
        self.chat_lower = self.agent_chat.lower()
        self.mc_verbs = mc_verbs or []
        self.pre_deaths = pre_deaths

    def evaluate(self, expect: dict[str, Any]) -> list[PredicateResult]:
        """Run every predicate present in `expect` and return all results."""
        results: list[PredicateResult] = []
        for needle in expect.get("agent_chat_contains", []) or []:
            results.append(self.chat_contains(needle))
        for needle in expect.get("agent_chat_does_not_contain", []) or []:
            results.append(self.chat_does_not_contain(needle))
        if "agent_chat_contains_any" in expect:
            results.append(self.chat_contains_any(expect["agent_chat_contains_any"]))
        if "bot_y_at_least" in expect:
            results.append(self.bot_y_at_least(expect["bot_y_at_least"]))
        if "bot_hp_at_least" in expect:
            results.append(self.bot_hp_at_least(expect["bot_hp_at_least"]))
        if "bot_did_not_die" in expect:
            results.append(self.bot_did_not_die())
        if "bot_at" in expect:
            results.append(self.bot_at(expect["bot_at"]))
        if "bot_inventory" in expect:
            for item, want in expect["bot_inventory"].items():
                results.append(self.inventory_at_least(item, want))
        if "bot_inventory_excludes" in expect:
            for item, want in expect["bot_inventory_excludes"].items():
                results.append(self.inventory_excludes(item, want))
        if "mc_cli_invocations_max" in expect:
            results.append(self.mc_cli_invocations_max(expect["mc_cli_invocations_max"]))
        if "mc_verbs_include_any" in expect:
            results.append(self.mc_verbs_include_any(expect["mc_verbs_include_any"]))
        return results

    # --- Individual predicates ---

    def chat_contains(self, needle: str) -> PredicateResult:
        hit = needle.lower() in self.chat_lower
        return PredicateResult(f"chat_contains:{needle}", hit, "" if hit else "not in chat")

    def chat_does_not_contain(self, needle: str) -> PredicateResult:
        hit = needle.lower() in self.chat_lower
        return PredicateResult(
            f"chat_does_not_contain:{needle}",
            not hit,
            "" if not hit else "unwanted phrase appeared",
        )

    def chat_contains_any(self, needles: list[str]) -> PredicateResult:
        hits = [n for n in needles if n.lower() in self.chat_lower]
        ok = bool(hits)
        detail = ",".join(hits) + " found" if hits else f"none of {len(needles)} phrases"
        return PredicateResult(f"chat_contains_any:{len(needles)}", ok, detail)

    def bot_y_at_least(self, ymin: float) -> PredicateResult:
        pos = (self.end_state.get("position") or {})
        y = pos.get("y", -1)
        ok = bool(pos) and y >= float(ymin)
        return PredicateResult(f"bot_y>={ymin}", ok, f"y={y if pos else 'none'}")

    def bot_hp_at_least(self, hpmin: float) -> PredicateResult:
        hp = self.end_state.get("health")
        ok = hp is not None and hp >= float(hpmin)
        return PredicateResult(f"bot_hp>={hpmin}", ok, f"hp={hp if hp is not None else 'none'}")

    def bot_did_not_die(self) -> PredicateResult:
        post = int(self.end_state.get("death_death_number") or 0)
        died = post > self.pre_deaths
        return PredicateResult(
            "bot_did_not_die",
            not died,
            f"deaths: pre={self.pre_deaths} post={post}" + (" (died!)" if died else ""),
        )

    def bot_at(self, target: dict) -> PredicateResult:
        pos = self.end_state.get("position") or {}
        if not pos:
            return PredicateResult("bot_at", False, "no bot position")
        r = float(target.get("range", 2))
        dx = abs(pos.get("x", 0) - target["x"])
        dy = abs(pos.get("y", 0) - target["y"])
        dz = abs(pos.get("z", 0) - target["z"])
        dist = (dx * dx + dy * dy + dz * dz) ** 0.5
        return PredicateResult("bot_at", dist <= r, f"pos={pos}, target={target}, dist={dist:.1f}")

    def inventory_at_least(self, item: str, want: Any) -> PredicateResult:
        inv = self.end_state.get("inventory_summary") or {}
        ok, have, _, label = _inv_check(item, want, inv)
        return PredicateResult(f"inv:{label}", ok, f"have={have}")

    def inventory_excludes(self, item: str, want: Any) -> PredicateResult:
        inv = self.end_state.get("inventory_summary") or {}
        ok, have, threshold, _ = _inv_check(item, want, inv)
        # In the excludes-block, `ok` (>= threshold) means the predicate FAILS.
        return PredicateResult(
            f"inv_excludes:{item}",
            not ok,
            f"have={have}, threshold={threshold}" + (" (offender!)" if ok else ""),
        )

    def mc_cli_invocations_max(self, cap: int) -> PredicateResult:
        have = len(self.mc_verbs)
        return PredicateResult(f"mc_cli_invocations<={cap}", have <= cap, f"used {have}")

    def mc_verbs_include_any(self, wanted: list[str]) -> PredicateResult:
        hits = [v for v in wanted if v in self.mc_verbs]
        ok = bool(hits)
        detail = ",".join(hits) + " used" if hits else f"none of {','.join(wanted)} in {self.mc_verbs}"
        return PredicateResult(f"mc_verbs_include_any:{'|'.join(wanted)}", ok, detail)

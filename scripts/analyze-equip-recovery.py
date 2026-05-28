#!/usr/bin/env python3
"""analyze-equip-recovery — summarize the pre-throw equip recovery counter.

Reads /tmp/hermescraft/mc-equip-recovery.jsonl (written by
bot/lib/runtime/metrics.js:logEquipRecovery), aggregates by result class
and bot/category, and prints a brief summary.

The recovery fires inside bot/lib/runtime/dig-tools.js when the bot is
about to throw "Refusing to dig X with empty hand" — before refusing,
it re-checks inventory for the right tool and tries to equip it. This
analyzer tells you how often that fallback fires, how often it actually
saves the dig (vs hits a real no-tool case), and per-bot patterns.

Three result classes:
  saved          — re-equip brought dig ticks under cap; dig proceeded silently
  still_slow     — re-equip happened but tool tier insufficient; refused anyway
  no_candidate   — no tool of the needed category in inventory at all

A high `saved` count = the fallback is load-bearing (real desync recovery).
A high `still_slow` count = workers using wrong-tier tools (e.g. wooden_pickaxe
on iron_ore) — wants a smarter craft/upgrade prompt.

`no_candidate` is split further when records carry `inv_snapshot`:
  could_have_crafted — inventory had recipe inputs for some fitting tool
                       (comprehension gap: didn't think to craft it)
  capability_gap     — inventory truly lacked materials
                       (doctrine / kit gap: left base without provisioning)
  unknown_no_snapshot — older records emitted before inv_snapshot landed

Usage:
    scripts/analyze-equip-recovery.py                       # summary
    scripts/analyze-equip-recovery.py --tail 20             # show last 20 raw events
    scripts/analyze-equip-recovery.py --by-block            # break down by block name
    scripts/analyze-equip-recovery.py --with-reasoning      # join agent reasoning from cognition logs
    scripts/analyze-equip-recovery.py --with-reasoning --reasoning-window 15

The `--with-reasoning` join reads /tmp/hermescraft/cognition/<bot>.jsonl
per bot (lazy + cached) and surfaces the nearest preceding `reasoning` or
`assistant` record within --reasoning-window seconds of each event. This
turns "the bot refused to dig" into "the bot refused to dig and was
thinking X at the time" — the central diagnostic for comprehension vs
infra failures.
"""

from __future__ import annotations

import argparse
import bisect
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

LOG_PATH = Path("/tmp/hermescraft/mc-equip-recovery.jsonl")
COGNITION_DIR = Path("/tmp/hermescraft/cognition")

# Tool recipes used for the no_candidate / could_have_crafted classifier.
# Body ingredient is the first key after `stick`. Values are counts per craft.
# We only care about whether the bot HAD the inputs at refusal time, not
# the exact recipe arrangement — so this is a flat input table, not a
# crafting-grid model.
TOOL_RECIPES = {
    "wooden_pickaxe":  {"body": ("planks", 3),       "stick": 2},
    "stone_pickaxe":   {"body": ("cobblestone", 3),  "stick": 2},
    "iron_pickaxe":    {"body": ("iron_ingot", 3),   "stick": 2},
    "diamond_pickaxe": {"body": ("diamond", 3),      "stick": 2},
    "wooden_axe":      {"body": ("planks", 3),       "stick": 2},
    "stone_axe":       {"body": ("cobblestone", 3),  "stick": 2},
    "iron_axe":        {"body": ("iron_ingot", 3),   "stick": 2},
    "diamond_axe":     {"body": ("diamond", 3),      "stick": 2},
    "wooden_shovel":   {"body": ("planks", 1),       "stick": 2},
    "stone_shovel":    {"body": ("cobblestone", 1),  "stick": 2},
    "iron_shovel":     {"body": ("iron_ingot", 1),   "stick": 2},
    "diamond_shovel":  {"body": ("diamond", 1),      "stick": 2},
}

# Tier preference per category (best to worst). Match `category` field
# emitted by dig-tools recoveryCtx: "axe" | "pick" | "shovel" | "other".
CATEGORY_TIERS = {
    "pick":   ["diamond_pickaxe", "iron_pickaxe", "stone_pickaxe", "wooden_pickaxe"],
    "axe":    ["diamond_axe",     "iron_axe",     "stone_axe",     "wooden_axe"],
    "shovel": ["diamond_shovel",  "iron_shovel",  "stone_shovel",  "wooden_shovel"],
}

LOG_NAMES = {
    "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log",
    "dark_oak_log", "mangrove_log", "cherry_log",
    "crimson_stem", "warped_stem",
}
PLANK_NAMES = {
    "oak_planks", "birch_planks", "spruce_planks", "jungle_planks", "acacia_planks",
    "dark_oak_planks", "mangrove_planks", "cherry_planks",
    "bamboo_planks", "crimson_planks", "warped_planks",
}


def effective_stocks(inv: dict[str, int]) -> dict[str, int]:
    """Roll up inventory with substitutions: logs→planks, planks→sticks.
    Returns a fresh dict — does not mutate input."""
    planks = sum(inv.get(p, 0) for p in PLANK_NAMES)
    logs = sum(inv.get(l, 0) for l in LOG_NAMES)
    sticks = inv.get("stick", 0)
    # Logs → 4 planks each (vanilla recipe).
    eff_planks = planks + logs * 4
    return {
        "planks": eff_planks,
        "stick_existing": sticks,
        "cobblestone": inv.get("cobblestone", 0),
        "iron_ingot": inv.get("iron_ingot", 0),
        "diamond": inv.get("diamond", 0),
    }


def feasible_tier(inv: dict[str, int] | None, category: str) -> str | None:
    """Return the best tool tier in `category` that could have been crafted
    from `inv` (considering planks-from-logs and sticks-from-planks
    substitutions). None if no tier is reachable.

    The classifier is intentionally lenient — it asks "did the agent
    have enough raw inputs?" not "could the agent route to a crafting
    table in time?". The point is to separate comprehension failures
    (had materials, didn't craft) from real capability gaps.
    """
    if not inv:
        return None
    tiers = CATEGORY_TIERS.get(category, [])
    if not tiers:
        return None
    eff = effective_stocks(inv)
    for tier in tiers:
        recipe = TOOL_RECIPES.get(tier)
        if not recipe:
            continue
        body_kind, body_count = recipe["body"]
        stick_need = recipe["stick"]

        body_have = eff.get(body_kind, 0)
        if body_have < body_count:
            continue

        # Planks needed for sticks: 2 planks → 4 sticks, so each stick
        # costs 0.5 planks. Subtract body-planks first if body is planks.
        planks_left = eff["planks"] - (body_count if body_kind == "planks" else 0)
        # Sticks supplied: existing + planks_left * 2 (since 2 planks → 4 sticks)
        stick_supply = eff["stick_existing"] + planks_left * 2
        if stick_supply < stick_need:
            continue

        return tier
    return None


# ── reasoning join from cognition logs ─────────────────────────────────────

_REASONING_CACHE: dict[str, list[tuple[str, str, str]]] = {}


def _ts_to_dt(ts_iso: str) -> datetime | None:
    if not ts_iso:
        return None
    try:
        # Python 3.11 handles trailing Z; fallback for 3.10.
        return datetime.fromisoformat(ts_iso.replace("Z", "+00:00"))
    except Exception:
        return None


def load_reasoning_index(bot_name: str) -> list[tuple[str, str, str]]:
    """Return sorted list of (ts_iso, kind, text) entries for a bot's
    reasoning/assistant records. Lazy + cached per bot."""
    key = (bot_name or "").lower()
    if key in _REASONING_CACHE:
        return _REASONING_CACHE[key]
    out: list[tuple[str, str, str]] = []
    path = COGNITION_DIR / f"{key}.jsonl"
    if path.exists():
        for line in path.read_text().splitlines():
            try:
                d = json.loads(line)
            except Exception:
                continue
            kind = d.get("kind")
            if kind not in ("reasoning", "assistant"):
                continue
            ts = d.get("ts")
            text = d.get("text") or ""
            if ts and text:
                out.append((ts, kind, text))
        out.sort(key=lambda x: x[0])
    _REASONING_CACHE[key] = out
    return out


def find_preceding_reasoning(
    bot_name: str, event_ts: str, window_sec: int
) -> tuple[str, str, str] | None:
    """Find the last (ts, kind, text) record at or before event_ts for
    this bot, within window_sec seconds. None if no log or no match."""
    idx = load_reasoning_index(bot_name)
    if not idx:
        return None
    keys = [t[0] for t in idx]
    pos = bisect.bisect_right(keys, event_ts)
    if pos == 0:
        return None
    candidate = idx[pos - 1]
    ev_dt = _ts_to_dt(event_ts)
    cd_dt = _ts_to_dt(candidate[0])
    if not ev_dt or not cd_dt:
        return None
    delta = (ev_dt - cd_dt).total_seconds()
    if delta < 0 or delta > window_sec:
        return None
    return candidate


def reasoning_excerpt(text: str, limit: int = 220) -> str:
    """Single-line, length-capped excerpt suitable for inline display."""
    flat = " ".join((text or "").split())
    if len(flat) <= limit:
        return flat
    return flat[: limit - 1].rstrip() + "…"


# ── core report ────────────────────────────────────────────────────────────


def load_records() -> list[dict]:
    if not LOG_PATH.exists():
        return []
    out = []
    for line in LOG_PATH.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--tail", type=int, default=0, help="print the last N raw records")
    ap.add_argument("--by-block", action="store_true", help="break down by block name as well")
    ap.add_argument("--with-reasoning", action="store_true",
                    help="join each event with the nearest preceding agent reasoning")
    ap.add_argument("--reasoning-window", type=int, default=10,
                    help="seconds to look back when joining reasoning (default 10)")
    ap.add_argument("--samples", type=int, default=2,
                    help="reasoning samples to show per no_candidate sub-class (default 2)")
    args = ap.parse_args()

    records = load_records()
    if not records:
        print(f"# no equip-recovery events in {LOG_PATH}")
        print("# (the recovery code logs only when an 'empty hand' refusal is about to fire;")
        print("#  if bots aren't running or aren't hitting the refusal path, the log stays empty)")
        return 0

    if args.tail:
        for r in records[-args.tail:]:
            if args.with_reasoning:
                bot = r.get("bot", "")
                ts = r.get("ts", "")
                joined = find_preceding_reasoning(bot, ts, args.reasoning_window)
                print(json.dumps(r))
                if joined:
                    j_ts, j_kind, j_text = joined
                    print(f"    ↳ {j_kind} @ {j_ts}: {reasoning_excerpt(j_text)}")
                else:
                    print(f"    ↳ (no reasoning within {args.reasoning_window}s for {bot})")
            else:
                print(json.dumps(r))
        return 0

    total = len(records)
    by_result = Counter(r.get("result", "?") for r in records)
    by_bot_result = Counter((r.get("bot", "?"), r.get("result", "?")) for r in records)
    by_category = Counter((r.get("category", "?"), r.get("result", "?")) for r in records)

    print(f"# equip recovery events: {total}")
    print(f"# log file: {LOG_PATH}")
    print()
    print("# ── by result ──")
    for res in ("saved", "still_slow", "no_candidate"):
        n = by_result.get(res, 0)
        pct = (100 * n / total) if total else 0
        marker = (
            "  ← fallback is doing its job (desync recovery)"   if res == "saved" else
            "  ← workers using wrong-tier tools"                 if res == "still_slow" else
            "  ← see split below (comprehension vs capability)"  if res == "no_candidate" else
            ""
        )
        print(f"  {n:5d}  {pct:4.0f}%  {res}{marker}")
    print()

    # no_candidate sub-classification using inv_snapshot.
    nc_records = [r for r in records if r.get("result") == "no_candidate"]
    nc_total = len(nc_records)
    nc_could_craft = 0
    nc_capability_gap = 0
    nc_unknown = 0
    nc_could_craft_samples: list[dict] = []
    nc_capability_samples: list[dict] = []
    for r in nc_records:
        inv = r.get("inv_snapshot")
        if inv is None:
            nc_unknown += 1
            continue
        tier = feasible_tier(inv, r.get("category", "other"))
        if tier:
            nc_could_craft += 1
            r["_feasible_tier"] = tier
            if len(nc_could_craft_samples) < args.samples:
                nc_could_craft_samples.append(r)
        else:
            nc_capability_gap += 1
            if len(nc_capability_samples) < args.samples:
                nc_capability_samples.append(r)

    if nc_total:
        print("# ── no_candidate breakdown (comprehension vs capability) ──")
        def pct(n: int) -> str:
            return f"{(100 * n / nc_total):3.0f}%" if nc_total else "  -%"
        print(f"  {nc_could_craft:5d}  {pct(nc_could_craft)}  could_have_crafted   "
              "← inventory had recipe inputs (comprehension gap)")
        print(f"  {nc_capability_gap:5d}  {pct(nc_capability_gap)}  capability_gap       "
              "← inventory lacked precursor materials (kit gap)")
        if nc_unknown:
            print(f"  {nc_unknown:5d}  {pct(nc_unknown)}  unknown_no_snapshot  "
                  "← older records, predate inv_snapshot")
        print()

    print("# ── by bot × result ──")
    bots = sorted({k[0] for k in by_bot_result.keys()})
    results = ("saved", "still_slow", "no_candidate")
    header = "  " + " " * 12 + "  ".join(f"{r:>12s}" for r in results) + "  total"
    print(header)
    for bot in bots:
        row_total = sum(by_bot_result.get((bot, r), 0) for r in results)
        cells = "  ".join(f"{by_bot_result.get((bot, r), 0):>12d}" for r in results)
        print(f"  {bot:<12s}  {cells}  {row_total:>5d}")
    print()

    print("# ── by tool category × result ──")
    cats = sorted({k[0] for k in by_category.keys()})
    print(header)
    for cat in cats:
        cells = "  ".join(f"{by_category.get((cat, r), 0):>12d}" for r in results)
        row_total = sum(by_category.get((cat, r), 0) for r in results)
        print(f"  {cat:<12s}  {cells}  {row_total:>5d}")

    if args.by_block:
        print()
        print("# ── by block × result (top 12) ──")
        by_block = Counter((r.get("block", "?"), r.get("result", "?")) for r in records)
        block_totals: Counter[str] = Counter()
        for (block, _res), n in by_block.items():
            block_totals[block] += n
        for block, total_n in block_totals.most_common(12):
            row = {r: by_block.get((block, r), 0) for r in results}
            print(f"  {block:<24s}  saved={row['saved']:>4d}  "
                  f"still_slow={row['still_slow']:>4d}  "
                  f"no_candidate={row['no_candidate']:>4d}  total={total_n}")

    if args.with_reasoning and (nc_could_craft_samples or nc_capability_samples):
        print()
        print(f"# ── sample no_candidate events with reasoning (±{args.reasoning_window}s window) ──")

        def render_sample(label: str, sample: dict) -> None:
            bot = sample.get("bot", "?")
            ts = sample.get("ts", "")
            block = sample.get("block", "?")
            cat = sample.get("category", "?")
            inv = sample.get("inv_snapshot") or {}
            tier_note = (
                f" feasible_tier={sample.get('_feasible_tier')}"
                if sample.get("_feasible_tier") else ""
            )
            top_inv = ", ".join(
                f"{k}={v}" for k, v in sorted(inv.items(), key=lambda kv: -kv[1])[:6]
            ) or "(empty)"
            print(f"  [{label}] {bot} @ {ts}  block={block}  category={cat}{tier_note}")
            print(f"     inv: {top_inv}")
            joined = find_preceding_reasoning(bot, ts, args.reasoning_window)
            if joined:
                j_ts, j_kind, j_text = joined
                print(f"     {j_kind} @ {j_ts}: {reasoning_excerpt(j_text)}")
            else:
                print(f"     (no reasoning within {args.reasoning_window}s)")
            print()

        for s in nc_could_craft_samples:
            render_sample("could_have_crafted", s)
        for s in nc_capability_samples:
            render_sample("capability_gap", s)

    return 0


if __name__ == "__main__":
    sys.exit(main())

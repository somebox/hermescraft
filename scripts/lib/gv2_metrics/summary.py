from __future__ import annotations

from typing import Any


def evaluate_expected_metrics(
    expected: dict, flat: dict, *, context: dict | None = None
) -> dict:
    ctx = context or {}

    def resolve(key: str):
        if key in flat:
            return flat[key]
        node: Any = ctx
        for part in key.split("."):
            if not isinstance(node, dict):
                return None
            node = node.get(part)
        return node

    met: list[str] = []
    missed: list[str] = []
    for key, spec in (expected or {}).items():
        if isinstance(spec, dict):
            op = "max" if "max" in spec else "min"
            bound = spec.get(op)
            val = resolve(key)
            if val is None:
                missed.append(key)
                continue
            ok = val <= bound if op == "max" else val >= bound
            (met if ok else missed).append(f"{key}={val}")
        else:
            val = resolve(key)
            if val == spec:
                met.append(f"{key}={val}")
            else:
                missed.append(f"{key}!={spec}")
    return {"met": met, "missed": missed}


def compare_safe(motor: dict, retro_pending: int, audit: dict) -> bool:
    if retro_pending > 0:
        return False
    if (motor.get("server_down") or 0) > 0:
        return False
    ratio = audit.get("scope_coverage_ratio")
    if ratio is not None:
        # Cross-run counts (GoalChanged/craft) are only comparable when the durable
        # action logs were windowed to THIS run — otherwise prior-run rows poison them.
        # `scope_windowed` catches verbatim capture; the ratio catches a timestamp-parse
        # failure that would make the windowing itself unreliable.
        if not audit.get("scope_windowed"):
            return False
        if ratio < 0.5:
            return False
    return True


def build_summary(
    *,
    config: dict,
    metrics: dict,
    retro: dict,
    compare: dict | None = None,
    achievement_level: dict | None = None,
) -> dict:
    time_m = metrics.get("time") or {}
    motor = metrics.get("motor") or {}
    prod = metrics.get("production") or {}
    est = metrics.get("establishment") or {}
    cards = metrics.get("cards") or {}
    audit = metrics.get("audit") or {}
    retro_pending = retro.get("pending") or 0
    safe = compare_safe(motor, retro_pending, audit)
    flat = {
        "retro_pending": retro_pending,
        "establishment_score": est.get("score"),
        "craft_error_share": 0,
        **{k: v for k, v in (compare or {}).items()},
    }
    # Resolve dotted expected_metrics keys (e.g. audit.scope_coverage_ratio,
    # compare.compare_safe, establishment.score) against the full metric tree so a
    # selected WorkItem's expected_metrics can validate against any scored signal,
    # not just the handful flattened above.
    eval_ctx = {
        **metrics,
        "compare": {"compare_safe": safe},
        "achievement_level": achievement_level or {},
    }
    outcome = evaluate_expected_metrics(config.get("expected_metrics") or {}, flat, context=eval_ctx)
    wall_min = None
    if time_m.get("run_wall_s") is not None:
        wall_min = round(time_m["run_wall_s"] / 60.0, 1)
    bq = metrics.get("board_quality") or {}
    exceptions: list[str] = []
    if retro_pending:
        exceptions.append(f"retro_pending:{retro_pending}")
    if (motor.get("server_down") or 0) > 0:
        exceptions.append(f"mc_503:{motor.get('server_down')}")
    inv = bq.get("gv2_invalid")
    if inv:
        exceptions.append(f"gv2_invalid:{inv}")
    summary = {
        "loop_goal": config.get("loop_goal") or "",
        "hypothesis": config.get("hypothesis") or "",
        "expected_metrics": config.get("expected_metrics") or {},
        "what_changed": {
            "repo_commits": [],
            "config_vs_prev": [],
        },
        "outcome_vs_expected": outcome,
        "compare": {
            "prev_run_id": config.get("prev_run_id"),
            "baseline_run_id": config.get("validation_baseline_run_id"),
            "compare_safe": safe,
            "overall_delta_vs_prev": None,
            "overall_delta_vs_baseline": None,
            "note": "",
        },
        "headline": "Scored run",
        "band": "C",
        "overall": 50,
        "confidence": "medium",
        "operational": {
            "wall_min": wall_min,
            "cap_min": config.get("max_runtime_min"),
            "cards_done": time_m.get("cards_done"),
            "cards_total": time_m.get("cards_total"),
            "retro_done": f"{len(retro.get('done') or [])}/{retro.get('total') or 0}",
            "retro_pending": retro_pending,
            "smoke": metrics.get("smoke_status"),
            "exceptions": exceptions,
            "gv2_invalid": inv,
            "motor_errors_scoped": motor.get("errors"),
            "goalchanged": motor.get("goalchanged"),
            "server_down": motor.get("server_down"),
            "card_effectiveness_median": cards.get("effectiveness_median"),
            "active_mc_pct": (metrics.get("fleet") or {}).get("active_mc_pct"),
        },
        "achievement": {
            "establishment_score": est.get("score"),
            "production_critical_ok": prod.get("production_critical_ok"),
            "food_ratio": prod.get("food_ratio"),
            "milestones_met": [k for k, v in (est.get("milestones") or {}).items() if v == "yes"],
            "milestones_missed": [k for k, v in (est.get("milestones") or {}).items() if v == "no"],
        },
        "achievement_level": achievement_level or {},
        "target_achievement_level": config.get("target_achievement_level"),
    }
    return summary

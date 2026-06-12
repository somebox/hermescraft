"""Select capstone graph by CLI name."""

from __future__ import annotations

from pathlib import Path

from .discovery_graph import build_discovery_graph
from .plan_verify_graph import build_plan_verify_graph
from .proc_scout_graph import build_proc_scout_graph
from .proc_scout_road_graph import build_proc_scout_road_graph
from .proc_scout_stress_graph import build_proc_scout_stress_graph
from .w2_graph import build_w2_graph
from .wheat_graph import Graph, build_default_graph

GRAPH_NAMES = frozenset({
    "capstone",
    "w2",
    "discovery",
    "plan-verify",
    "proc-scout",
    "proc-scout-stress",
    "proc-scout-road",
})


def load_graph(
    name: str,
    *,
    repo_root: Path,
    w2_cycle: int = 1,
) -> Graph:
    if name == "capstone":
        return build_default_graph()
    if name == "w2":
        return build_w2_graph(repo_root=repo_root, cycle=w2_cycle)
    if name == "discovery":
        return build_discovery_graph()
    if name == "plan-verify":
        return build_plan_verify_graph()
    if name == "proc-scout":
        return build_proc_scout_graph()
    if name == "proc-scout-stress":
        return build_proc_scout_stress_graph()
    if name == "proc-scout-road":
        return build_proc_scout_road_graph()
    raise ValueError(f"unknown graph {name!r}; expected one of {sorted(GRAPH_NAMES)}")

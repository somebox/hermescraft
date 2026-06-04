#!/usr/bin/env python3
"""Build a graph from data/personal-pois-shared.json.

Every POI (sign-anchored OR torch-anchored) is a node. Two nodes are
adjacent if their anchor coords are within `--max-edge-step` blocks
(default 30 — just over the 25-block torch-spacing target). The graph
is undirected and unweighted-by-hop, weighted-by-distance.

Named nodes are POIs with `sign_at` (= landmarks; what Steward dispatches
*to*). Waypoint nodes are torch-only (= the trail between landmarks).

Outputs (JSON to stdout):
    nodes               [{name, x, y, z, kind, named, anchor, owner}]
                        every POI; `named=true` iff sign_at present
    edges               [{from, to, length}]   direct adjacencies
    connected_components
    quadrants_covered   per-component sorted [NE,NW,SE,SW] subset
    longest_path        [name1, name2, ...]    longest simple path
    longest_path_len    float
    frontier_nodes      sorted names with graph degree <= 1
    named_frontier      frontier nodes that are also named — Steward
                        dispatches the next path FROM one of these
    summary             { node_count, named_count, waypoint_count,
                         edge_count, component_count, frontier_count,
                         named_frontier_count, longest_path_len,
                         max_edge_step, muster }

Used by Steward each cycle (`[MAP:ARENA]` rubric) to pick the next
path-card destination, and by `scripts/establish-mapping-check.py` to
compute graph-level coverage metrics.

CLI flags:
    --shared PATH       override data/personal-pois-shared.json
    --max-edge-step N   default 30 (blocks)
    --muster X Y Z      reference point for quadrant classification
    --pretty            indent JSON output
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SHARED = ROOT / "data" / "personal-pois-shared.json"


def _coord(entry: dict) -> tuple[int, int, int] | None:
    """Floored (x,y,z) tuple from a POI entry; None if malformed."""
    try:
        return int(entry["x"]), int(entry["y"]), int(entry["z"])
    except (KeyError, TypeError, ValueError):
        return None


def _anchor(entry: dict, key: str) -> tuple[int, int, int] | None:
    a = entry.get(key)
    if not isinstance(a, dict):
        return None
    return _coord(a)


def _dist(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)


def _quadrant(x: int, z: int, mx: int = 0, mz: int = 0) -> str:
    """Same convention as establish-mapping-check.py: -z=N, +x=E, origin → SE."""
    dx, dz = x - mx, z - mz
    if dx >= 0 and dz < 0:
        return "NE"
    if dx < 0 and dz < 0:
        return "NW"
    if dx >= 0 and dz >= 0:
        return "SE"
    return "SW"


def load_pois(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def build_nodes(pois: dict) -> list[dict]:
    """Every POI with at least one anchor (sign_at or torch_at) becomes
    a graph node. `named=True` iff sign_at present (= landmark);
    otherwise the node is a waypoint (torch-only).

    A POI with neither anchor is invisible to other agents and isn't
    part of the graph — it might be a private note or stale entry.
    """
    nodes: list[dict] = []
    for name, p in pois.items():
        if not isinstance(p, dict):
            continue
        sign_at = _anchor(p, "sign_at")
        torch_at = _anchor(p, "torch_at")
        # Graph position: sign anchor wins; fall back to torch anchor; fall
        # back to the POI's own xyz so we still place the node somewhere.
        anchor = sign_at or torch_at
        if anchor is None:
            continue
        coord = _coord(p) or anchor
        nodes.append({
            "name": name,
            "x": coord[0], "y": coord[1], "z": coord[2],
            "anchor": {"x": anchor[0], "y": anchor[1], "z": anchor[2]},
            "kind": p.get("kind"),
            "named": sign_at is not None,
            "owner": p.get("agent_owner"),
        })
    return nodes


def build_edges(nodes: list[dict], max_step: float) -> list[dict]:
    """All-pairs adjacency: two nodes are connected if their anchor coords
    are within `max_step` blocks. O(N²) — fine at the expected scale of
    tens-of-POIs per run; swap for a spatial index if we hit hundreds.
    """
    edges: list[dict] = []
    for i in range(len(nodes)):
        ai = (nodes[i]["anchor"]["x"], nodes[i]["anchor"]["y"], nodes[i]["anchor"]["z"])
        for j in range(i + 1, len(nodes)):
            aj = (nodes[j]["anchor"]["x"], nodes[j]["anchor"]["y"], nodes[j]["anchor"]["z"])
            d = _dist(ai, aj)
            if d <= max_step:
                edges.append({
                    "from": nodes[i]["name"],
                    "to": nodes[j]["name"],
                    "length": round(d, 1),
                })
    return edges


def find_components(nodes: list[dict], edges: list[dict]) -> list[list[str]]:
    adj: dict[str, set[str]] = defaultdict(set)
    for n in nodes:
        adj[n["name"]]  # ensure isolated nodes show up
    for e in edges:
        adj[e["from"]].add(e["to"])
        adj[e["to"]].add(e["from"])
    seen: set[str] = set()
    components: list[list[str]] = []
    for name in adj:
        if name in seen:
            continue
        comp = []
        q = deque([name])
        while q:
            cur = q.popleft()
            if cur in seen:
                continue
            seen.add(cur)
            comp.append(cur)
            q.extend(adj[cur] - seen)
        components.append(sorted(comp))
    return components


def longest_path(nodes: list[dict], edges: list[dict]) -> tuple[list[str], float]:
    """Longest simple path through the graph by total edge length.

    Brute-force DFS bounded by the (expected small) node count. We don't
    need optimality at scale — this is for ranking the current map's
    spinal column, not for production routing.

    Single-node graph: returns [node_name] with length 0.0. Empty graph:
    returns ([], 0.0).
    """
    adj: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for e in edges:
        adj[e["from"]].append((e["to"], e["length"]))
        adj[e["to"]].append((e["from"], e["length"]))

    node_names = [n["name"] for n in nodes]
    if not node_names:
        return [], 0.0

    # Initialise with the first node so single-node + isolated-node graphs
    # surface a non-empty `longest_path` for downstream consumers.
    best_path: list[str] = [node_names[0]]
    best_len = 0.0

    def dfs(node: str, length: float, path: list[str], visited: set[str]) -> None:
        nonlocal best_path, best_len
        if length > best_len or (length == best_len and len(path) > len(best_path)):
            best_len = length
            best_path = list(path)
        for nb, seg in adj[node]:
            if nb in visited:
                continue
            visited.add(nb)
            path.append(nb)
            dfs(nb, length + seg, path, visited)
            path.pop()
            visited.remove(nb)

    for start in node_names:
        dfs(start, 0.0, [start], {start})
    return best_path, round(best_len, 1)


def frontier_nodes(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Nodes with degree <= 1 (good candidates for next-path-from)."""
    deg: dict[str, int] = defaultdict(int)
    for n in nodes:
        deg[n["name"]] = 0
    for e in edges:
        deg[e["from"]] += 1
        deg[e["to"]] += 1
    return sorted(name for name, d in deg.items() if d <= 1)


def quadrants_per_component(
    nodes: list[dict], components: list[list[str]], muster: tuple[int, int, int] | None,
) -> list[list[str]]:
    by_name = {n["name"]: n for n in nodes}
    mx = muster[0] if muster else 0
    mz = muster[2] if muster else 0
    out = []
    for comp in components:
        quads = set()
        for name in comp:
            n = by_name.get(name)
            if not n:
                continue
            # Use the anchor coord (where the sign/torch is actually
            # placed in-world), not the POI's own x/z which defaults to
            # the bot's foot position at registration time. Live evidence
            # (2026-06-04): Gatherer's frozen_north had bot pos (4,-43)
            # but sign_at (-1,-45) — the bot was 1 block east of the
            # sign when she ran poi_add. NW landmark was being classified
            # as NE because of the foot offset.
            ax = n.get("anchor", {}).get("x", n["x"])
            az = n.get("anchor", {}).get("z", n["z"])
            quads.add(_quadrant(int(ax), int(az), mx, mz))
        out.append(sorted(quads))
    return out


def build_graph(shared_path: Path, max_step: float,
                muster: tuple[int, int, int] | None = None) -> dict:
    pois = load_pois(shared_path)
    nodes = build_nodes(pois)
    edges = build_edges(nodes, max_step)
    components = find_components(nodes, edges)
    quads = quadrants_per_component(nodes, components, muster)
    lp, lp_len = longest_path(nodes, edges)
    fr = frontier_nodes(nodes, edges)
    named_names = {n["name"] for n in nodes if n["named"]}
    named_fr = sorted(name for name in fr if name in named_names)
    return {
        "nodes": nodes,
        "edges": edges,
        "connected_components": components,
        "quadrants_covered": quads,
        "longest_path": lp,
        "longest_path_len": lp_len,
        "frontier_nodes": fr,
        "named_frontier": named_fr,
        "summary": {
            "node_count": len(nodes),
            "named_count": len(named_names),
            "waypoint_count": len(nodes) - len(named_names),
            "edge_count": len(edges),
            "component_count": len(components),
            "frontier_count": len(fr),
            "named_frontier_count": len(named_fr),
            "longest_path_len": lp_len,
            "max_edge_step": max_step,
            "muster": list(muster) if muster else None,
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--shared", type=Path, default=DEFAULT_SHARED)
    ap.add_argument("--max-edge-step", type=float, default=30.0)
    ap.add_argument("--muster", type=int, nargs=3, metavar=("X", "Y", "Z"))
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    muster = tuple(args.muster) if args.muster else None
    graph = build_graph(args.shared, args.max_edge_step, muster)
    if args.pretty:
        print(json.dumps(graph, indent=2))
    else:
        print(json.dumps(graph))
    return 0


if __name__ == "__main__":
    sys.exit(main())

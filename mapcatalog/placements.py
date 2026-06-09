from __future__ import annotations

import re
from typing import Any

from mapcatalog.models import PlacementSpec

_RANDOM_SAFE = re.compile(
    r"^random_safe(?:\s+radius\s+(?P<radius>\d+))?(?:\s+attempts\s+(?P<attempts>\d+))?",
    re.IGNORECASE,
)
_OFFSET = re.compile(
    r"^offset_from\s+(?P<from>\w+)\s+\[(?P<dx>-?\d+),\s*(?P<dy>-?\d+),\s*(?P<dz>-?\d+)\]\s*$",
    re.IGNORECASE,
)
_GROUND_OFFSET = re.compile(
    r"^ground_offset_from\s+(?P<from>\w+)\s+\[(?P<dx>-?\d+),\s*(?P<dy>-?\d+),\s*(?P<dz>-?\d+)\]\s*$",
    re.IGNORECASE,
)
_FLAT_CENTER = re.compile(r"^flat_patch_center\s*$", re.IGNORECASE)
_NEAR_BLOCK = re.compile(
    r"near\s+block\s+(?P<block>[\w:]+)\s+within\s+(?P<n>\d+)\s+(?P<unit>cells|blocks)",
    re.IGNORECASE,
)
_NEAR_GATE = re.compile(
    r"near\s+gate\s+(?P<gate>\w+)\s+within\s+(?P<n>\d+)\s+(?P<unit>cells|blocks)",
    re.IGNORECASE,
)
_IN_BIOME = re.compile(r"in_biome\s+(?P<biome>\w+)", re.IGNORECASE)


def parse_placement_value(name: str, value: str | dict[str, Any]) -> PlacementSpec:
    if isinstance(value, dict):
        return _parse_structured(name, value)
    text = str(value).strip()
    spec = PlacementSpec(name=name, method="random_safe", raw=text)

    if _FLAT_CENTER.match(text):
        spec.method = "flat_patch_center"
        return spec

    m = _OFFSET.match(text)
    if m:
        spec.method = "offset_from"
        spec.offset_from = m.group("from")
        spec.offset = (int(m.group("dx")), int(m.group("dy")), int(m.group("dz")))
        return spec

    m = _GROUND_OFFSET.match(text)
    if m:
        spec.method = "ground_offset_from"
        spec.offset_from = m.group("from")
        spec.offset = (int(m.group("dx")), int(m.group("dy")), int(m.group("dz")))
        return spec

    if not text.lower().startswith("random_safe"):
        raise ValueError(f"unknown placement for {name!r}: {text!r}")

    spec.method = "random_safe"
    m = _RANDOM_SAFE.match(text)
    if m:
        if m.group("radius"):
            spec.radius = int(m.group("radius"))
        if m.group("attempts"):
            spec.attempts = int(m.group("attempts"))
    att = re.search(r"attempts\s+(?P<attempts>\d+)", text, re.IGNORECASE)
    if att:
        spec.attempts = int(att.group("attempts"))
    rad = re.search(r"radius\s+(?P<radius>\d+)", text, re.IGNORECASE)
    if rad:
        spec.radius = int(rad.group("radius"))

    m = _NEAR_BLOCK.search(text)
    if m:
        spec.near_block = m.group("block")
        spec.within = float(m.group("n"))
        spec.within_unit = m.group("unit").lower()
    m = _NEAR_GATE.search(text)
    if m:
        spec.near_gate = m.group("gate")
        spec.within = float(m.group("n"))
        spec.within_unit = m.group("unit").lower()
    m = _IN_BIOME.search(text)
    if m:
        spec.in_biome = m.group("biome")

    return spec


def _parse_structured(name: str, d: dict[str, Any]) -> PlacementSpec:
    method = str(d.get("method", "random_safe"))
    spec = PlacementSpec(name=name, method=method, raw=d)
    if method == "random_safe":
        spec.radius = d.get("radius")
        spec.attempts = d.get("attempts")
        near = d.get("near")
        if isinstance(near, dict):
            if "block" in near:
                spec.near_block = str(near["block"])
            if "gate" in near:
                spec.near_gate = str(near["gate"])
        within = d.get("within")
        if within:
            from mapcatalog.units import parse_unit

            if isinstance(within, str) and "block" in within:
                parts = within.split()
                spec.within = float(parts[0])
                spec.within_unit = "blocks"
            elif isinstance(within, str):
                pu = parse_unit(within)
                spec.within = float(pu.value)
                spec.within_unit = "cells" if pu.kind == "cells" else "blocks"
        if "in_biome" in d:
            spec.in_biome = str(d["in_biome"])
    elif method == "offset_from":
        spec.offset_from = str(d["from"])
        off = d["offset"]
        spec.offset = (int(off[0]), int(off[1]), int(off[2]))
    return spec


def placement_dependencies(spec: PlacementSpec) -> set[str]:
    """Topological-sort dependencies on OTHER PLACEMENTS only.

    ``near_gate`` references a gate name from ``gates:``, not a placement.
    Gates are resolved separately during arena evaluation; including
    them here makes the topological sort fail with
    ``"placement 'overlook' references unknown 'flat_patch'"`` even
    when the gate is correctly defined under ``gates:``.

    Discovered when trying to materialize seed 20240601 for
    scenario_scout_overlook — same scenario worked on seed 1001 only
    because the prior trial path went through scenario-agent-test.sh
    instead of ``mapcatalog try`` directly.
    """
    deps: set[str] = set()
    if spec.offset_from:
        deps.add(spec.offset_from)
    return deps


def topological_sort_placements(specs: list[PlacementSpec]) -> list[PlacementSpec]:
    by_name = {s.name: s for s in specs}
    if len(by_name) != len(specs):
        dupes = [s.name for s in specs]
        raise ValueError(f"duplicate placement names: {dupes}")

    order: list[PlacementSpec] = []
    visiting: set[str] = set()
    done: set[str] = set()

    def visit(name: str) -> None:
        if name in done:
            return
        if name in visiting:
            raise ValueError(f"placement cycle involving {name!r}")
        visiting.add(name)
        spec = by_name.get(name)
        if spec is None:
            raise ValueError(f"placement {name!r} referenced but not defined")
        for dep in placement_dependencies(spec):
            if dep not in by_name:
                raise ValueError(f"placement {name!r} references unknown {dep!r}")
            visit(dep)
        visiting.remove(name)
        done.add(name)
        order.append(spec)

    for s in specs:
        visit(s.name)
    return order

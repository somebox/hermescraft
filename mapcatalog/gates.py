from __future__ import annotations

import re
from typing import Any

from mapcatalog.models import (
    BiomeCountGate,
    BiomeFractionGate,
    FlatPatchGate,
    Gate,
    HeightJitterGate,
    OreHitsGate,
    SurfaceBlockGate,
)
from mapcatalog.units import parse_fraction, parse_unit

_BIOME_ID = re.compile(
    r"^biome\s+in\s+\[(?P<allow>[^\]]+)\]\s*(?P<op>>=|<=)\s*(?P<val>[^\s]+)\s*$",
    re.IGNORECASE,
)
_BIOME_COUNT = re.compile(
    r"^biomes\s+distinct\s*(?P<op><=|>=)\s*(?P<val>\d+)\s*(?:biomes)?\s*$",
    re.IGNORECASE,
)
_FLAT_PATCH = re.compile(
    r"^flat\s+patch\s*(?P<op>>=|<=)\s*(?P<val>[^\s]+(?:\s+[^\s]+)?)\s*$",
    re.IGNORECASE,
)
_HEIGHT = re.compile(
    r"^neighbor\s+height\s+delta\s*(?P<op><=|>=)\s*(?P<val>[^\s]+(?:\s+[^\s]+)?)\s*$",
    re.IGNORECASE,
)
_SURFACE = re.compile(
    r"^surface\s+(?P<block>\w+)\s*(?P<op><=|>=)\s*(?P<val>[^\s]+)\s*$",
    re.IGNORECASE,
)
_BLOCK_HITS_GE = re.compile(
    r"^block\s+(?P<block>[\w:]+)\s+hits\s*>=\s*(?P<min>\d+)\s+in\s+y\s+"
    r"(?P<y0>-?\d+)\.\.(?P<y1>-?\d+)\s+step\s+(?P<step>\d+)\s*$",
    re.IGNORECASE,
)
_BLOCK_HITS_RANGE = re.compile(
    r"^block\s+(?P<block>[\w:]+)\s+hits\s+(?P<lo>\d+)\.\.(?P<hi>\d+)\s+in\s+y\s+"
    r"(?P<y0>-?\d+)\.\.(?P<y1>-?\d+)\s+step\s+(?P<step>\d+)\s*$",
    re.IGNORECASE,
)


def _norm_biome(name: str) -> str:
    name = name.strip().strip("'\"")
    if ":" in name:
        return name
    return f"minecraft:{name}"


def _split_allow(raw: str) -> list[str]:
    parts = re.split(r",\s*", raw.strip())
    return [_norm_biome(p) for p in parts if p.strip()]


def _block_id(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("minecraft:"):
        return raw
    return f"minecraft:{raw}"


def parse_gate_line(line: str) -> Gate:
    text = line.strip()
    if not text or text.startswith("#"):
        raise ValueError("empty gate line")

    m = _BIOME_ID.match(text)
    if m:
        op = m.group("op")
        if op != ">=":
            raise ValueError(f"biome fraction only supports >=, got {text!r}")
        return BiomeFractionGate(
            allow=_split_allow(m.group("allow")),
            min_fraction=parse_fraction(m.group("val")),
        )

    m = _BIOME_COUNT.match(text)
    if m:
        op = m.group("op")
        val = int(m.group("val"))
        if op == "<=":
            return BiomeCountGate(max_distinct=val)
        if op == ">=":
            return BiomeCountGate(min_distinct=val)
        raise ValueError(f"biomes distinct supports <= or >=, got {text!r}")

    m = _FLAT_PATCH.match(text)
    if m:
        op = m.group("op")
        if op != ">=":
            raise ValueError(f"flat patch only supports >=, got {text!r}")
        pu = parse_unit(m.group("val"), expect="cells")
        return FlatPatchGate(min_cells=int(pu.value))

    m = _HEIGHT.match(text)
    if m:
        op = m.group("op")
        if op != "<=":
            raise ValueError(f"neighbor height delta only supports <=, got {text!r}")
        pu = parse_unit(m.group("val"), expect="blocks")
        return HeightJitterGate(max_blocks=float(pu.value))

    m = _SURFACE.match(text)
    if m:
        frac = parse_fraction(m.group("val"))
        op = m.group("op")
        block = m.group("block").lower()
        if op == "<=":
            return SurfaceBlockGate(block=block, max_fraction=frac)
        return SurfaceBlockGate(block=block, min_fraction=frac)

    m = _BLOCK_HITS_GE.match(text)
    if m:
        return OreHitsGate(
            block=_block_id(m.group("block")),
            min_hits=int(m.group("min")),
            y_range=(int(m.group("y0")), int(m.group("y1"))),
            grid_step=int(m.group("step")),
        )

    m = _BLOCK_HITS_RANGE.match(text)
    if m:
        return OreHitsGate(
            block=_block_id(m.group("block")),
            min_hits=int(m.group("lo")),
            max_hits=int(m.group("hi")),
            y_range=(int(m.group("y0")), int(m.group("y1"))),
            grid_step=int(m.group("step")),
        )

    raise ValueError(f"unrecognized gate line: {text!r}")


def parse_gate_item(item: str | dict[str, Any]) -> Gate:
    if isinstance(item, str):
        return parse_gate_line(item)
    if not isinstance(item, dict):
        raise ValueError(f"gate must be string or dict, got {type(item)}")
    kind = item.get("gate")
    if kind == "biome_fraction":
        return BiomeFractionGate(
            allow=[_norm_biome(b) for b in item["allow"]],
            min_fraction=parse_fraction(item["min"]),
            sample_y=int(item.get("sample_y", 64)),
            grid_step=int(item.get("grid_step", 16)),
        )
    if kind == "biome_count":
        return BiomeCountGate(
            max_distinct=int(item["max"]) if "max" in item else None,
            min_distinct=int(item["min"]) if "min" in item else None,
            sample_y=int(item.get("sample_y", 64)),
            grid_step=int(item.get("grid_step", 16)),
        )
    if kind == "flat_patch":
        pu = parse_unit(item["min"], expect="cells")
        return FlatPatchGate(min_cells=int(pu.value), grid_step=int(item.get("grid_step", 16)))
    if kind == "height_jitter":
        pu = parse_unit(item["max"], expect="blocks")
        return HeightJitterGate(max_blocks=float(pu.value), grid_step=int(item.get("grid_step", 16)))
    if kind == "surface_block":
        block = str(item["block"]).lower()
        g = SurfaceBlockGate(block=block, grid_step=int(item.get("grid_step", 16)))
        if "max" in item:
            g.max_fraction = parse_fraction(item["max"])
        if "min" in item:
            g.min_fraction = parse_fraction(item["min"])
        return g
    if kind == "ore_hits":
        y_range = item.get("y_range", [-32, 48])
        g = OreHitsGate(
            block=_block_id(str(item["block"])),
            y_range=(int(y_range[0]), int(y_range[1])),
            grid_step=int(item.get("step", 8)),
        )
        if "min" in item:
            g.min_hits = int(item["min"])
        if "max" in item:
            g.max_hits = int(item["max"])
        if "range" in item:
            g.min_hits, g.max_hits = int(item["range"][0]), int(item["range"][1])
        return g
    raise ValueError(f"unknown structured gate kind: {kind!r}")


def gate_label(g: Gate) -> str:
    if isinstance(g, BiomeFractionGate):
        ids = ", ".join(b.split(":")[-1] for b in g.allow)
        return f"biome in [{ids}] >= {g.min_fraction:.0%}"
    if isinstance(g, BiomeCountGate):
        if g.max_distinct is not None:
            return f"biomes distinct <= {g.max_distinct}"
        return f"biomes distinct >= {g.min_distinct}"
    if isinstance(g, FlatPatchGate):
        return f"flat patch >= {g.min_cells} cells"
    if isinstance(g, HeightJitterGate):
        return f"neighbor height delta <= {g.max_blocks} blocks"
    if isinstance(g, SurfaceBlockGate):
        if g.max_fraction is not None:
            return f"surface {g.block} <= {g.max_fraction:.0%}"
        return f"surface {g.block} >= {g.min_fraction:.0%}"
    if isinstance(g, OreHitsGate):
        band = f"y {g.y_range[0]}..{g.y_range[1]} step {g.grid_step}"
        if g.min_hits is not None and g.max_hits is not None:
            return f"block {g.block} hits {g.min_hits}..{g.max_hits} in {band}"
        return f"block {g.block} hits >= {g.min_hits} in {band}"
    return repr(g)

"""Parse suffix units from gate and placement YAML."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

UnitKind = Literal["fraction", "cells", "blocks", "biomes", "hits", "count"]


@dataclass(frozen=True)
class ParsedUnit:
    kind: UnitKind
    value: float | int


_PERCENT_RE = re.compile(r"^(-?\d+(?:\.\d+)?)\s*%\s*$")
_SUFFIX_RE = re.compile(
    r"^(-?\d+(?:\.\d+)?)\s*(cells|blocks|biomes|hits)\s*$", re.IGNORECASE
)


def parse_fraction(s: str | float | int) -> float:
    if isinstance(s, (int, float)):
        v = float(s)
        if v > 1.0:
            return v / 100.0
        return v
    text = str(s).strip()
    m = _PERCENT_RE.match(text)
    if m:
        return float(m.group(1)) / 100.0
    if text.endswith("%"):
        return float(text[:-1].strip()) / 100.0
    v = float(text)
    return v / 100.0 if v > 1.0 else v


def parse_unit(s: str | int | float, *, expect: UnitKind | None = None) -> ParsedUnit:
    if isinstance(s, bool):
        raise ValueError(f"invalid unit: {s!r}")
    if isinstance(s, int) and expect in ("hits", "cells", "biomes", "count"):
        return ParsedUnit(expect, s)
    if isinstance(s, float) and expect == "fraction":
        return ParsedUnit("fraction", s if s <= 1.0 else s / 100.0)

    text = str(s).strip()
    m = _PERCENT_RE.match(text)
    if m:
        return ParsedUnit("fraction", float(m.group(1)) / 100.0)
    m = _SUFFIX_RE.match(text)
    if m:
        val = float(m.group(1))
        kind = m.group(2).lower()  # type: ignore[assignment]
        if kind == "hits":
            return ParsedUnit("hits", int(val))
        if kind == "biomes":
            return ParsedUnit("biomes", int(val))
        if kind == "cells":
            return ParsedUnit("cells", int(val))
        return ParsedUnit("blocks", val)

    if expect == "fraction":
        return ParsedUnit("fraction", parse_fraction(text))
    if expect in ("hits", "cells", "biomes", "count"):
        return ParsedUnit(expect, int(float(text)))
    if expect == "blocks":
        return ParsedUnit("blocks", float(text))

    raise ValueError(f"cannot parse unit: {text!r}")


def format_fraction_yaml(f: float) -> str:
    return f"{round(f * 100, 4)}%"

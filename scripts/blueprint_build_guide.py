"""Render markdown build guides from blueprint plan JSON (mirrors bot footprint math)."""
from __future__ import annotations

import math
from collections import Counter
from typing import Any

from blueprint_lib import (
    anchor_from_marker,
    floor_world_y,
    footprint_mins,
    is_door_block,
    materials_planned_from_cells,
    metadata_footprint,
    tight_footprint_from_cells,
)

FILL_MAX_VOLUME = 500


def resolve_footprint(plan: dict) -> dict:
    fp = plan.get("footprint")
    if fp and fp.get("local"):
        return fp
    meta = (plan.get("source") or {}).get("dimensions") or plan.get("metadata") or {}
    if meta.get("width"):
        return metadata_footprint(meta)
    return tight_footprint_from_cells(plan.get("cells") or [])


def local_to_world(
    anchor: list[int], footprint: dict, lx: int, ly: int, lz: int
) -> tuple[int, int, int]:
    mx, my, mz = footprint_mins(footprint)
    return (
        anchor[0] + (lx - mx),
        anchor[1] + (ly - my),
        anchor[2] + (lz - mz),
    )


def resolve_anchor(plan: dict, anchor_override: list[int] | None) -> list[int]:
    if anchor_override and len(anchor_override) == 3:
        return anchor_override
    coords = (plan.get("anchor") or {}).get("coords")
    if coords and len(coords) == 3:
        return [int(coords[0]), int(coords[1]), int(coords[2])]
    raise ValueError("Plan missing anchor.coords; pass --anchor x,y,z")


def plan_id_from(plan: dict, fallback: str) -> str:
    return str(plan.get("plan_id") or fallback)


def materials_from_plan(plan: dict) -> list[tuple[str, int]]:
    mp = plan.get("materials_planned")
    if mp:
        return [(str(r["item"]), int(r["count"])) for r in mp]
    return materials_planned_from_cells(plan.get("cells") or [])


def layer_y_values(plan: dict) -> list[int]:
    phases = plan.get("phases") or []
    if phases:
        return sorted({int(p["layer_y"]) for p in phases if p.get("layer_y") is not None})
    ys = {c["local"][1] for c in plan.get("cells") or []}
    return sorted(ys)


def _largest_rect_greedy(points: set[tuple[int, int]]) -> tuple[int, int, int, int] | None:
    if not points:
        return None
    best: tuple[int, int, int, int] | None = None
    best_area = 0
    for lx, lz in list(points):
        max_x = lx
        while (max_x + 1, lz) in points:
            max_x += 1
        max_z = lz
        extended = True
        while extended:
            extended = False
            row_ok = all((x, max_z + 1) in points for x in range(lx, max_x + 1))
            if row_ok:
                max_z += 1
                extended = True
        area = (max_x - lx + 1) * (max_z - lz + 1)
        if area > best_area:
            best_area = area
            best = (lx, lz, max_x, max_z)
    return best


def _split_box(lx: int, lz: int, max_x: int, max_z: int, max_vol: int) -> list[tuple[int, int, int, int]]:
    vol = (max_x - lx + 1) * (max_z - lz + 1)
    if vol <= max_vol:
        return [(lx, lz, max_x, max_z)]
    out: list[tuple[int, int, int, int]] = []
    dx = max_x - lx + 1
    dz = max_z - lz + 1
    # slice along X into strips each <= max_vol when height dz fixed
    strip_w = max(1, max_vol // dz)
    x = lx
    while x <= max_x:
        x2 = min(max_x, x + strip_w - 1)
        out.append((x, lz, x2, max_z))
        x = x2 + 1
    return out


def cluster_fill_boxes(
    layer_cells: list[dict], block: str, *, max_volume: int = FILL_MAX_VOLUME
) -> list[tuple[int, int, int, int, str]]:
    """Return list of (lx, lz, max_x, max_z, block) on this layer (single local Y)."""
    points = {(c["local"][0], c["local"][2]) for c in layer_cells if c["block"] == block}
    boxes: list[tuple[int, int, int, int, str]] = []
    while points:
        rect = _largest_rect_greedy(points)
        if not rect:
            break
        lx, lz, max_x, max_z = rect
        for sub in _split_box(lx, lz, max_x, max_z, max_volume):
            slx, slz, sx2, sz2 = sub
            for x in range(slx, sx2 + 1):
                for z in range(slz, sz2 + 1):
                    points.discard((x, z))
            boxes.append((slx, slz, sx2, sz2, block))
    return boxes


def cells_covered_by_boxes(layer_cells: list[dict], boxes: list[tuple]) -> set[tuple[int, int, int]]:
    if not layer_cells:
        return set()
    ly = layer_cells[0]["local"][1]
    covered: set[tuple[int, int, int]] = set()
    for lx, lz, max_x, max_z, _block in boxes:
        for x in range(lx, max_x + 1):
            for z in range(lz, max_z + 1):
                covered.add((x, ly, z))
    return covered


def site_prep_section(
    anchor: list[int],
    footprint: dict,
    *,
    pad: int = 1,
) -> tuple[str, dict[str, Any]]:
    loc = footprint["local"]
    mx, my, mz = footprint_mins(footprint)
    wx_corners = []
    for lx, lz in (
        (loc["x"][0] - pad, loc["z"][0] - pad),
        (loc["x"][1] + pad, loc["z"][0] - pad),
        (loc["x"][0] - pad, loc["z"][1] + pad),
        (loc["x"][1] + pad, loc["z"][1] + pad),
    ):
        wx, wy, wz = local_to_world(anchor, footprint, lx, my, lz)
        wx_corners.append((wx, wy, wz))
    x_vals = [c[0] for c in wx_corners]
    z_vals = [c[2] for c in wx_corners]
    x1, x2 = min(x_vals), max(x_vals)
    z1, z2 = min(z_vals), max(z_vals)
    prep_y = floor_world_y(anchor, footprint)

    lines = [
        "Run terrain checks before building (bot must be on site):",
        "",
        f"**Foundation plane:** layer 1 builds at world **Y={prep_y}**. "
        f"Placemark sign Y should match (e.g. `:hut1:` at **Y={prep_y}**).",
        "",
    ]
    for i, (wx, _wy, wz) in enumerate(wx_corners, 1):
        lines.append(f"{i}. `mc terrain_top {wx} {wz}` — corner {i} surface Y")
    lines.extend(
        [
            "",
            f"If corner surface Y spread **> 2 blocks**, flatten the pad to the foundation plane:",
            f"`mc level {x1} {z1} {x2} {z2} {prep_y}`",
            "",
            f"(Levels columns **at** Y={prep_y} — same as layer 1 / placemark; digs blocks above, fills air at Y.)",
            "",
            f"Prep footprint XZ (includes {pad}-block margin): **{x1}..{x2}**, **{z1}..{z2}**.",
            "",
            "If the site is below grade, dig or strip-mine before leveling; if above, "
            "level/fill is usually enough (see `minecraft-building` log-cabin prep).",
        ]
    )
    meta = {"prep_x1": x1, "prep_z1": z1, "prep_x2": x2, "prep_z2": z2, "prep_y": prep_y, "corners": wx_corners}
    return "\n".join(lines), meta


def render_markdown(
    plan: dict,
    *,
    plan_id: str,
    anchor: list[int],
    worksite: str | None = None,
    region: str | None = None,
    supplies_chest: tuple[int, int, int] | None = None,
    buffer_pct: float = 0.0,
    place_cap_per_layer: int = 30,
    fill_max_volume: int = FILL_MAX_VOLUME,
) -> str:
    footprint = resolve_footprint(plan)
    loc = footprint["local"]
    cells = plan.get("cells") or []
    layers = layer_y_values(plan)
    source = plan.get("source") or {}
    verify_target = f":{region.strip(':')}:" if region else plan_id
    floor_y = floor_world_y(anchor, footprint)
    marker = (plan.get("anchor") or {}).get("marker") or {}
    marker_coords = marker.get("coords")

    lines: list[str] = [
        f"# Build guide: {plan_id}",
        "",
        "## Summary",
        "",
        f"- **Plan file:** `data/ops/plans/{plan_id}-plan.json`",
        f"- **Source:** {source.get('type', 'unknown')}"
        + (f" — {source.get('name')}" if source.get("name") else ""),
        f"- **World anchor (min corner):** `{anchor[0]}, {anchor[1]}, {anchor[2]}`",
        f"- **Foundation / layer 1 world Y:** **{floor_y}** (must match placemark sign Y)",
        f"- **Footprint (local):** x={loc['x']} y={loc['y']} z={loc['z']}",
        f"- **Cells:** {len(cells)} across **{len(layers)}** layer(s)",
        "",
    ]
    if marker_coords and len(marker_coords) == 3:
        mx, my, mz = marker_coords
        lines.append(f"- **Placemark center:** `{mx}, {my}, {mz}`")
        if int(my) != floor_y:
            lines.append(
                f"- **Warning:** placemark Y ({my}) ≠ foundation Y ({floor_y}); "
                "re-import with `--marker` or fix `anchor.coords`."
            )
        lines.append("")

    if region:
        rid = region.strip(":").lower()
        lines.extend(
            [
                "## Placemark sign",
                "",
                f"Use placemark **`:{rid}:`** on line 1 of the in-world sign (region id `{rid}`).",
                "Break/replace the sign to change text; then `mc regions_rescan_signs` with a bot in chunk.",
                "",
                "Example:",
                "",
                "```text",
                f":{rid}:",
                f"region={rid}",
                "r=16",
                "intent=marker",
                "```",
                "",
                f"Navigation: `mc goto :{rid}:` · site ref in plan: `:{rid}:/anchor`",
                "",
            ]
        )

    if worksite:
        lines.extend(
            [
                "## Worksite (protect regions)",
                "",
                f"Before dig/place inside a protect region: `mc task_context set {worksite}`",
                "Clear on card complete: `mc task_context clear`",
                "",
            ]
        )

    lines.extend(["## Materials", ""])
    mats = materials_from_plan(plan)
    lines.append("| Item | Count | Suggested gather |")
    lines.append("|------|------:|------------------|")
    for item, count in mats:
        need = count if buffer_pct <= 0 else math.ceil(count * (1 + buffer_pct / 100))
        lines.append(f"| `{item}` | {count} | `mc collect {item} {need}` |")
    lines.append("")
    if supplies_chest:
        cx, cy, cz = supplies_chest
        lines.append(f"Deposit surplus at supplies chest `({cx}, {cy}, {cz})` — use `mc chest_search` first.")
        lines.append("")

    prep_text, _ = site_prep_section(anchor, footprint)
    lines.extend(["## Site prep (foundation)", "", prep_text, ""])

    lines.extend(["## Build phases (local Y)", ""])
    for ly in layers:
        layer_cells = [c for c in cells if c["local"][1] == ly]
        by_block = Counter(c["block"] for c in layer_cells)
        lines.append(f"### Layer Y = {ly} ({len(layer_cells)} cells)")
        lines.append("")
        lines.append("**Materials this layer:** " + ", ".join(f"`{b}`×{n}" for b, n in by_block.most_common()))
        lines.append("")
        all_boxes: list[tuple] = []
        for block in sorted(by_block.keys()):
            if is_door_block(block):
                continue
            all_boxes.extend(cluster_fill_boxes(layer_cells, block, max_volume=fill_max_volume))
        covered = cells_covered_by_boxes(layer_cells, all_boxes)
        if all_boxes:
            lines.append("**Bulk placement** (`mc fill` max 500 cells per call):")
            lines.append("")
            for lx, lz, max_x, max_z, block in all_boxes:
                wx1, wy, wz1 = local_to_world(anchor, footprint, lx, ly, lz)
                wx2, _, wz2 = local_to_world(anchor, footprint, max_x, ly, max_z)
                vol = (max_x - lx + 1) * (max_z - lz + 1)
                lines.append(
                    f"- `mc fill {block} {wx1} {wy} {wz1} {wx2} {wy} {wz2}` "
                    f"<!-- local y={ly} vol={vol} -->"
                )
            lines.append("")
        remainder = [c for c in layer_cells if tuple(c["local"]) not in covered]
        if remainder:
            lines.append(f"**Single blocks** (first {place_cap_per_layer}; full list: `mc blueprint layer {plan_id} --y {ly}`):")
            lines.append("")
            for c in remainder[:place_cap_per_layer]:
                lx, _, lz = c["local"]
                wx, wy, wz = local_to_world(anchor, footprint, lx, ly, lz)
                lines.append(f"- `mc place {c['block']} {wx} {wy} {wz}`")
            if len(remainder) > place_cap_per_layer:
                lines.append(f"- … and {len(remainder) - place_cap_per_layer} more — use layer command above")
            lines.append("")
        lines.append(f"**Verify layer:** `mc blueprint verify {verify_target} --level {ly}`")
        lines.append("")

    lines.extend(
        [
            "## Final verify",
            "",
            f"`mc blueprint verify {verify_target}`",
            "",
            "Large footprints truncate at `BLUEPRINT_VERIFY_MAX_CELLS_PER_CALL` (default 2000); "
            "rerun with `--level` or `--range Y1..Y2` per layer above.",
            "",
            "## Notes",
            "",
            "- `mc construct` / blueprint `mc repair` are **not** implemented; use fill/place/dig + verify.",
            "- Fill boxes are greedy, not optimal; odd shapes need more `mc place`.",
            "- **Doors:** cells are `oak_door` (no GrabCraft half/facing ids). Place one door at the "
            "**lower** world Y of each doorway (`mc place oak_door …`); upper half is automatic. "
            "Pick facing toward the outside; verify compares base id only (v1).",
            "- Beds/ladders/stairs may need manual facing; verify uses block-id compare v1.",
            "- Regenerate this file after plan edits: `python3 scripts/blueprint-tool.py guide "
            f"{plan_id} --anchor {anchor[0]},{anchor[1]},{anchor[2]}`",
            "",
        ]
    )
    return "\n".join(lines)


def write_guide(
    plan: dict,
    plan_id: str,
    *,
    anchor_override: list[int] | None = None,
    out_path: str | None = None,
    worksite: str | None = None,
    region: str | None = None,
    supplies_chest: tuple[int, int, int] | None = None,
    buffer_pct: float = 0.0,
    place_cap_per_layer: int = 30,
) -> str:
    anchor = resolve_anchor(plan, anchor_override)
    md = render_markdown(
        plan,
        plan_id=plan_id,
        anchor=anchor,
        worksite=worksite,
        region=region,
        supplies_chest=supplies_chest,
        buffer_pct=buffer_pct,
        place_cap_per_layer=place_cap_per_layer,
    )
    if out_path:
        from pathlib import Path

        p = Path(out_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(md, encoding="utf-8")
    return md

"""Write lo-fi XZ spatial-map.html for proc-nav postmortems."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _anchors_from_map(card: dict) -> list[dict]:
    out: list[dict] = []
    placements = card.get("placements") or {}
    for name, raw in placements.items():
        if isinstance(raw, (list, tuple)) and len(raw) >= 3:
            out.append({
                "name": name,
                "x": int(raw[0]),
                "z": int(raw[2]),
                "y": int(raw[1]),
            })
    return out


def _path_from_telemetry(telemetry_path: Path) -> list[tuple[float, float]]:
    if not telemetry_path.is_file():
        return []
    pts: list[tuple[float, float]] = []
    for line in telemetry_path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("kind") != "position_snapshot":
            continue
        pos = ev.get("position") or {}
        if "x" in pos and "z" in pos:
            pts.append((float(pos["x"]), float(pos["z"])))
    return pts


def render_spatial_map_html(
    *,
    trial_dir: Path,
    map_card: dict | None = None,
    marks: list[dict] | None = None,
) -> Path:
    out = trial_dir / "spatial-map.html"
    anchors = _anchors_from_map(map_card or {})
    path_pts = _path_from_telemetry(trial_dir / "telemetry.jsonl")
    marks = marks or []
    payload = {
        "anchors": anchors,
        "marks": marks,
        "path": [{"x": x, "z": z} for x, z in path_pts],
    }
    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>proc-nav spatial map</title>
<style>
  body {{ font-family: system-ui, sans-serif; margin: 1rem; }}
  canvas {{ border: 1px solid #ccc; max-width: 100%; }}
</style></head><body>
<h1>proc-nav spatial map</h1>
<p>Schematic XZ — anchors (blue), path (green), marks (orange).</p>
<canvas id="c" width="640" height="640"></canvas>
<script>
const DATA = {json.dumps(payload)};
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const allX = [...DATA.anchors.map(a=>a.x), ...DATA.path.map(p=>p.x), ...DATA.marks.map(m=>m.x)];
const allZ = [...DATA.anchors.map(a=>a.z), ...DATA.path.map(p=>p.z), ...DATA.marks.map(m=>m.z)];
if (!allX.length) {{
  ctx.fillText('No spatial data', 20, 40);
}} else {{
  const minX = Math.min(...allX), maxX = Math.max(...allX);
  const minZ = Math.min(...allZ), maxZ = Math.max(...allZ);
  const pad = 24;
  const sx = (canvas.width - 2*pad) / Math.max(1, maxX - minX);
  const sz = (canvas.height - 2*pad) / Math.max(1, maxZ - minZ);
  function tx(x) {{ return pad + (x - minX) * sx; }}
  function tz(z) {{ return pad + (z - minZ) * sz; }}
  ctx.strokeStyle = '#2a2';
  ctx.beginPath();
  DATA.path.forEach((p,i) => {{
    const x = tx(p.x), y = tz(p.z);
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }});
  ctx.stroke();
  ctx.fillStyle = '#06c';
  DATA.anchors.forEach(a => {{
    ctx.beginPath();
    ctx.arc(tx(a.x), tz(a.z), 6, 0, Math.PI*2);
    ctx.fill();
    ctx.fillText(a.name, tx(a.x)+8, tz(a.z));
  }});
  ctx.fillStyle = '#c60';
  DATA.marks.forEach(m => {{
    ctx.beginPath();
    ctx.arc(tx(m.x), tz(m.z), 4, 0, Math.PI*2);
    ctx.fill();
  }});
}}
</script></body></html>
"""
    out.write_text(html, encoding="utf-8")
    return out

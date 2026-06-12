"""Command emission for the planner-agent loop (§6.1 sample, §6.4 confirm).

Pure: ledger/state/spec in, literal `mc` command strings out. NOTHING here
touches the world — the planner agent runs the emitted lines and pipes the
`--json` output back through `roadplan ingest`. That indirection is the
whole contract (§3 dataflow): the tool decides *what* to observe and *where*
to light, the agent's shell does it, the ledger records it.

Two decision problems live here:

  - `coarse_plan` / `refine_plan` → which unobserved cells still need a
    `corridor_sample`, packed into cap-sized rectangles. `pack_rects` owns
    the 512-cell `corridor_sample` cap (§10.11 — agents never see it) and a
    span limit that keeps each rectangle inside one `mc move`'s loaded-chunk
    radius (§7.2/§10.1 — sampling assumes the bot walked the box).
  - `confirm_blocks` → per-waypoint `move + waypoint + survey + promote`
    command blocks, emitting only waypoints not yet confirmed.

Emit-all-pending: every call recomputes need from durable state and emits
everything still missing. The agent loop is therefore `while lines: run;
re-ask` — no cursor, self-healing (a dropped command simply reappears).
"""
from __future__ import annotations

from .solver import line_cells

# corridor_sample caps at 512 cells/call (region.js). max_span keeps a
# rectangle small enough that one `mc move` to its centre loads the chunks
# it covers before the sample runs.
SAMPLE_CAP = 512
MAX_SPAN = 48


def _swath_cells(start, end, half):
    """Line start->end inflated to +/-half on each axis (square swath)."""
    seen, out = set(), []
    for bx, bz in line_cells(tuple(start), tuple(end)):
        for ox in range(-half, half + 1):
            for oz in range(-half, half + 1):
                c = (bx + ox, bz + oz)
                if c not in seen:
                    seen.add(c)
                    out.append(c)
    return out


def pack_rects(cells, cap=SAMPLE_CAP, max_span=MAX_SPAN):
    """Greedy bounding-box packing of (x,z) cells into rectangles, each
    <= cap cells and <= max_span on either side. Returns
    [{x1,z1,x2,z2,move:(mx,mz)}] with move = rect centre.

    Cells are grouped in input order (callers pass ring-major or
    corridor-major order so adjacent cells pack together). A rect grows to
    include the next cell unless that would breach cap or span; then it
    closes and a new rect starts.
    """
    rects = []
    cur = None
    for x, z in cells:
        if cur is None:
            cur = [x, x, z, z]
            continue
        nx1, nx2 = min(cur[0], x), max(cur[1], x)
        nz1, nz2 = min(cur[2], z), max(cur[3], z)
        span_x, span_z = nx2 - nx1 + 1, nz2 - nz1 + 1
        if span_x > max_span or span_z > max_span or span_x * span_z > cap:
            rects.append(_close(cur))
            cur = [x, x, z, z]
        else:
            cur = [nx1, nx2, nz1, nz2]
    if cur is not None:
        rects.append(_close(cur))
    return rects


def _close(box):
    x1, x2, z1, z2 = box
    return {
        "x1": x1, "z1": z1, "x2": x2, "z2": z2,
        "move": ((x1 + x2) // 2, (z1 + z2) // 2),
    }


def coarse_plan(known_xz, start, end, swath, cap=SAMPLE_CAP):
    """Rects covering the start->end swath cells not yet in the ledger.
    `known_xz` is the set of (x,z) already observed. Empty list = covered."""
    half = (int(swath) - 1) // 2
    pending = [c for c in _swath_cells(start, end, half) if c not in known_xz]
    return pack_rects(pending, cap=cap)


def refine_plan(requests, cap=SAMPLE_CAP):
    """Rects over refine()'s [{x,z,reason}] requests (ring-major order)."""
    return pack_rects([(r["x"], r["z"]) for r in requests], cap=cap)


def sample_commands(rects, ledger, y, approach_range=8):
    """Two lines per rect: approach its centre (loading chunks), then
    sample + ingest.

    The approach uses `goto_near` not `move`: the surface Y at the centre
    isn't known until we sample it, and `move` demands an exact standable
    cell. `goto_near X Y Z RANGE` tolerates a wrong Y (it just needs the
    bot close enough to load the chunks), so a single corridor `y` hint
    works for every rect. `y` is the agent's rough corridor elevation
    (the §10.1 "the bot walks the box" requirement made concrete)."""
    lines = []
    for r in rects:
        mx, mz = r["move"]
        lines.append(f"mc goto_near {mx} {int(y)} {mz} {approach_range}")
        lines.append(
            f"mc corridor_sample {r['x1']} {r['z1']} {r['x2']} {r['z2']} "
            f"full=true --json | roadplan --ledger {ledger} ingest")
    return lines


def _split_leg(p, q, max_len=96):
    """Split a survey leg p->q into <=max_len-cell sub-legs (survey_line
    caps at 96 cells). Returns [(a, b), ...] consecutive segments."""
    cells = line_cells(tuple(p), tuple(q))
    if len(cells) <= max_len:
        return [(tuple(p), tuple(q))]
    segs = []
    for i in range(0, len(cells) - 1, max_len - 1):
        a = cells[i]
        b = cells[min(i + max_len - 1, len(cells) - 1)]
        segs.append((a, b))
    return segs


def allocate_waypoints(state, start):
    """Ensure state['waypoints'] covers the latest route's waypoints,
    allocating wp_<n> names (single namer, §6.3) continuing from the max
    existing index. Mutates and returns state. Idempotent: re-running with
    the same route adds nothing."""
    routes = state.get("routes") or []
    if not routes:
        return state
    route_wps = routes[-1].get("waypoints") or []
    existing = state.setdefault("waypoints", [])
    by_pos = {(w["pos"][0], w["pos"][2]): w for w in existing}
    max_idx = 0
    for w in existing:
        try:
            max_idx = max(max_idx, int(str(w["name"]).split("_")[1]))
        except (IndexError, ValueError):
            pass
    for wp in route_wps:
        x, elev, z = wp
        key = (x, z)
        if key in by_pos:
            continue
        max_idx += 1
        entry = {
            "name": f"wp_{max_idx}",
            "pos": [x, elev, z],
            "status": "proposed",
            "torch_at": None,
            "prev_pos": None,
        }
        existing.append(entry)
        by_pos[key] = entry
    return state


def confirm_blocks(state, start, bot, ledger):
    """Per-waypoint command blocks for every waypoint not yet confirmed.
    Returns (blocks, n_confirmed, n_total). Each block:
        mc move x z
        mc waypoint wp_n x y z --json | roadplan ingest
        mc survey_line px pz x z --json | roadplan ingest   (per <=96 leg)
        roadplan promote wp_n --bot <bot>
    `prev` is the preceding waypoint, or the start endpoint for the first.
    """
    wps = state.get("waypoints") or []
    blocks = []
    n_confirmed = sum(1 for w in wps if w.get("status") == "confirmed")
    prev_xz = (start[0], start[1])
    for w in wps:
        x, y, z = w["pos"]
        if w.get("status") != "confirmed":
            # Stand NEAR the waypoint, not ON it: the torch goes in the
            # waypoint's feet cell, and a bot standing exactly there blocks
            # its own placement (TARGET_SELF_OCCUPIED). goto_near range 2
            # parks the bot adjacent (and tolerates an off-by-a-bit Y);
            # the waypoint verb places the torch remotely from there.
            lines = [f"mc goto_near {x} {y} {z} 2"]
            lines.append(
                f"mc waypoint {w['name']} {x} {y} {z} --json "
                f"| roadplan --ledger {ledger} ingest")
            for a, b in _split_leg(prev_xz, (x, z)):
                lines.append(
                    f"mc survey_line {a[0]} {a[1]} {b[0]} {b[1]} --json "
                    f"| roadplan --ledger {ledger} ingest")
            lines.append(f"roadplan promote {w['name']} --bot {bot}")
            blocks.append(lines)
        prev_xz = (x, z)
    return blocks, n_confirmed, len(wps)

"""RCON sampling adapter (adaptive-road-planning §6.2, Phase 1).

Probes a Minecraft world directly through `mapcatalog.rcon_client` and
appends the result to the ledger in the SAME shape `mc corridor_sample`
would produce — the solver never knows where samples came from. This is
the dev/test bypass that lets K2/K3 be driven against real terrain
without bots in the loop; the production wire (`mc … --json | roadplan
ingest`, §5.1) takes over in Phase 2.

Three-pass strategy:
  1. `_descend_to_walkable`, two-phase to keep the probe count sane
     (every probe is one `execute if block` RCON round-trip share):
       a. Coarse `#minecraft:air`-only scan on a y_step=4 grid from
          y_hint+headroom down (plus y_lo as terminal point) — one
          predicate per grid Y instead of fourteen per Y. Columns the
          grid misses entirely (a floor thinner than the step CAN sit
          between grid points) get a fine air-only rescan of the
          skipped Ys before being declared empty.
       b. Bracket: the three Ys above a coarse hit are probed to find
          the TOPMOST non-air block — the refinement start.
       c. Full-predicate refinement descent from that boundary: the
          first cell matching NO passable predicate is the surface
          block, feet = Y+1. The PASSABLE set mirrors K1's
          `columnTopSolid` semantics in bot/lib/shared/walk-classify.js
          (kept by hand in sync; the K1↔RCON cross-validation goldens
          are the regression guard). Water/lava/log tags encountered
          drive the K2 kind mapping (water → water, logs → tree,
          else → ground); surfaces more than `no_floor_min_depth`
          below the line reference become `gap`.
     Residual blind spot (accepted): a thin (<4) floating shell ABOVE
     deeper solid ground is skipped — the coarse scan hits the ground
     beneath and reports the under-floor. Road semantics want the
     ground anyway; the old exhaustive descent had the inverse problem
     (reporting the shell) and needed `_repair_spikes` to undo it.
  2. `_repair_spikes`: top-down descent reports the TOPMOST surface, so
     overhang roofs / terrain spikes capture the column (torch lands in
     mid-air over the real route). Columns whose feet exceed their
     8-neighbor median by `rcon_spike_threshold` resume the descent
     below the roof and take the surface nearest the neighbor median.
  3. Known limitation: `gap` is judged against the corridor-wide
     y_hint reference, so a long single ingest over steadily
     descending terrain misreads the far end as gap — ingest long
     routes in segments with per-segment y_hint (as the demos do).

The §6.1 foliage pairing — exclude_foliage=true ground read +
exclude_foliage=false canopy read — is still deferred to Phase 2's
`mc survey_line`; here we only need the *walkable* floor.
"""
from __future__ import annotations

import statistics

from .ledger import append_samples
from .spec import load_spec

MAX_CMDS_PER_BATCH = 100
_WATER_TAGS = ("minecraft:water", "minecraft:lava")
_LOG_TAG = "#minecraft:logs"

# Surface block names emitted into the ledger so K2's kind mapping
# (ledger.samples_for_solver) lands on the right kind without forking
# the vocabulary.
_TAG_FOR_KIND = {
    "ground": "minecraft:grass_block",
    "water":  "minecraft:water",
    "tree":   "minecraft:oak_log",
    "gap":    None,
}

# Mirrors the K1 column logic in bot/lib/shared/walk-classify.js
# (PASSABLE, FLUIDS, VEGETATION_RE) and bot/lib/runtime/dig-tools.js
# (DIG_PASSABLE_NAMES, DIG_FLUID_NAMES, isFoliageName). These predicates
# are what "skip while descending" means — the first cell that matches
# NONE of them is the walkable surface block.
# Note: snow_layer / flowing_water / flowing_lava are NOT valid Paper
# block IDs (they're either renamed or covered by their source block);
# include only IDs the server accepts, or `if block` emits a multi-line
# error that desynchronises the batch.
_PASSABLE_PREDICATES = (
    "#minecraft:air",
    "#minecraft:leaves",
    "#minecraft:logs",
    "#minecraft:saplings",
    "minecraft:short_grass",
    "minecraft:tall_grass",
    "minecraft:fern",
    "minecraft:large_fern",
    "minecraft:dead_bush",
    "minecraft:snow",
    "minecraft:torch",
    "minecraft:wall_torch",
    "minecraft:water",
    "minecraft:lava",
)


def _line_indicates_match(line):
    line = (line or "").strip()
    return "Test passed" in line or "matches" in line


def _columns_for(bounds):
    x1, z1, x2, z2 = bounds
    xs = range(min(x1, x2), max(x1, x2) + 1)
    zs = range(min(z1, z2), max(z1, z2) + 1)
    return [(x, z) for x in xs for z in zs]


def _run_predicates(client, world, probes):
    """Batch a list of (cell, y, pred) probes. Returns {(cell, y, pred): hit}.

    Robust against two RCON quirks:
      - SshDockerRcon's `run_batch` returns one line per command PLUS a
        trailing prompt (`'> '`).
      - An unknown block ID in `if block` emits a multi-line error
        (message + `<--[HERE]` indicator), shifting every subsequent
        probe by 1+ lines.

    Keep only lines that start with `> ` and either contain "Test
    passed/failed" or a Server-recognized result. Drop error/HERE lines
    and the trailing prompt before zipping.
    """
    cmds = [f"execute in {world} if block {cell[0]} {y} {cell[1]} {pred}"
            for cell, y, pred in probes]
    lines = []
    for i in range(0, len(cmds), MAX_CMDS_PER_BATCH):
        chunk = cmds[i:i + MAX_CMDS_PER_BATCH]
        out = client.run_batch(chunk)
        chunk_lines = []
        skip_next = False
        for raw in (out or "").splitlines():
            if skip_next:
                skip_next = False
                continue
            ln = raw.strip()
            if "Unknown block type" in ln or "Unknown item" in ln:
                # The server emits the error line and an indicator line
                # on the next line; skip both AND treat the command as
                # "no match" so the probe is still consumed.
                chunk_lines.append("> Test failed")
                skip_next = True
                continue
            if "<--[HERE]" in raw:
                continue  # stray indicator after we recovered above
            if "Test passed" in ln or "Test failed" in ln:
                chunk_lines.append(ln)
        # Pad / trim to exactly len(chunk) so probes never lose alignment
        # if a server message we don't recognize ate or duplicated a line.
        if len(chunk_lines) < len(chunk):
            chunk_lines.extend(["> Test failed"] * (len(chunk) - len(chunk_lines)))
        lines.extend(chunk_lines[:len(chunk)])
    if len(lines) != len(probes):
        raise RuntimeError(
            f"probe/response misalignment: {len(probes)} probes, {len(lines)} lines")
    hits = {}
    for probe, line in zip(probes, lines):
        hits[probe] = _line_indicates_match(line)
    return hits


_INTEREST_TAGS = {
    "minecraft:water": "water",
    "minecraft:flowing_water": "water",
    "minecraft:lava": "lava",
    "minecraft:flowing_lava": "lava",
    "#minecraft:logs": "logs",
}


def _air_probe(client, world, cell_ys):
    """Probe `#minecraft:air` at each (cell, y). Returns {(cell, y): is_air}."""
    probes = [(c, y, "#minecraft:air") for c, y in cell_ys]
    hits = _run_predicates(client, world, probes)
    return {(c, y): hit for (c, y, _pred), hit in hits.items()}


def _find_boundaries(client, world, cells, *, y_hi, y_lo, step=4):
    """Phases A+B: per-cell topmost non-air Y within [y_lo, y_hi], or
    None when the whole window is air.

    A. Descend a y_step=`step` grid (y_lo always included) probing only
       `#minecraft:air`, batched per grid Y over still-pending cells.
       Columns with no grid hit get a fine rescan of the skipped Ys —
       a floor thinner than `step` can sit between grid points.
    B. A coarse hit is *inside or at* the surface, but the true topmost
       non-air block may be up to step-1 above it (the grid point above
       was air). One bracket batch resolves it. Fine-scan hits are
       already exact.
    """
    grid = list(range(y_hi, y_lo - 1, -step))
    if grid[-1] != y_lo:
        grid.append(y_lo)
    pending = set(cells)
    coarse = {}
    for y in grid:
        if not pending:
            break
        res = _air_probe(client, world, [(c, y) for c in pending])
        for (c, cy), is_air in res.items():
            if not is_air:
                coarse[c] = cy
        pending -= set(coarse)
    boundary = {}
    if pending:
        grid_set = set(grid)
        for y in range(y_hi, y_lo - 1, -1):
            if y in grid_set or not pending:
                continue
            res = _air_probe(client, world, [(c, y) for c in pending])
            for (c, cy), is_air in res.items():
                if not is_air:
                    boundary[c] = cy
            pending -= set(boundary)
        for c in pending:
            boundary[c] = None
    probes = []
    for c, h in coarse.items():
        for y in range(h + 1, min(h + step, y_hi + 1)):
            probes.append((c, y, "#minecraft:air"))
    res = _run_predicates(client, world, probes) if probes else {}
    for c, h in coarse.items():
        b = h
        for y in range(h + 1, min(h + step, y_hi + 1)):
            if res.get((c, y, "#minecraft:air")) is False:
                b = y
        boundary[c] = b
    return boundary


def _descend_to_walkable(client, world, cells, *, y_hi=120, y_lo=32):
    """Two-phase per-cell descent to the topmost walkable surface.

    `_find_boundaries` locates each column's topmost non-air block with
    cheap air-only probes; the full passable-predicate descent (Phase C)
    then runs only from that boundary down — the first Y where NO
    predicate matches is the surface block, feet = Y + 1. Cells with no
    non-air block in the window, or that stay passable all the way to
    y_lo, report `None` (no walkable surface).

    Why not reuse `find_surface_heights`: its y_step=16 coarse pass only
    refines around the first coarse hit, so a walkable surface above a
    deep first-hit (e.g. grass at 72 over a cave hit at 56) is skipped
    entirely — the "torches deep underground" symptom. The step=4 grid
    plus fine-rescan fallback here keeps the exhaustive descent's
    answers (regression-tested) at ~1/15th the probe count.

    Each refinement round is one batch of `|pending| * |predicates|`
    probes, each cell at its own current Y; pending shrinks per round.
    """
    cells = [tuple(c) for c in cells]
    encountered = {c: set() for c in cells}
    feet = {}
    boundary = _find_boundaries(client, world, cells, y_hi=y_hi, y_lo=y_lo)
    cur = {}
    for c in cells:
        b = boundary.get(c)
        if b is None:
            feet[c] = None
        else:
            cur[c] = b
    while cur:
        probes = [(c, y, pred)
                  for c, y in cur.items() for pred in _PASSABLE_PREDICATES]
        res = _run_predicates(client, world, probes)
        cell_matches = {c: set() for c in cur}
        for (c, _y, pred), hit in res.items():
            if hit:
                cell_matches[c].add(pred)
        nxt = {}
        for c, y in cur.items():
            matched = cell_matches[c]
            for pred, tag in _INTEREST_TAGS.items():
                if pred in matched:
                    encountered[c].add(tag)
            if not matched:
                feet[c] = y + 1
            elif y - 1 >= y_lo:
                nxt[c] = y - 1
            else:
                feet[c] = None
        cur = nxt
    return feet, encountered


def _repair_spikes(client, world, feet, encountered, *, y_lo, threshold):
    """Overhang/spike correction (top-down descent's blind spot).

    The descent reports the TOPMOST surface per column. When a column
    carries a roof — a floating shelf, a terrain spike, a tree-house
    floor — that roof is what gets reported, and a torch placed there
    hangs in mid-air relative to the route below. Detectable purely from
    neighbor continuity: a column whose feet exceed the median of its
    8-neighbors by more than `threshold` is a suspect; resume its descent
    BELOW the roof and accept the first surface within `threshold` of the
    neighbor median. Genuine one-column bumps are kept: solid all the way
    down yields no second surface, so the original feet stand.
    """
    def median_neighbors(c):
        vals = [feet.get((c[0] + dx, c[1] + dz))
                for dx in (-1, 0, 1) for dz in (-1, 0, 1)
                if (dx, dz) != (0, 0)]
        vals = [v for v in vals if v is not None]
        return statistics.median(vals) if vals else None

    suspects = []
    for c, f in feet.items():
        if f is None:
            continue
        med = median_neighbors(c)
        if med is not None and f - med > threshold:
            suspects.append((c, f, med))

    for c, f, med in suspects:
        # Resume below the roof's surface block (block_y = f - 1): walk
        # down through the solid, then through any cavity, recording each
        # passable->solid transition as a candidate surface.
        y = int(f) - 2
        in_ground = True
        best = None
        while y >= y_lo:
            hits = _run_predicates(
                client, world, [(c, y, p) for p in _PASSABLE_PREDICATES])
            matched = {p for (_c, _y, p), hit in hits.items() if hit}
            for pred, tag in _INTEREST_TAGS.items():
                if pred in matched:
                    encountered[c].add(tag)
            if in_ground:
                if matched:
                    in_ground = False
            elif not matched:
                cand = y + 1
                if best is None or abs(cand - med) < abs(best - med):
                    best = cand
                if abs(cand - med) <= threshold:
                    break
                in_ground = True
            y -= 1
        if best is not None and abs(best - med) < abs(f - med):
            feet[c] = best
    return feet


def _classify_floor(client, world, surface_cells):
    """For each surface cell, probe (water, lava, logs) at floor_y =
    feet_y - 1. Returns {(x, z): set of {"water", "lava", "logs"}}."""
    cmds, targets = [], []
    for (x, z), feet_y in surface_cells:
        floor_y = feet_y - 1
        cmds.append(f"execute in {world} if block {x} {floor_y} {z} {_WATER_TAGS[0]}")
        targets.append((x, z, "water"))
        cmds.append(f"execute in {world} if block {x} {floor_y} {z} {_WATER_TAGS[1]}")
        targets.append((x, z, "lava"))
        cmds.append(f"execute in {world} if block {x} {floor_y} {z} {_LOG_TAG}")
        targets.append((x, z, "logs"))
    flags = {}
    for i in range(0, len(cmds), MAX_CMDS_PER_BATCH):
        chunk = cmds[i:i + MAX_CMDS_PER_BATCH]
        chunk_targets = targets[i:i + MAX_CMDS_PER_BATCH]
        out = client.run_batch(chunk)
        lines = (out or "").splitlines()
        for j, (x, z, what) in enumerate(chunk_targets):
            line = lines[j] if j < len(lines) else ""
            if _line_indicates_match(line):
                flags.setdefault((x, z), set()).add(what)
    return flags


def sample_corridor(client, world, bounds, y_hint, spec=None):
    """Probe a rectangle through RCON and return K2 samples.

    Returns: [{"x", "z", "y", "kind"}, ...] in column-major order.
    """
    spec = spec or load_spec()
    columns = _columns_for(bounds)
    # y_hi is bounded around y_hint + headroom rather than going to 200 —
    # for a road planner we don't care about mountains 50 blocks above
    # the line; the per-Y batch grows linearly with the scan window.
    headroom = spec.get("rcon_scan_headroom", 32)
    y_hi = int(y_hint) + headroom
    y_lo = spec.get("rcon_y_lo", 32)
    heights, encountered = _descend_to_walkable(
        client, world, columns, y_hi=y_hi, y_lo=y_lo)
    heights = _repair_spikes(
        client, world, heights, encountered, y_lo=y_lo,
        threshold=spec.get("rcon_spike_threshold", 5))
    ref = float(y_hint) + 1
    out = []
    for x, z in columns:
        feet_y = heights.get((x, z))
        if feet_y is None:
            out.append({"x": x, "z": z, "y": None, "kind": "gap"})
            continue
        y = float(feet_y)
        if ref - y >= spec["no_floor_min_depth"]:
            kind = "gap"
        else:
            tags = encountered.get((x, z), set())
            if "water" in tags or "lava" in tags:
                kind = "water"
            elif "logs" in tags:
                kind = "tree"
            else:
                kind = "ground"
        out.append({"x": x, "z": z, "y": y, "kind": kind})
    return out


def ingest_via_rcon(client, world, bounds, y_hint, ledger_root, spec=None):
    """Sample a corridor via RCON and append it to the ledger.

    Returns (cells_written, samples) so callers can render / solve right
    after ingest without re-reading the file.
    """
    samples = sample_corridor(client, world, bounds, y_hint, spec=spec)
    cells = []
    for s in samples:
        cells.append([s["x"], s["z"], s["y"], _TAG_FOR_KIND[s["kind"]]])
    append_samples(ledger_root, "rcon", "rcon-adapter", cells)
    return len(cells), samples

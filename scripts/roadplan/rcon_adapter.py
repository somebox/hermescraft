"""RCON sampling adapter (adaptive-road-planning §6.2, Phase 1).

Probes a Minecraft world directly through `mapcatalog.rcon_client` and
appends the result to the ledger in the SAME shape `mc corridor_sample`
would produce — the solver never knows where samples came from. This is
the dev/test bypass that lets K2/K3 be driven against real terrain
without bots in the loop; the production wire (`mc … --json | roadplan
ingest`, §5.1) takes over in Phase 2.

Three-pass strategy:
  1. `find_surface_heights` with y_step=1 finds first-NON-AIR Y per
     column. Bait: this catches leaves/logs/snow_layer/grass-tufts too,
     so the result is the canopy top, not the walkable floor. The
     y_step=1 is the parity-safe fix — the upstream default y_step=2
     can skip surfaces on odd Y values, leaving torches one block
     below the visible surface.
  2. `_walkable_descent` mirrors K1's `columnTopSolid` semantics:
     descend through the foliage/passable cells until the first true
     solid (dirt, stone, grass_block, …) — feet_y = that block's y+1.
     The PASSABLE set is the same list K1 uses in
     bot/lib/shared/walk-classify.js (kept by hand in sync; the K1↔RCON
     cross-validation goldens are the regression guard).
  3. `_classify_floor` tests each true-floor cell for water/lava/log so
     the K2 kind mapping (water → water, logs → tree, else → ground)
     fires correctly. Cells with the surface more than `no_floor_min_depth`
     below the line reference become `gap`.

The §6.1 foliage pairing — exclude_foliage=true ground read +
exclude_foliage=false canopy read — is still deferred to Phase 2's
`mc survey_line`; here we only need the *walkable* floor.
"""
from __future__ import annotations

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


def _descend_to_walkable(client, world, cells, *, y_hi=120, y_lo=32):
    """Single-pass per-cell descent to the topmost walkable surface.

    Scans every Y from y_hi down to y_lo at y_step=1, testing the
    passable-predicate set at each Y for every still-pending cell. The
    first Y where NO predicate matches is the surface block — feet sits
    at Y + 1. Cells that never hit a non-passable block within the range
    report `None` (no walkable surface).

    Why not reuse `find_surface_heights`: the upstream coarse-then-fine
    algorithm uses y_step=16 for the coarse pass and only refines around
    the first coarse hit. For columns where the *first* non-air block
    descending is deep underground (e.g. y=56 stone under an air gap),
    the actual walkable surface (e.g. y=72 grass) sits above the coarse
    grid and gets skipped entirely — the symptom is "torches deep
    underground." y_step=1 from the start is the only fix.

    Per Y is a single batch of `|pending| * |predicates|` `if block`
    probes. Pending shrinks each Y as cells find their floor.
    """
    pending = {tuple(c): y_hi for c in cells}
    feet = {}
    encountered = {tuple(c): set() for c in cells}
    y = y_hi
    while pending and y >= y_lo:
        probes = []
        for c in pending:
            for pred in _PASSABLE_PREDICATES:
                probes.append((c, y, pred))
        hits = _run_predicates(client, world, probes)
        cell_matches = {c: set() for c in pending}
        for (c, _y, pred), hit in hits.items():
            if hit:
                cell_matches[c].add(pred)
        next_pending = {}
        for c in pending:
            matched = cell_matches[c]
            for pred, tag in _INTEREST_TAGS.items():
                if pred in matched:
                    encountered[c].add(tag)
            if matched:
                next_pending[c] = y - 1
            else:
                feet[c] = y + 1
        pending = next_pending
        y -= 1
    for c in pending:
        feet[c] = None  # never found a non-passable block in the range
    return feet, encountered


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

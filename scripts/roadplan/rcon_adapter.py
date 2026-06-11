"""RCON sampling adapter (adaptive-road-planning §6.2, Phase 1).

Probes a Minecraft world directly through `mapcatalog.rcon_client` and
appends the result to the ledger in the SAME shape `mc corridor_sample`
would produce — the solver never knows where samples came from. This is
the dev/test bypass that lets K2/K3 be driven against real terrain
without bots in the loop; the production wire (`mc … --json | roadplan
ingest`, §5.1) takes over in Phase 2.

Two-pass strategy:
  1. `find_surface_heights` finds first-solid Y per column (coarse-then-
     fine, batched — already mapcatalog's job).
  2. A second batch of `execute if block` predicates per surface cell
     classifies water / lava / log against the floor — enough to drive
     the K2 kind mapping (water → water, logs → tree, anything else →
     ground). No-surface columns become `gap`; cells whose surface sits
     more than `no_floor_min_depth` below the line elevation also
     register as `gap`, which mirrors what the field-side surface-pick
     does (samples_from_fixture in fixtures.py).

The §6.1 foliage pairing — `exclude_foliage=true` ground read +
`exclude_foliage=false` canopy read — is deferred: the Phase 1 spike
exists to retire K2 risk on heightmap data; canopy depth lands when
Phase 2's `mc survey_line` lights up the real signal.
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


def _line_indicates_match(line):
    line = (line or "").strip()
    return "Test passed" in line or "matches" in line


def _columns_for(bounds):
    x1, z1, x2, z2 = bounds
    xs = range(min(x1, x2), max(x1, x2) + 1)
    zs = range(min(z1, z2), max(z1, z2) + 1)
    return [(x, z) for x in xs for z in zs]


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
    # find_surface_heights is the mapcatalog batched probe.
    from mapcatalog.metrics import find_surface_heights  # local import — avoids hard dep
    heights = find_surface_heights(client, world, columns)
    surface_cells = [(c, y) for c, y in heights.items() if y is not None]
    flags = _classify_floor(client, world, surface_cells) if surface_cells else {}
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
            f = flags.get((x, z), set())
            if "water" in f or "lava" in f:
                kind = "water"
            elif "logs" in f:
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

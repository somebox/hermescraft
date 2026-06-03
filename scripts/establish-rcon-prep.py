#!/usr/bin/env python3
"""RCON world prep for establishment explore runs (peaceful hub + starter chest).

Run-7 Step 4 (PR-H): before issuing the spawn-area /fill, this script
probes the live world's natural surface Y at the spawn (x,z) and uses
the probed value when it differs from the catalog spawn Y by >2. Without
this, the run-7 launch fired /fill at the stale catalog Y=96 on a fresh
seed=1001 disc where the natural surface was ~Y66, building a 25×25
floating slab over the forest canopy.

Probe strategy: `mapcatalog.metrics.find_surface_heights` via the
existing SshDockerRcon client (ssh ubuntu-host → docker exec minecraft
→ rcon-cli). Fails closed: if the probe returns None, prep refuses to
issue any /fill rather than building a slab at a stale Y.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parents[1]

# Run-7 PR-H — when |catalog spawn Y - probed surface Y| ≤ this, the
# catalog value is trusted as-is (no log spam). Above this, the probe
# wins and the substitution is logged loudly.
SURFACE_PROBE_DELTA_TOLERANCE = 2

# Default rcon config when server.local.yaml is unreadable.
_DEFAULT_SSH_HOST = "ubuntu-host"
_DEFAULT_CONTAINER = "minecraft"


def _agent_test():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "agent_test_mod", ROOT / "scripts" / "agent-test.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod


def _read_rcon_config(server_yaml: Path) -> tuple[str, str]:
    """Pull (ssh_host, container) from server.local.yaml; fall back to
    the agent-test.py hardcoded values when unavailable."""
    if not server_yaml.is_file():
        return _DEFAULT_SSH_HOST, _DEFAULT_CONTAINER
    try:
        import yaml  # type: ignore
    except ImportError:
        # Coarse extraction — find lines like `ssh_host: …` / `container: …`.
        text = server_yaml.read_text(encoding="utf-8")
        ssh = _DEFAULT_SSH_HOST
        con = _DEFAULT_CONTAINER
        for line in text.splitlines():
            s = line.strip()
            if s.startswith("ssh_host:"):
                ssh = s.split(":", 1)[1].strip().strip("\"'")
            elif s.startswith("container:"):
                con = s.split(":", 1)[1].strip().strip("\"'")
        return ssh, con
    try:
        cfg = yaml.safe_load(server_yaml.read_text(encoding="utf-8")) or {}
    except Exception:
        return _DEFAULT_SSH_HOST, _DEFAULT_CONTAINER
    rcon = (cfg.get("rcon") or {})
    return (
        rcon.get("ssh_host", _DEFAULT_SSH_HOST),
        rcon.get("container", _DEFAULT_CONTAINER),
    )


def probe_surface_y(*, world: str, sx: int, sz: int,
                    ssh_host: str, container: str,
                    y_hi: int = 200, y_lo: int = 48) -> Optional[int]:
    """Run a top-down air-vs-solid scan at (sx, sz) via SshDockerRcon
    and return the feet Y (one above the first solid block), or None
    if the scan exhausted without finding anything.

    Imports mapcatalog at call time — keeps the script importable in
    environments where mapcatalog isn't on sys.path (test fixtures).
    """
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from mapcatalog.rcon_client import SshDockerRcon
    from mapcatalog.metrics import find_surface_heights

    client = SshDockerRcon(ssh_host=ssh_host, container=container)
    heights = find_surface_heights(
        client, world, [(sx, sz)], y_lo=y_lo, y_hi=y_hi,
    )
    return heights.get((sx, sz))


def resolve_spawn_y(catalog_sy: int, probed_sy: Optional[int],
                    *, tolerance: int = SURFACE_PROBE_DELTA_TOLERANCE,
                    strict: bool = True) -> int:
    """Decide which Y to use for the spawn-area fill.

    Pure function — testable without rcon.

    - probed_sy is None: strict path raises SystemExit (fail closed);
      non-strict path falls back to catalog (used by --dry-run only).
    - |catalog - probed| ≤ tolerance: use catalog (no behaviour change).
    - |catalog - probed| > tolerance: use probed (loud substitution).
    """
    if probed_sy is None:
        if strict:
            raise SystemExit(
                "rcon surface probe failed — refusing to /fill at the catalog Y "
                "(would risk a floating-slab platform like run-7). Re-run with "
                "--skip-surface-probe to bypass at your own risk."
            )
        return catalog_sy
    delta = abs(catalog_sy - probed_sy)
    if delta <= tolerance:
        return catalog_sy
    return probed_sy


def _triple(card: dict, key: str) -> tuple[int, int, int]:
    placements = card.get("placements") or {}
    raw = card.get(key) or placements.get(key)
    if not raw or len(raw) < 3:
        raise SystemExit(f"map JSON missing {key!r}")
    return int(raw[0]), int(raw[1]), int(raw[2])


def apply_spawn_y_override(card: dict, resolved_sy: int) -> None:
    """Mutate `card` so spawn / muster / starter_chest reflect resolved Y.

    Run-8 evidence: the surface probe correctly shifted spawn 96 → 79, but
    `establish-seed-cards.py` read the catalog Y from the map JSON, so the
    EPIC body said `Spawn: 4,96,24` and NE/NW EXPLORE cards referenced
    `muster (4,96,24)`. Workers fell ~17 blocks on first TP (Flint took 13
    damage at 14:17). Steward had to manually fix three cards mid-flight.

    Mirrors `prep_commands`'s chest-shift policy: chest_y moves by the same
    delta as spawn_y so the catalog's chest_y = spawn_y − 1 relationship
    survives. Writes both top-level and `placements.*` mirrors because
    downstream readers (`_triple`, the bash `placements.spawn` echo) check
    both shapes.
    """
    placements = card.setdefault("placements", {})
    sx, catalog_sy, sz = _triple(card, "spawn")
    delta = resolved_sy - catalog_sy
    new_spawn = [sx, resolved_sy, sz]
    placements["spawn"] = list(new_spawn)
    card["spawn"] = list(new_spawn)
    # Re-collapse muster onto spawn (establish-scenario.sh already does this
    # at catalog Y; we re-apply at resolved Y so any subsequent reader that
    # trusts a non-collapsed muster still gets a coherent value).
    placements["muster"] = list(new_spawn)
    card["muster"] = list(new_spawn)
    cx, catalog_cy, cz = _triple(card, "starter_chest")
    new_chest = [cx, catalog_cy + delta, cz]
    placements["starter_chest"] = list(new_chest)
    card["starter_chest"] = list(new_chest)


def prep_commands(card: dict, *, world: str = "proc-lab",
                   spawn_y_override: Optional[int] = None) -> list[str]:
    """Build the rcon command batch. `spawn_y_override` (when provided)
    replaces the catalog spawn Y for fill, setworldspawn AND chest
    placement — the chest's relationship to spawn (chest_y = spawn_y - 1
    by catalog construction) is preserved by shifting chest_y by the
    same delta as spawn_y. Run-8 evidence: the first cut preserved
    catalog chest_y=95 while resolved spawn_y dropped to 79, leaving the
    chest floating 16 blocks above the new grass floor."""
    sx, catalog_sy, sz = _triple(card, "spawn")
    cx, catalog_cy, cz = _triple(card, "starter_chest")
    if spawn_y_override is not None:
        sy = spawn_y_override
        # Apply the same delta to chest so the spawn↔chest vertical
        # relationship from the catalog (typically -1: chest is the block
        # below the bot's feet) carries over. Without this, the chest
        # floats at the catalog Y while bots stand 17+ blocks lower.
        cy = catalog_cy + (sy - catalog_sy)
    else:
        sy = catalog_sy
        cy = catalog_cy
    items_nbt = (
        "{Items:["
        '{Slot:0b,id:"minecraft:iron_pickaxe",Count:1b},'
        '{Slot:1b,id:"minecraft:iron_axe",Count:1b},'
        '{Slot:2b,id:"minecraft:iron_shovel",Count:1b},'
        '{Slot:3b,id:"minecraft:bread",Count:4b}'
        "]}"
    )
    return [
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doMobSpawning false",
        f"execute in {world} run gamerule doDaylightCycle false",
        f"execute in {world} run time set day",
        f"execute in {world} run kill @e[type=!player]",
        # Spawn-area cleanup (Phase 9 PR-H): clears residual pits in a
        # 25×25 surface around spawn and re-floors with grass. Run-5 evidence:
        # Mason hit run-4's residual pit at (4,84,29) — each replay degrades
        # the next world unless we reset the spawn neighborhood. The chest
        # setblock below runs AFTER this fill, so the chest overrides the
        # grass cell at (cx,cy,cz). Does NOT repair scars deeper than 1 block
        # below spawn Y; that's deferred (see plan PR-H known limitations).
        f"execute in {world} run fill {sx-12} {sy} {sz-12} {sx+12} {sy+3} {sz+12} air replace",
        f"execute in {world} run fill {sx-12} {sy-1} {sz-12} {sx+12} {sy-1} {sz+12} grass_block",
        f"execute in {world} run setblock {cx} {cy} {cz} minecraft:chest",
        f"execute in {world} run data merge block {cx} {cy} {cz} {items_nbt}",
        f"execute in {world} run setworldspawn {sx} {sy} {sz}",
    ]


def tp_worker_commands(card: dict, workers: list[str], *, world: str = "proc-lab") -> list[str]:
    """Move each worker into the proc-lab disc and seed starter inventory.

    Order matters: clear → tp → give. Each worker lands at muster with the
    same starter kit (iron pickaxe/axe/shovel + 16 bread + 8 logs + crafting
    table) so their landfolk role priors (maintain_food, maintain_wood) drop
    immediately and they execute the card body instead of role-shopping.

    Fan offsets stay in the SW quadrant from spawn (away from the upslope
    that buried previous fans). Player names capitalized for MC lookup.
    """
    mx, my, mz = _triple(card, "muster")
    # SW-quadrant fan: spawn, S, W, SW — relief at the spawn neighborhood
    # rises N+/E+, drops S-/W-, so stay in the downhill half.
    offsets = [(0, 0), (0, 1), (-1, 0), (-1, 1), (0, 2), (-2, 0)]
    starter_kit = [
        ("minecraft:iron_pickaxe", 1),
        ("minecraft:iron_axe", 1),
        ("minecraft:iron_shovel", 1),
        ("minecraft:bread", 16),
        ("minecraft:oak_log", 8),
        ("minecraft:crafting_table", 1),
    ]
    out: list[str] = []
    # One-shot clear so the give below produces a deterministic inventory.
    out.append(f"execute in {world} run clear @a")
    for i, raw in enumerate(workers):
        name = raw.strip().capitalize()
        if not name:
            continue
        dx, dz = offsets[i % len(offsets)]
        out.append(f"mvtp {name} {world}")
        out.append(f"execute in {world} run tp {name} {mx + dx} {my} {mz + dz}")
        for item, count in starter_kit:
            out.append(f"execute in {world} run give {name} {item} {count}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--map", type=Path, required=True)
    ap.add_argument("--world", default="proc-lab")
    ap.add_argument("--mode", choices=["world", "tp_workers"], default="world",
                    help="world: peaceful + chest + worldspawn. tp_workers: mvtp + tp to muster.")
    ap.add_argument("--workers", default="",
                    help="comma list of player names (required when --mode tp_workers)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-surface-probe", action="store_true",
                    help="Run-7 PR-H escape hatch — skip the rcon surface probe "
                         "and use the catalog spawn Y verbatim. Risks a floating "
                         "slab on a fresh disc; only use when the probe is broken.")
    ap.add_argument("--server-yaml", type=Path, default=ROOT / "server.local.yaml",
                    help="Path to server.local.yaml for rcon ssh_host/container.")
    args = ap.parse_args()

    card = json.loads(args.map.read_text(encoding="utf-8"))
    if args.mode == "world":
        # Run-7 PR-H: probe the live surface BEFORE issuing any /fill.
        # Doing it after the fill would read the just-laid grass slab
        # (validated by armor-stand probe during run-7 pause).
        spawn_y_override: Optional[int] = None
        if not args.skip_surface_probe and not args.dry_run:
            sx, sy, sz = _triple(card, "spawn")
            ssh_host, container = _read_rcon_config(args.server_yaml)
            print(f"  probing surface Y at ({sx},{sz}) on {args.world}…",
                  end=" ", flush=True)
            probed = probe_surface_y(
                world=args.world, sx=sx, sz=sz,
                ssh_host=ssh_host, container=container,
            )
            print(f"got {probed} (catalog says {sy})")
            resolved = resolve_spawn_y(sy, probed, strict=True)
            if resolved != sy:
                print(f"  ⚠ spawn Y substituted: catalog {sy} → probed {resolved} "
                      f"(delta {abs(resolved - sy)} > {SURFACE_PROBE_DELTA_TOLERANCE})")
                spawn_y_override = resolved
                # Patch the map JSON so downstream readers (seed-cards,
                # tp_workers, the bash placements.spawn echo) see the same
                # resolved coords. Without this, kanban cards still encode
                # the stale catalog Y and workers fall on first TP.
                apply_spawn_y_override(card, resolved)
                args.map.write_text(json.dumps(card, indent=2) + "\n",
                                    encoding="utf-8")
                print(f"  patched {args.map.name}: spawn={card['placements']['spawn']} "
                      f"muster={card['placements']['muster']} "
                      f"chest={card['placements']['starter_chest']}")
        cmds = prep_commands(card, world=args.world, spawn_y_override=spawn_y_override)
        label = "rcon prep"
    else:
        names = [w.strip() for w in args.workers.split(",") if w.strip()]
        if not names:
            raise SystemExit("--mode tp_workers requires --workers comma-list")
        cmds = tp_worker_commands(card, names, world=args.world)
        label = f"rcon tp_workers ({','.join(names)})"
    if args.dry_run:
        for c in cmds:
            print(c)
        return 0
    _agent_test().run_rcon_batch(cmds)
    print(f"{label} ok ({len(cmds)} commands)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

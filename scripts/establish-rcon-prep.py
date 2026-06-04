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

# Phase-14 fix (2026-06-03): the probe at find_surface_heights stops at
# the first non-air block — water counts as non-air, so an oceanic seed
# returns feet Y at the water surface, bots TP into the sea and drown.
# After resolve we explicitly verify the standing-on cell + feet cell
# aren't water/lava, and refuse to /fill if they are. Seed 1001 phase-14
# evidence: all four workers tp'd to (4,64,24), Flint trapped underwater
# at (-3,63,20) taking drowning damage before the operator intervened.
_UNSAFE_SURFACE_BLOCKS = (
    "minecraft:water",
    "minecraft:lava",
)

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


def check_surface_safe(client, *, world: str,
                        sx: int, sy: int, sz: int) -> Optional[str]:
    """Verify (sx, sy, sz) is a safe land spawn cell after surface probe.

    Pure-ish: takes an rcon client (real or mock) and runs `execute if
    block` predicates. Returns None on safe, else a string describing
    the offending block + cell. The check covers two cells:

      - (sx, sy-1, sz) — the standing-on block. Water here drowns the
        bot on TP (feet at sy submerged); lava burns it.
      - (sx, sy,   sz) — the feet cell. Water here means the resolved
        Y was the water surface, not a true land surface.

    Both are inspected against `_UNSAFE_SURFACE_BLOCKS`. Each predicate
    that matches returns "Test passed" from Paper's command bridge.
    """
    for cy in (sy - 1, sy):
        for block_id in _UNSAFE_SURFACE_BLOCKS:
            result = client.run(
                f"execute in {world} if block {sx} {cy} {sz} {block_id}"
            )
            if "Test passed" in result:
                kind = "standing-on" if cy == sy - 1 else "feet-cell"
                short_id = block_id.split(":", 1)[-1]
                return f"{short_id} at {kind} cell ({sx},{cy},{sz})"
    return None


def scan_neighborhood_safety(client, *, world: str,
                              sx: int, sy: int, sz: int,
                              radius: int = 2,
                              heights_fn=None) -> dict:
    """Probe a (2*radius+1)² grid around (sx, sz) and classify each column.

    Phase-15 (2026-06-03) evidence: probe at (4,24) returned Y=201 (a
    single tall stone column) but the SURROUNDING terrain was open
    ocean. The 1-cell `check_surface_safe` passed; bots fell 138 blocks
    to the seafloor and ended up Z+50 looking for land. The 1-cell
    check needs a neighborhood scan to refuse "spawn on a stone pillar
    surrounded by sea" cases.

    For each column (sx+dx, sz+dz) in the patch:
      - probe surface Y via mapcatalog.find_surface_heights
      - inspect the surface block (probed_y - 1) for water/lava
      - classify as: land | water | lava | air (probe returned None)

    Returns a dict with counts + land_pct + a per-column classification
    map (only present cells, keyed by (x, z)). A column whose probed Y
    differs from the centre by more than 12 is also flagged as
    `cliff` to surface "spawn at a peak surrounded by drops" cases.
    """
    if heights_fn is None:
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        from mapcatalog.metrics import find_surface_heights as heights_fn

    columns = [
        (sx + dx, sz + dz)
        for dx in range(-radius, radius + 1)
        for dz in range(-radius, radius + 1)
    ]
    # Match probe_surface_y's window (y_hi=200, y_lo=48) so the scan
    # sees ground, not tree canopies. find_surface_heights' default
    # y_hi=319 catches leaves as the "surface" and classifies every
    # column as a cliff edge against the ground-level sy from the
    # original probe. Stubs in tests accept **kwargs and ignore these.
    heights = heights_fn(client, world, columns, y_hi=200, y_lo=48)

    classification: dict[tuple[int, int], str] = {}
    counts = {"land": 0, "water": 0, "lava": 0, "air": 0, "cliff": 0}
    for (x, z), feet_y in heights.items():
        if feet_y is None:
            classification[(x, z)] = "air"
            counts["air"] += 1
            continue
        # Cliff classification: any column whose feet_y is more than
        # 12 blocks above or below the centre is unstable to spawn
        # near — workers fall when they step off the pillar.
        if abs(feet_y - sy) > 12:
            classification[(x, z)] = "cliff"
            counts["cliff"] += 1
            continue
        # Surface block sits at feet_y - 1 (the cell the bot stands on).
        block_y = feet_y - 1
        is_water = "Test passed" in client.run(
            f"execute in {world} if block {x} {block_y} {z} minecraft:water"
        )
        if is_water:
            classification[(x, z)] = "water"
            counts["water"] += 1
            continue
        is_lava = "Test passed" in client.run(
            f"execute in {world} if block {x} {block_y} {z} minecraft:lava"
        )
        if is_lava:
            classification[(x, z)] = "lava"
            counts["lava"] += 1
            continue
        classification[(x, z)] = "land"
        counts["land"] += 1

    total = sum(counts.values())
    land_pct = (counts["land"] / total * 100.0) if total else 0.0
    return {
        "columns": total,
        "radius": radius,
        "land": counts["land"],
        "water": counts["water"],
        "lava": counts["lava"],
        "air": counts["air"],
        "cliff": counts["cliff"],
        "land_pct": land_pct,
        "heights": heights,
        "classification": classification,
    }


def assert_neighborhood_land(client, *, world: str,
                              sx: int, sy: int, sz: int,
                              radius: int = 2,
                              min_land_pct: float = 80.0,
                              heights_fn=None) -> Optional[str]:
    """High-level gate using ``scan_neighborhood_safety``.

    Returns None if the neighborhood has at least ``min_land_pct``
    land columns, else a one-line string suitable for SystemExit.
    """
    scan = scan_neighborhood_safety(
        client, world=world, sx=sx, sy=sy, sz=sz, radius=radius,
        heights_fn=heights_fn,
    )
    if scan["land_pct"] < min_land_pct:
        return (
            f"neighborhood scan failed: only {scan['land']}/{scan['columns']} "
            f"columns are land ({scan['land_pct']:.0f}%; need ≥{min_land_pct:.0f}%) "
            f"in a {2*radius+1}x{2*radius+1} patch around ({sx},{sz}). "
            f"Distribution: land={scan['land']} water={scan['water']} "
            f"lava={scan['lava']} air={scan['air']} cliff={scan['cliff']}."
        )
    return None


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
                   spawn_y_override: Optional[int] = None,
                   mission: str = "explore") -> list[str]:
    """Build the rcon command batch. `spawn_y_override` (when provided)
    replaces the catalog spawn Y for fill, setworldspawn AND chest
    placement — the chest's vertical offset from spawn (whatever it is
    in the input card) is preserved by shifting chest_y by the same
    delta as spawn_y.

    Convention note: establish-scenario.sh's auto-patch now stores
    chest_y = spawn_y (chest sits ON the grass with its top sticking up
    1 block), replacing the prior `sy-1` convention that left the chest
    flush with the surface. The delta-shifter doesn't care about either
    convention — it preserves whatever offset is in the input.

    Run-8 evidence: the first cut preserved catalog chest_y=95 while
    resolved spawn_y dropped to 79, leaving the chest floating 16 blocks
    above the new grass floor."""
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
    # MC 1.20.5+ NBT format change: item count is `count:N` (lowercase int)
    # not `Count:Nb` (uppercase byte). With the old syntax the parser
    # silently drops the field and defaults to count=1, which is why
    # Phase D's first run found 1 sign + 1 torch in the chest instead of
    # 16 + 64.
    if mission == "mapping":
        # Mapping mission: bulk signs + torches in the shared chest so the
        # fleet can equip without returning to base after the first round.
        # Coal blocks let workers craft replacement torches mid-run.
        items_nbt = (
            "{Items:["
            '{Slot:0b,id:"minecraft:iron_pickaxe",count:1},'
            '{Slot:1b,id:"minecraft:iron_axe",count:1},'
            '{Slot:2b,id:"minecraft:iron_shovel",count:1},'
            '{Slot:3b,id:"minecraft:bread",count:16},'
            '{Slot:4b,id:"minecraft:oak_sign",count:16},'
            '{Slot:5b,id:"minecraft:torch",count:64},'
            '{Slot:6b,id:"minecraft:coal",count:32}'
            "]}"
        )
    else:
        items_nbt = (
            "{Items:["
            '{Slot:0b,id:"minecraft:iron_pickaxe",count:1},'
            '{Slot:1b,id:"minecraft:iron_axe",count:1},'
            '{Slot:2b,id:"minecraft:iron_shovel",count:1},'
            '{Slot:3b,id:"minecraft:bread",count:4}'
            "]}"
        )
    # Lighting: explore stays full-day (peaceful + day, dayCycle off).
    # Mapping wants dusk — `time set 13000` is right at sunset, and we let
    # the cycle run so workers see the dim shift. Mob spawning is still
    # off, so dusk just provides the visual + lighting context without
    # hostiles.
    if mission == "mapping":
        lighting_cmds = [
            f"execute in {world} run gamerule doDaylightCycle true",
            f"execute in {world} run time set 13000",
        ]
    else:
        lighting_cmds = [
            f"execute in {world} run gamerule doDaylightCycle false",
            f"execute in {world} run time set day",
        ]
    return [
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doMobSpawning false",
        *lighting_cmds,
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


def tp_worker_commands(card: dict, workers: list[str], *, world: str = "proc-lab",
                        mission: str = "explore") -> list[str]:
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
    if mission == "mapping":
        # Workers carry 4 signs + 16 torches at spawn so the first round of
        # naming can start immediately. The shared chest holds the bulk
        # restock (16 signs + 64 torches) when they return.
        starter_kit = [
            ("minecraft:iron_pickaxe", 1),
            ("minecraft:iron_axe", 1),
            ("minecraft:iron_shovel", 1),
            ("minecraft:bread", 16),
            ("minecraft:oak_log", 8),
            ("minecraft:crafting_table", 1),
            ("minecraft:oak_sign", 4),
            ("minecraft:torch", 16),
        ]
    else:
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
    ap.add_argument("--mission", choices=["explore", "mapping"], default="explore",
                    help="explore (default): full-day, basic chest, basic starter kit. "
                         "mapping: dusk, chest with signs+torches+coal, starter kit with "
                         "signs+torches for the mapping scenario.")
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
            # Phase-14: verify resolved spawn isn't water/lava BEFORE the
            # /fill. Without this, oceanic seeds (1001 islands) pass the
            # probe — feet Y is the water surface — and bots drown on TP.
            # Phase-15: extended to a 5x5 neighborhood scan because a
            # single stone column passed the 1-cell check at Y=201 while
            # the surrounding terrain was open ocean — bots fell 138 blocks.
            from mapcatalog.rcon_client import SshDockerRcon
            safety_client = SshDockerRcon(ssh_host=ssh_host, container=container)
            unsafe = check_surface_safe(
                safety_client, world=args.world,
                sx=sx, sy=resolved, sz=sz,
            )
            if unsafe is not None:
                raise SystemExit(
                    f"  ✗ refusing to /fill at unsafe spawn cell: {unsafe}\n"
                    f"    Seed {card.get('seed', '?')} dropped spawn on water/lava.\n"
                    f"    Re-run with `--fresh-disc <different-seed>` (or pick from\n"
                    f"    `seed_candidates` in requirements/scenario_establish_explore.yaml)."
                )
            neighborhood_fail = assert_neighborhood_land(
                safety_client, world=args.world,
                sx=sx, sy=resolved, sz=sz,
                radius=2, min_land_pct=80.0,
            )
            if neighborhood_fail is not None:
                raise SystemExit(
                    f"  ✗ refusing to /fill at hostile neighborhood: {neighborhood_fail}\n"
                    f"    Seed {card.get('seed', '?')} dropped spawn on an island / cliff / sea.\n"
                    f"    Re-run with a different seed via `scripts/seed-scout.py` to pick one."
                )
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
        cmds = prep_commands(card, world=args.world,
                             spawn_y_override=spawn_y_override,
                             mission=args.mission)
        label = f"rcon prep (mission={args.mission})"
    else:
        names = [w.strip() for w in args.workers.split(",") if w.strip()]
        if not names:
            raise SystemExit("--mode tp_workers requires --workers comma-list")
        cmds = tp_worker_commands(card, names, world=args.world, mission=args.mission)
        label = f"rcon tp_workers ({','.join(names)}, mission={args.mission})"
    if args.dry_run:
        for c in cmds:
            print(c)
        return 0
    _agent_test().run_rcon_batch(cmds)
    print(f"{label} ok ({len(cmds)} commands)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

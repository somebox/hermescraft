#!/usr/bin/env python3
"""Genesis v2 boot library — procworld stack, specialist colony architecture.

Modernizes the legacy genesis flow (scripts/genesis_lib.py) onto the procworld
Multiverse stack and the narrow-specialist + read-only-Steward model. World
reset goes through reset-proc-lab.py (Multiverse), rcon through the mapcatalog
client (the same ubuntu-host docker server, addressed per-world via
`execute in <world> run ...`). Phase epics chain on a dedicated `genesis-v2`
kanban board; gates live in data/genesis-v2/templates/phase-checklists.yaml.

Pure template/markup helpers are reused from genesis_lib; everything that
touches the world or bodies is procworld-native here.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
# Also put the repo root on the path so the LOCAL `mapcatalog` package (rcon
# client, used by _rcon) imports when this module is loaded from a script file
# (e.g. the poller: `python scripts/genesis-v2-poller.py`, whose sys.path[0] is
# scripts/, not the repo root). The boot only got it via the cwd-on-path of a
# `python - <<EOF` stdin invocation.
sys.path.insert(0, str(REPO_ROOT))
import genesis_lib as gl  # noqa: E402  (pure helpers only: parse_yaml_simple, substitute, _iso_utc, _load_json)

TEMPLATES_DIR = REPO_ROOT / "data" / "genesis-v2" / "templates"
RUNS_ROOT = REPO_ROOT / "data" / "genesis-v2-runs"
DATA_DIR = REPO_ROOT / "data"
BOARD = "genesis-v2"
SERVER_CFG = REPO_ROOT / "server.local.yaml"

# Generic body pool (NOT a specialist→body map). Expertise profiles
# (colony-scout/gatherer/builder) are lease-mode and check out ANY of these
# bodies per card via `mc bot checkout` — the lease is the body-mutex, so
# same-expertise cards run concurrently across the pool. Steward is bodiless.
BODY_POOL = {
    "mox": {"user": "Mox", "port": 3007},
    "pip": {"user": "Pip", "port": 3005},
    "zee": {"user": "Zee", "port": 3006},
}


# --------------------------------------------------------------------------- #
# run bookkeeping
# --------------------------------------------------------------------------- #
def runs_root() -> Path:
    RUNS_ROOT.mkdir(parents=True, exist_ok=True)
    return RUNS_ROOT


def run_dir(run_id: str) -> Path:
    d = runs_root() / run_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def next_run_id() -> str:
    today = gl._iso_utc()[:10]
    prefix = f"gv2-{today}-"
    n = 1
    for p in runs_root().iterdir():
        if p.is_dir() and p.name.startswith(prefix):
            try:
                n = max(n, int(p.name.split("-")[-1]) + 1)
            except ValueError:
                pass
    return f"{prefix}{n}"


def save_config(cfg: dict) -> None:
    (run_dir(cfg["run_id"]) / "config.json").write_text(json.dumps(cfg, indent=2) + "\n")


def load_config(run_id: str) -> dict:
    return json.loads((run_dir(run_id) / "config.json").read_text())


def write_active(run_id: str) -> None:
    (runs_root() / ".active").write_text(run_id + "\n")


def active_run_id() -> str | None:
    p = runs_root() / ".active"
    return p.read_text().strip() if p.exists() else None


# --------------------------------------------------------------------------- #
# rcon (mapcatalog client; per-world via `execute in <world> run`)
# --------------------------------------------------------------------------- #
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _rcon(cmds: list[str]) -> str:
    """Run a batch of raw rcon commands; returns the concatenated response as a
    single ANSI-stripped string. (mapcatalog's run_batch returns one string;
    DON'T iterate/join it char-by-char.)"""
    from mapcatalog.rcon_client import make_rcon
    from mapcatalog.server_config import load_server_config

    client = make_rcon(load_server_config(SERVER_CFG))
    out = client.run_batch(cmds)
    if not isinstance(out, str):
        out = "\n".join(str(x) for x in out)
    return _ANSI.sub("", out)


def rcon_in(world: str, cmds: list[str]) -> str:
    return _rcon([f"execute in {world} run {c}" for c in cmds])


# --------------------------------------------------------------------------- #
# world reset + plains spawn probe
# --------------------------------------------------------------------------- #
def _world_exists(world: str) -> bool:
    out = _rcon(["mv list"])
    return bool(re.search(rf"(?m)^{re.escape(world)}\s*-", out)) or f"{world} - " in out


def reset_world(*, world: str, seed: int, hub: str = "landfolk-test") -> None:
    """Fresh Multiverse disc. If the world doesn't exist yet (first boot), just
    create it — there's nothing to delete, so the reset-proc-lab delete+OTP path
    would stall. If it exists, route through reset-proc-lab.py for the full
    evacuate→delete→confirm→create cycle."""
    bots = ",".join(b["user"] for b in BODY_POOL.values())
    if not _world_exists(world):
        # Evacuate any body that happens to be there, then create fresh.
        for b in BODY_POOL.values():
            _rcon([f"mvtp {b['user']} {hub}"])
        out = _rcon([f"mv create {world} NORMAL -s {seed}"])
        if "created" in out.lower() or "already exists" in out.lower():
            # Give MV a moment to register the world in `mv list` before callers
            # start addressing it with `execute in <world>`.
            for _ in range(10):
                time.sleep(2)
                if _world_exists(world):
                    return
            return  # creation confirmed by message even if list lags
        raise RuntimeError(f"mv create {world} failed: {out[:300]}")
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "reset-proc-lab.py"),
         "--world", world, "--seed", str(seed), "--hub", hub, "--bots", bots],
        cwd=REPO_ROOT, capture_output=True, text=True, timeout=300,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"reset-proc-lab failed: {proc.stderr[-800:]}")


def _bot_position(port: int, *, timeout: float = 4.0) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=timeout) as r:
            d = json.loads(r.read())
        return d.get("position") if d.get("connected") else None
    except Exception:
        return None


def _bot_connected(port: int) -> bool:
    return _bot_position(port) is not None


def _dotenv_papermcp() -> dict[str, str]:
    """PAPERMCP_* vars from the repo-local .env, so launched bodies get the
    server-side craft fallback (paperMcpConfig) even when the launcher didn't
    source .env — e.g. a manual restart_bodies. genesis-v2.sh sources .env too;
    this is belt-and-suspenders for the table-craft window-race fix (#3399)."""
    out: dict[str, str] = {}
    envf = REPO_ROOT / ".env"
    if not envf.exists():
        return out
    try:
        for ln in envf.read_text().splitlines():
            ln = ln.strip()
            if ln.startswith("PAPERMCP_") and "=" in ln and not ln.startswith("#"):
                k, v = ln.split("=", 1)
                out[k.strip()] = v.strip()
    except Exception:
        pass
    return out


def restart_bodies(*, mc_host: str | None = None, mc_port: int | None = None, timeout_s: int = 120) -> None:
    """Kill + relaunch the pool's bot processes, then wait until all reconnect.
    Called AFTER reset_world: the world delete/recreate wedges mineflayer
    ("session replacement in flight"), so a clean restart is more reliable than
    waiting on auto-reconnect (which failed the probe last run)."""
    import shutil
    host = mc_host or os.environ.get("MC_HOST", "192.168.1.202")
    port_mc = mc_port or int(os.environ.get("MC_PORT", "25565"))
    for b in BODY_POOL.values():
        api = b["port"]
        # Kill whatever holds the API port (the wedged bot).
        try:
            out = subprocess.run(["lsof", "-ti", f":{api}"], capture_output=True, text=True, timeout=10).stdout
            for pid in out.split():
                try:
                    os.kill(int(pid), 9)
                except (ProcessLookupError, ValueError):
                    pass
        except Exception:
            pass
    time.sleep(3)
    node = shutil.which("node") or "node"
    for b in BODY_POOL.values():
        api, user = b["port"], b["user"]
        env = {**os.environ, **_dotenv_papermcp(),
               "API_PORT": str(api), "VIEWER_PORT": str(api + 1000),
               "BOT_MOVEMENT_PROFILE": "slow", "MC_HOST": host, "MC_PORT": str(port_mc),
               "MC_USERNAME": user,
               # Colony workers escalate via kanban_block, not `mc advise` — degrade
               # the bot's stuck/blocked advise hints (gv2-2026-06-16-1: 62 dead
               # attempts). Must match the genesis-v2.sh ensure_body launch; this is
               # the path that runs on reset_world/operator-pinned-spawn restarts.
               "MC_SUPPRESS_ADVISE_HINTS": "1"}
        log = open(f"/tmp/{user.lower()}-bot.log", "a")
        subprocess.Popen([node, "bot/server.js"], cwd=str(REPO_ROOT), env=env,
                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    # Wait for all bodies connected.
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if all(_bot_connected(b["port"]) for b in BODY_POOL.values()):
            return
        time.sleep(3)
    down = [b["user"] for b in BODY_POOL.values() if not _bot_connected(b["port"])]
    raise RuntimeError(f"bodies did not reconnect after restart: {down}")


# Natural-ground materials (block + tag predicates for `execute if block`). The
# `#` tags cover families: #dirt = grass_block/dirt/podzol/coarse_dirt/mud/
# mycelium/rooted_dirt; #sand = sand/red_sand; #base_stone_overworld =
# stone/granite/diorite/andesite/tuff/deepslate. Anything NOT in this set
# (leaves, logs, plants, snow_layer, water, structures) is skipped when finding
# ground — so a tree canopy or a cave floor is never mistaken for the surface.
GROUND_BLOCKS = (
    "#minecraft:dirt",
    "#minecraft:sand",
    "minecraft:gravel",
    "#minecraft:base_stone_overworld",
)


def _ground_y(world: str, px: int, pz: int, *, top: int, bottom: int) -> int | None:
    """Top-down scan for NATURAL GROUND at (px,pz): the first GROUND-material block,
    skipping air, water, and foliage (leaves/logs/plants/snow layer). Scanning from
    above the surface downward, the first ground hit is the surface top — never a
    tree branch (skipped) nor a cave floor (below the surface). Returns ground-top Y
    or None if no ground in [bottom, top]."""
    for yy in range(top, bottom, -1):
        if "Test passed" in rcon_in(
                world, [f"execute positioned {px} {yy} {pz} if block ~ ~ ~ minecraft:air"]):
            continue  # air column above the surface
        if any("Test passed" in rcon_in(
                world, [f"execute positioned {px} {yy} {pz} if block ~ ~ ~ {b}"])
               for b in GROUND_BLOCKS):
            return yy
        # else: non-air, non-ground (leaves/log/plant/snow_layer/water/structure)
        # — keep scanning down to the real ground.
    return None


def probe_natural_spawn(
    world: str,
    *,
    probe_user: str = "Mox",
    probe_port: int = 3007,
    require_surface_water: bool = True,
) -> dict[str, int]:
    """The colony spawn IS wherever the bodies naturally land in `world` — no
    long-distance relocation (which is unreliable across unloaded chunks). Drop
    the probe body onto the world, read its settled position, and require it to
    be LAND (not ocean/water). Raise if it's water so the caller can re-roll the
    seed."""
    # Resetting the world drops the bodies; wait for the probe body to
    # reconnect (bot/server.js auto-reconnects) before reading its position.
    for _ in range(30):
        if _bot_position(probe_port) is not None:
            break
        time.sleep(2)
    else:
        raise RuntimeError(f"probe body {probe_user} (:{probe_port}) did not reconnect after reset")
    _rcon([f"mvtp {probe_user} {world}"])
    # Settle: read position until Y stabilizes.
    last = None
    for _ in range(20):
        time.sleep(1.0)
        pos = _bot_position(probe_port)
        if pos and last and abs(pos["y"] - last["y"]) < 0.2:
            last = pos
            break
        last = pos
    if not last:
        raise RuntimeError("probe body never reported a settled position")
    x, z = int(round(last["x"])), int(round(last["z"]))
    settled_y = int(round(last["y"]))
    rcon_in(world, [f"forceload add {x >> 4} {z >> 4}"])
    # Anchor on NATURAL GROUND, not the bot's settled Y: leaves are solid, so the
    # bot can land on a tree canopy; a ledge/overhang is also possible. Scan top-
    # down (from just above the settle point) for the first ground material,
    # skipping foliage — this is the real walkable surface. `execute if`'s
    # "Test passed"/"Test failed" is the readable result (`run say` does NOT
    # round-trip through rcon).
    ground_y = _ground_y(world, x, z, top=settled_y + 8, bottom=settled_y - 30)
    if ground_y is None:
        raise RuntimeError(
            f"no natural ground under spawn ({x},{z}) in {world} (deep water / void); "
            f"re-roll the seed (--seed)")
    y = ground_y + 1  # standable cell on top of the ground
    # Ocean / lake-bed reject: water directly above the found ground = submerged.
    submerged = "Test passed" in rcon_in(
        world, [f"execute positioned {x} {ground_y + 1} {z} if block ~ ~ ~ minecraft:water"])
    if submerged:
        raise RuntimeError(
            f"natural spawn ({x},{ground_y},{z}) is submerged (ocean/lake bed) in "
            f"{world}; re-roll the seed (--seed) for a dry land spawn")
    # Biome quality: a colony needs trees + LIQUID water + farmable land. Frozen
    # biomes (packed_ice/snow) freeze water — no buckets, no crop hydration — and
    # deserts/badlands have no wood. The land check alone passes packed_ice, so
    # require a temperate biome via server-authoritative `execute if biome`
    # (independent of the bot's registry, which reports "unknown" on ice).
    GOOD_BIOMES = [
        "plains", "sunflower_plains", "meadow",
        "forest", "flower_forest", "birch_forest", "old_growth_birch_forest", "dark_forest",
        "taiga", "old_growth_pine_taiga", "old_growth_spruce_taiga",
        "savanna", "savanna_plateau", "windswept_savanna",
        "jungle", "sparse_jungle", "bamboo_jungle",
        "swamp", "mangrove_swamp",
    ]
    biome_ok = any(
        "Test passed" in rcon_in(
            world,
            [f"execute positioned {x} {y} {z} if biome ~ ~ ~ minecraft:{bn}"])
        for bn in GOOD_BIOMES
    )
    if not biome_ok:
        raise RuntimeError(
            f"natural spawn ({x},{y},{z}) is not a temperate colony biome in {world} "
            f"(frozen/desert/badlands — no liquid water or wood); re-roll the seed (--seed)")
    # Flatness: a colony needs buildable land, not a mountainside. Sample the
    # surface height in a small ring around the spawn and reject if it varies too
    # much (mountainous / cliff). NB: forceload the sampled chunks first — an
    # UNLOADED chunk reads as air via `execute if block`, which would falsely
    # report flat ground at sea level.
    rcon_in(world, [f"forceload add {(x - 8) >> 4} {(z - 8) >> 4} {(x + 8) >> 4} {(z + 8) >> 4}"])
    time.sleep(0.5)

    # Flatness measured on GROUND height (foliage-skipped), so a flat forest isn't
    # falsely rejected for tree-canopy variation and a steep hill is still caught.
    samples = [(x + dx, z + dz) for dx, dz in
               ((0, 0), (6, 0), (-6, 0), (0, 6), (0, -6), (6, 6), (-6, -6))]
    ys = [g for g in
          (_ground_y(world, px, pz, top=ground_y + 10, bottom=ground_y - 25) for px, pz in samples)
          if g is not None]
    if len(ys) >= 4:
        spread = max(ys) - min(ys)
        if spread > 5:
            raise RuntimeError(
                f"natural spawn ({x},{ground_y},{z}) terrain too steep (ground-Y spread "
                f"{spread} over ~12 blocks) — mountainous, not buildable; re-roll the seed")
    if require_surface_water and not surface_water_within(world, x, y, z):
        raise RuntimeError(
            f"natural spawn ({x},{y},{z}) has no surface water within "
            f"{SURFACE_WATER_RADIUS} blocks — re-roll the seed (--seed) or use --spawn for dev")
    return {"x": x, "y": y, "z": z}


def find_good_spawn(world: str, seed: int, *, max_tries: int = 12) -> tuple[int, dict[str, int]]:
    """Reset the world and probe its natural spawn, AUTO-REROLLING the seed until
    the spawn is a temperate land biome (not ocean/frozen/desert). Resetting wedges
    mineflayer, so each attempt also restarts the bodies before probing. Returns
    (seed_used, spawn). Raises if no good spawn is found within max_tries."""
    last_err: Exception | None = None
    for i in range(max_tries):
        s = seed + i * 7919  # spread seeds so adjacent attempts land far apart
        reset_world(world=world, seed=s)
        restart_bodies()  # reset drops the bodies; clean restart beats auto-reconnect
        try:
            spawn = probe_natural_spawn(world)
            if i:
                sys.stderr.write(f"[find_good_spawn] accepted seed {s} after {i} reroll(s): {spawn}\n")
            return s, spawn
        except RuntimeError as e:
            last_err = e
            sys.stderr.write(f"[find_good_spawn] seed {s} rejected: {e}\n")
    raise RuntimeError(f"no temperate land spawn after {max_tries} seeds from {seed}: {last_err}")


def wipe_marks() -> None:
    """Clear the shared map + the genesis-v2 BODIES' private stores so the colony
    starts on a clean map. Scoped to mox/pip/zee + the shared files ONLY — must
    NOT glob every locations-*.json / personal-pois-*.json, which would delete
    production bot state (flint/mason/gatherer) that has nothing to do with this
    world."""
    targets = [
        DATA_DIR / "locations-base.json",
        DATA_DIR / "personal-pois-shared.json",
    ]
    for b in BODY_POOL.values():
        u = b["user"].lower()
        targets.append(DATA_DIR / f"locations-{u}.json")
        targets.append(DATA_DIR / f"personal-pois-{u}.json")
    for p in targets:
        try:
            p.unlink()
        except FileNotFoundError:
            pass


# Surface water within N blocks — load-bearing for P2 farm before P3 mine.
SURFACE_WATER_RADIUS = 48

COLONY_WORKER_ASSIGNEES = frozenset({
    "colony-scout", "colony-gatherer", "colony-builder",
    "colony-farmer", "colony-miner", "colony-road",
})
AWAITING_FREE_BODY = "awaiting_free_body — pool empty (poller)"


def surface_water_within(
    world: str,
    x: int,
    y: int,
    z: int,
    radius: int = SURFACE_WATER_RADIUS,
    *,
    rcon_fn=rcon_in,
) -> bool:
    """True if any water block exists within a horizontal disc (coarse grid scan)."""
    step = max(4, radius // 12)
    for dx in range(-radius, radius + 1, step):
        for dz in range(-radius, radius + 1, step):
            if dx * dx + dz * dz > radius * radius:
                continue
            px, pz = x + dx, z + dz
            for dy in (-3, -1, 0, 1):
                py = y + dy
                cmd = f"execute positioned {px} {py} {pz} if block ~ ~ ~ minecraft:water"
                if "Test passed" in rcon_fn(world, [cmd]):
                    return True
    return False


def _archive_data_file(name: str, run_id: str) -> None:
    p = DATA_DIR / name
    if not p.exists():
        return
    dest = run_dir(run_id) / "archived" / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(p.read_bytes())


def render_regions_world(*, spawn: dict[str, int], ctx: dict[str, str]) -> None:
    """Reset data/regions-world.json from genesis-v2 template (singular buildable shelter)."""
    run_id = ctx.get("run_id", "unknown")
    sub = {
        **ctx,
        "spawn_x": str(spawn["x"]),
        "spawn_y": str(spawn["y"]),
        "spawn_z": str(spawn["z"]),
        "spawn_y_max": str(spawn["y"] + 12),
    }
    src = (TEMPLATES_DIR / "regions-world.template.json").read_text()
    out = gl.substitute(src, sub)
    _archive_data_file("regions-world.json", run_id)
    (DATA_DIR / "regions-world.json").write_text(out)
    (run_dir(run_id) / "rendered").mkdir(parents=True, exist_ok=True)
    (run_dir(run_id) / "rendered" / "regions-world.json").write_text(out)


def wipe_world_mines(world: str) -> None:
    safe = re.sub(r"[^\w.-]", "_", world)
    p = DATA_DIR / f"mines-{safe}.json"
    try:
        p.unlink()
    except FileNotFoundError:
        pass
    # Clean-start the SHARED registry too: the pool bodies write genesis mines into
    # mines-world.json (regionsWorld resolves to "world"), so prior-run genesis
    # mines persist there and would count toward this run's P3 gate. Strip just the
    # pool-authored mines; leave production mines (Flint/Tester etc.) intact.
    if safe != "world":
        sp = DATA_DIR / "mines-world.json"
        try:
            doc = gl._load_json(sp, default=None)
        except Exception:
            doc = None
        if isinstance(doc, dict) and isinstance(doc.get("mines"), list):
            kept = [m for m in doc["mines"] if not _is_genesis_mine(m)]
            if len(kept) != len(doc["mines"]):
                doc["mines"] = kept
                sp.write_text(json.dumps(doc, indent=2) + "\n")


def shelter_setblock_commands(world: str, ax: int, ay: int, az: int) -> list[str]:
    """7×7 shelter with E/W-traversable east-facing door; returns `execute in world run ...` cmds."""
    floor_y = ay - 1
    wall_h = 3
    roof_y = ay + wall_h
    margin = 2  # safe-apron radius beyond the 7×7 shell (→ 11×11 dry pad)
    cmds: list[str] = []
    # Water safety FIRST (gv2-2026-06-16-1: bots drowned on a base sited over
    # water). Deterministic backstop independent of agent leveling: force a solid
    # 2-layer cobble foundation under the whole pad+apron (plugs under-base water
    # and any void the door-exit walks onto), then drain standing water at
    # foot/head height above it. Bounded fills (11×11), so no runaway volume.
    cmds.append(
        f"fill {ax - 3 - margin} {floor_y - 1} {az - 3 - margin} "
        f"{ax + 3 + margin} {floor_y} {az + 3 + margin} minecraft:cobblestone"
    )
    cmds.append(
        f"fill {ax - 3 - margin} {ay} {az - 3 - margin} "
        f"{ax + 3 + margin} {ay + 2} {az + 3 + margin} minecraft:air replace minecraft:water"
    )
    # Clear interior + door approach so trees/slope don't seal the shell.
    cmds.append(
        f"fill {ax - 2} {ay} {az - 2} {ax + 2} {ay + wall_h - 1} {az + 2} air replace"
    )
    cmds.append(f"setblock {ax + 4} {ay} {az} air")
    cmds.append(f"setblock {ax + 4} {ay + 1} {az} air")
    for dx in range(-3, 4):
        for dz in range(-3, 4):
            x, z = ax + dx, az + dz
            cmds.append(f"setblock {x} {floor_y} {z} minecraft:cobblestone")
    for h in range(wall_h):
        wy = ay + h
        for dx in range(-3, 4):
            for dz in range(-3, 4):
                on_edge = abs(dx) == 3 or abs(dz) == 3
                if not on_edge:
                    continue
                x, z = ax + dx, az + dz
                # East-wall door (facing east) at center of +X wall
                if dx == 3 and dz == 0 and h < 2:
                    half = "lower" if h == 0 else "upper"
                    cmds.append(
                        f"setblock {x} {wy} {z} minecraft:oak_door[half={half},facing=east,open=false]"
                    )
                    continue
                if dx == 3 and dz == 0:
                    continue
                cmds.append(f"setblock {x} {wy} {z} minecraft:oak_planks")
    for dx in range(-3, 4):
        for dz in range(-3, 4):
            cmds.append(f"setblock {ax + dx} {roof_y} {az + dz} minecraft:oak_planks")
    # Chest pads just inside entry (west of door)
    cmds.append(f"setblock {ax - 1} {ay} {az} minecraft:chest[facing=east]")
    cmds.append(f"setblock {ax - 1} {ay} {az + 1} minecraft:chest[facing=east]")
    return [f"execute in {world} run {c}" for c in cmds]


def render_shelter_structure(world: str, anchor: dict[str, int]) -> None:
    ax, ay, az = anchor["x"], anchor["y"], anchor["z"]
    rcon_in(world, [f"forceload add {ax >> 4} {az >> 4}"])
    batch = shelter_setblock_commands(world, ax, ay, az)
    for i in range(0, len(batch), 40):
        _rcon(batch[i : i + 40])


def reposition_shelter_region(anchor: dict[str, int], run_id: str) -> None:
    path = DATA_DIR / "regions-world.json"
    data = gl._load_json(path, default={"regions": []})
    regions = data.get("regions") or []
    for reg in regions:
        if reg.get("id") == "shelter":
            reg["anchor"] = {"x": anchor["x"], "y": anchor["y"], "z": anchor["z"]}
            reg["status"] = "active"
            reg["updated"] = gl._iso_utc()
    data["regions"] = regions
    path.write_text(json.dumps(data, indent=2) + "\n")


def _base_anchor_coords() -> dict[str, int] | None:
    loc = gl._load_json(DATA_DIR / "locations-base.json", default={})
    if not isinstance(loc, dict):
        return None
    m = loc.get("base_anchor")
    if not m or not isinstance(m, dict):
        return None
    return {"x": int(m["x"]), "y": int(m["y"]), "z": int(m["z"])}


def maybe_render_shelter_for_run(run_id: str) -> bool:
    """Option A: rcon-render shelter once base_anchor exists (idempotent per run)."""
    cfg = load_config(run_id)
    if cfg.get("shelter_rendered"):
        return False
    anchor = _base_anchor_coords()
    if not anchor:
        return False
    world = cfg.get("world") or "genesis2"
    render_shelter_structure(world, anchor)
    reposition_shelter_region(anchor, run_id)
    cfg["shelter_rendered"] = True
    cfg["shelter_anchor"] = anchor
    save_config(cfg)
    return True


def _is_pool_gated_worker(t: dict, epic_ids: set[str]) -> bool:
    tid = str(t.get("id"))
    if tid in epic_ids:
        return False
    title = t.get("title") or ""
    if title.startswith("[EPIC]") or "SUPERVISE" in title or "NEEDS-OPERATOR" in title:
        return False
    assignee = (t.get("assignee") or "").strip().lower()
    return assignee in COLONY_WORKER_ASSIGNEES


def sync_body_pool_gates(run_id: str) -> dict[str, list[str]]:
    """Block ready colony workers when pool empty; release when bodies free."""
    cfg = load_config(run_id)
    epic_ids = {str(e) for e in cfg.get("epic_ids", [])}
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        tasks = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        return {"blocked": [], "released": []}
    free = _free_body_count()
    blocked: list[str] = []
    released: list[str] = []
    if free <= 0:
        for t in tasks:
            tid = str(t.get("id"))
            if (t.get("status") or "").lower() != "ready":
                continue
            if not _is_pool_gated_worker(t, epic_ids):
                continue
            r = _hermes(["block", tid, AWAITING_FREE_BODY], timeout=15)
            if r.returncode == 0:
                blocked.append(tid)
    else:
        slots = free
        for t in tasks:
            if slots <= 0:
                break
            tid = str(t.get("id"))
            if (t.get("status") or "").lower() != "blocked":
                continue
            if not _is_pool_gated_worker(t, epic_ids):
                continue
            reason = _latest_block_reason(tid)
            if AWAITING_FREE_BODY not in reason:
                continue
            r = _hermes(
                ["unblock", tid, "--reason", "body pool has free capacity (poller)"],
                timeout=15,
            )
            if r.returncode == 0:
                released.append(tid)
                slots -= 1
    return {"blocked": blocked, "released": released}


def world_setup(world: str, spawn: dict[str, int]) -> None:
    """Peaceful, no mob spawning, frozen day; pin worldspawn to the colony spawn
    (the bodies' natural landing point) and confirm each body is there. The tp
    is now short — bodies already spawn at this point — so verification just
    guards against a body that hasn't settled yet. No starter tools: the colony
    crafts from scratch (peaceful disables hunger death)."""
    x, y, z = spawn["x"], spawn["y"], spawn["z"]
    # Resetting the world (delete+recreate) drops the bodies; wait for each to
    # reconnect (bot/server.js auto-reconnects) before positioning them.
    for b in BODY_POOL.values():
        for _ in range(30):
            if _bot_position(b["port"]) is not None:
                break
            time.sleep(2)
        else:
            raise RuntimeError(f"{b['user']} (:{b['port']}) did not reconnect after world reset")
    rcon_in(world, [
        "difficulty peaceful",
        "gamerule doMobSpawning false",
        "gamerule doDaylightCycle false",
        "time set day",
        f"forceload add {x >> 4} {z >> 4}",
        f"setworldspawn {x} {y} {z}",
    ])
    for b in BODY_POOL.values():
        _rcon([f"mvtp {b['user']} {world}"])
    time.sleep(3)
    for b in BODY_POOL.values():
        user, port = b["user"], b["port"]
        for attempt in range(6):
            rcon_in(world, [f"tp {user} {x} {y + 1} {z}", f"spawnpoint {user} {x} {y} {z}"])
            time.sleep(1.5)
            pos = _bot_position(port)
            if pos and abs(pos["x"] - x) < 8 and abs(pos["z"] - z) < 8:
                break
        else:
            raise RuntimeError(f"{user} would not settle at spawn ({x},{y},{z}); "
                               f"last pos {pos}")
    setup_observer(world, spawn)


def setup_observer(world: str, spawn: dict[str, int], observer: str = "re44") -> bool:
    """Best-effort: drop the human observer at the colony spawn in spectator mode
    so they can watch the run live. Skipped silently if `observer` isn't online —
    never fails the boot. Returns True if the observer was set up."""
    x, y, z = spawn["x"], spawn["y"], spawn["z"]
    try:
        online = _rcon(["list"])
        if observer not in online:
            return False
        _rcon([f"mvtp {observer} {world}"])
        time.sleep(1)
        _rcon([
            f"tp {observer} {x} {y + 3} {z}",
            f"gamemode spectator {observer}",
        ])
        return True
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# board: epic chain + P1 scout cards
# --------------------------------------------------------------------------- #
def _hermes(args: list[str], *, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(["hermes", "kanban", "--board", BOARD, *args],
                          cwd=REPO_ROOT, capture_output=True, text=True, timeout=timeout)


def reinit_board() -> None:
    _hermes(["boards", "create", BOARD])
    p = _hermes(["init"])
    if p.returncode != 0 and "exists" not in (p.stderr + p.stdout).lower():
        raise RuntimeError(f"board init failed: {p.stderr[:300]}")
    # Archive any leftover cards from a prior run so the board starts clean.
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        rows = lst if isinstance(lst, list) else lst.get("tasks", [])
        for t in rows:
            tid = str(t.get("id"))
            if tid and tid != "None":
                _hermes(["archive", tid], timeout=15)
    except Exception:
        pass


def _create_card(*, title: str, body: str, assignee: str, parent: str | None = None) -> str:
    args = ["create", title, "--body", body, "--assignee", assignee, "--json"]
    if parent:
        args += ["--parent", parent]
    p = _hermes(args)
    if p.returncode != 0:
        raise RuntimeError(f"create '{title[:40]}' failed: {p.stderr[:300]}")
    data = json.loads(p.stdout)
    tid = str(data.get("id") or data.get("task_id") or "")
    if not tid or tid == "None":
        raise RuntimeError(f"no id parsed from: {p.stdout[:200]}")
    return tid


def seed_board(ctx: dict[str, str]) -> dict:
    """Create the phase epics and the P1 scout cards. Returns {epic_ids, scout_ids}.

    Epics are NOT chained via --parent depends_on. Phase advancement is
    POLLER-AUTHORITATIVE: P1 is left dispatchable (ready) and P2..P5 are PARKED
    (blocked) at seed time. The poller (advance_phases) is the sole promoter — it
    `unblock`s the next phase only when the current phase's world-gate passes. This
    makes premature epic completion (e.g. a Steward worker that finishes instead of
    parking) HARMLESS: the next phase stays blocked until the gate really passes, so
    no cascade is possible. (Previously the depends_on chain auto-promoted P(n+1) the
    instant Pn went `done`, which a finishing Steward worker triggered with no real
    work — see the genesis-v2 postmortem.)"""
    epics = gl.parse_yaml_simple(TEMPLATES_DIR / "phase-epics.yaml")["epics"]
    cards = gl.parse_yaml_simple(TEMPLATES_DIR / "phase1-cards.yaml")["cards"]
    epic_ids = []
    for i, e in enumerate(epics):
        eid = _create_card(title=e["title"], body=gl.substitute(e.get("body", ""), ctx),
                           assignee=e["assignee"])
        # Park every phase after P1 so only the poller can open it (anti-cascade).
        # NOTE: `block` takes its reason as a POSITIONAL arg (unlike `unblock`,
        # which uses --reason). Passing --reason here silently no-ops the block.
        if i > 0:
            _hermes(["block", eid, "awaiting prior-phase gate (poller unblocks)"], timeout=15)
        epic_ids.append(eid)
    scout_ids = [_create_card(title=c["title"], body=gl.substitute(c.get("body", ""), ctx),
                              assignee=c["assignee"]) for c in cards]
    meta = {"epic_ids": epic_ids, "scout_ids": scout_ids}
    return meta


# --------------------------------------------------------------------------- #
# phase gates
# --------------------------------------------------------------------------- #
def _shared_marks() -> set[str]:
    loc = gl._load_json(DATA_DIR / "locations-base.json", default={})
    if isinstance(loc, dict):
        return set(loc.keys())
    if isinstance(loc, list):
        return {m["name"] for m in loc if isinstance(m, dict) and "name" in m}
    return set()


def _regions() -> list[dict]:
    return gl._load_json(DATA_DIR / "regions-world.json", default={}).get("regions", [])


def _inventory(pool: str = "genesis-v2") -> dict:
    """Genesis base-storage stock via base-inventory.py --pool <p> --suggest-json
    (genesis-aware: Mox/Pip/Zee; structured, not parsed text). Returns
    {ok, totals, chests_fresh, deficits:[{resource,current,target_min,deficit,
    assignee,items}]} or {} on failure."""
    try:
        p = subprocess.run([sys.executable, str(REPO_ROOT / "scripts" / "base-inventory.py"),
                            "--pool", pool, "--suggest-json"],
                           cwd=REPO_ROOT, capture_output=True, text=True, timeout=30)
        if p.returncode == 0:
            return json.loads(p.stdout or "{}")
    except Exception:
        pass
    return {}


GENESIS_BODY_USERS = frozenset(b["user"] for b in BODY_POOL.values())  # {Mox, Pip, Zee}


def _is_genesis_mine(m: dict) -> bool:
    """A mine authored by a genesis pool body (any entrance/point `by` in the
    pool). Used to count genesis mines in the SHARED mines-world.json without
    counting production mines (by Flint/Tester etc.) that also live there."""
    if not isinstance(m, dict):
        return False
    authors: set[str] = set()
    for e in (m.get("entrances") or []):
        if isinstance(e, dict) and e.get("by"):
            authors.add(e["by"])
    for p in (m.get("points") or []):
        if isinstance(p, dict) and p.get("by"):
            authors.add(p["by"])
    return bool(authors & GENESIS_BODY_USERS)


def _genesis_mine_entries(safe_world: str) -> list:
    """Mine-registry entries that belong to THIS genesis run.

    The bot's mine store keys its file by config.behaviors.regionsWorld, which for
    the genesis pool resolves to the default "world" (mineflayer can't see the
    Multiverse name) — so genesis mines land in the SHARED data/mines-world.json
    alongside production mines, NOT in mines-<multiverse-world>.json. The P3 gate
    was reading the (nonexistent) per-world file, so it never saw the mines the
    bodies actually registered (gv2-2026-06-15-4). Read both:
      (a) mines-<safe_world>.json — honoured if a future run sets regionsWorld to
          the multiverse name (proper per-world isolation), and
      (b) mines-world.json, filtered to pool-authored mines — what the pool writes
          today; the author filter keeps production mines from satisfying the gate.
    """
    out: list = []
    per_world = gl._load_json(DATA_DIR / f"mines-{safe_world}.json", default={})
    pw = per_world.get("mines", per_world) if isinstance(per_world, dict) else per_world
    if isinstance(pw, list):
        out += pw
    if safe_world != "world":
        shared = gl._load_json(DATA_DIR / "mines-world.json", default={})
        sm = shared.get("mines", []) if isinstance(shared, dict) else shared
        if isinstance(sm, list):
            out += [m for m in sm if _is_genesis_mine(m)]
    return out


def check_phases() -> dict[str, dict]:
    rules = gl.parse_yaml_simple(TEMPLATES_DIR / "phase-checklists.yaml").get("phases", {})
    marks = _shared_marks()
    regions = {r.get("id"): r for r in _regions()}
    # Mine registry is PER-WORLD (data/mines-<world>.json). Read the active
    # genesis world's file — NOT the hardcoded "mines-world.json", which is the
    # production world (literally named "world"); its mines must not satisfy the
    # genesis P3 gate.
    _gworld = "genesis2"
    try:
        _rid = active_run_id()
        if _rid:
            _gworld = load_config(_rid).get("world") or _gworld
    except Exception:
        pass
    _safe_world = re.sub(r"[^\w.-]", "_", str(_gworld))
    mine_entries = _genesis_mine_entries(_safe_world)
    out: dict[str, dict] = {}
    for phase, rule in rules.items():
        fails: list[str] = []
        mk = rule.get("marks", {})
        if mk.get("base_anchor_required") and not any("base_anchor" in n for n in marks):
            fails.append("missing base_anchor mark")
        for pref, key in (("chest_", "chest_prefix_min"), ("lt_", "lt_prefix_min"),
                          ("mine_", "mine_prefix_min"), ("farm_", "farm_prefix_min")):
            if key in mk:
                have = sum(1 for n in marks if str(n).startswith(pref))
                if have < mk[key]:
                    fails.append(f"{pref}* {have} < {mk[key]}")
        for rdef in rule.get("regions", []):
            rid = rdef.get("id")
            reg = regions.get(rid)
            if not reg:
                fails.append(f"missing region {rid}")
            elif rdef.get("must_allow_place") and not reg.get("capabilities", {}).get("allow_ad_hoc_place"):
                fails.append(f"region {rid} not buildable")
        mr = rule.get("mine_registry", {})
        if "entries_min" in mr:
            n = len(mine_entries) if isinstance(mine_entries, (list, dict)) else 0
            if n < mr["entries_min"]:
                fails.append(f"mine entries {n} < {mr['entries_min']}")
        # Inventory gate (P2): each listed resource at/above its target_min in
        # base storage. Lazy — only the phase(s) with an inventory rule pay the
        # base-inventory.py read.
        inv_rule = rule.get("inventory", {})
        if inv_rule.get("resources"):
            inv = _inventory()
            totals = inv.get("totals") or {}
            # Fail-safe: only enforce the stock gate when the base is MEASURABLE
            # (capture live + something stocked). An empty/zero or unreadable
            # inventory (broken chest-snapshot capture, or nothing gathered yet)
            # must NOT block the phase — the continuous-supply loop fills stocks,
            # and this gate bites once anything is stocked. (Prevents the
            # broken-capture-stalls-P2 failure the deferral was guarding against.)
            measurable = bool(inv.get("ok")) and sum(int(v) for v in totals.values()) > 0
            if measurable:
                deficits = {d["resource"]: d for d in inv.get("deficits", [])}
                for res in inv_rule["resources"]:
                    d = deficits.get(res)
                    if d:
                        fails.append(f"{res} {d['current']} < {d['target_min']}")
        # Gates not yet implemented in code (P4 roads / far marks, P5
        # steady-state) must FAIL — otherwise an unevaluated rule reads as a
        # trivial pass and the poller would auto-complete the phase. Until these
        # are built, the phase cannot close.
        for unimpl in ("roads", "steady_state"):
            if unimpl in rule:
                fails.append(f"{unimpl} gate not yet implemented")
        if "lt_far_min" in rule.get("marks", {}):
            fails.append("lt_far gate not yet implemented")
        out[phase] = {"pass": not fails, "failures": fails}
    return out


# --------------------------------------------------------------------------- #
# gate-gated epic completion (verified state advances phases, not narration)
# --------------------------------------------------------------------------- #
def _board_status_by_id() -> dict[str, str]:
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        tasks = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        tasks = []
    return {str(t.get("id")): (t.get("status") or "").lower() for t in tasks}


def _free_body_count() -> int:
    """Free bodies in the lease pool (not leased, not busy, reachable)."""
    try:
        out = subprocess.run(["mc", "bot", "status", "--pool", "--json"],
                             capture_output=True, text=True, timeout=15, cwd=REPO_ROOT)
        bodies = json.loads(out.stdout or "{}").get("data", {}).get("bodies", [])
        return sum(1 for b in bodies
                   if not b.get("lease") and not b.get("busy") and b.get("reachable", True))
    except Exception:
        return 0


# Kanban statuses that mean the owning worker is dead — its bot lease is an orphan.
# (`archived` tasks are also dropped from `hermes list`, so an owner absent from
# the board status map is treated as terminal too.)
TERMINAL_TASK_STATUSES = {"archived", "done", "cancelled", "canceled"}


def _pool_lease_rows() -> list[dict]:
    """[{bot, owner_id, busy, reachable}] for pool bodies that currently hold a lease."""
    try:
        out = subprocess.run(["mc", "bot", "status", "--pool", "--json"],
                             capture_output=True, text=True, timeout=15, cwd=REPO_ROOT)
        bodies = json.loads(out.stdout or "{}").get("data", {}).get("bodies", [])
    except Exception:
        return []
    rows = []
    for b in bodies:
        lease = b.get("lease")
        if lease and lease.get("owner_id"):
            rows.append({"bot": b.get("bot"), "owner_id": lease["owner_id"],
                         "busy": bool(b.get("busy")), "reachable": b.get("reachable", True)})
    return rows


def _release_lease_by_owner(owner_id: str) -> bool:
    """Release a specific owner's lease via `mc bot release --owner`. The CLI's
    release() probes the body and refuses a busy one, so this can't steal a body
    that's mid-action. Returns True only on a clean release."""
    try:
        r = subprocess.run(["mc", "bot", "release", "--owner", owner_id],
                           capture_output=True, text=True, timeout=15, cwd=REPO_ROOT)
        return r.returncode == 0
    except Exception:
        return False


def reap_orphan_leases(run_id: str | None = None, *, reap_all: bool = False,
                       status_by_id: dict[str, str] | None = None,
                       lease_rows: list[dict] | None = None) -> list[dict]:
    """Free pool-body leases whose owning kanban task is no longer active.

    A worker that times out / gives up / is killed never runs `mc bot release`, so
    its lease lingers until the 1h TTL (lease-registry.reapExpiredIdle only
    reclaims AFTER expiry — it's task-agnostic and can't see the worker died).
    That locks the body; once all three leak the pool deadlocks (see the
    gv2-2026-06-15-3 postmortem). The poller CAN see board status, so it reaps
    here: a lease whose owner task is terminal (archived/done/cancelled) or absent
    from the board is released immediately. `release()` still refuses a busy body,
    so an in-flight action is never stolen.

    reap_all=True (boot clean-slate) releases every genesis-owned lease regardless
    of status — a fresh run must start with an empty pool, which also clears a
    prior run's leak ('body owned by previous run'). Only genesis-owned leases
    (owner_id `genesis-v2:*`) are ever touched; operator/foreign leases are left.
    """
    rows = lease_rows if lease_rows is not None else _pool_lease_rows()
    status = status_by_id if status_by_id is not None else _board_status_by_id()
    prefix = f"{BOARD}:"
    freed: list[dict] = []
    for r in rows:
        owner = r.get("owner_id") or ""
        if not owner.startswith(prefix):
            continue  # operator / foreign-board lease — never our business
        task_id = owner[len(prefix):].split(":", 1)[0]  # board:task[:session]
        st = status.get(task_id)
        terminal = (st is None) or (st in TERMINAL_TASK_STATUSES)
        if reap_all or terminal:
            if _release_lease_by_owner(owner):
                freed.append({"bot": r.get("bot"), "owner_id": owner, "status": st or "absent"})
    return freed


def clear_pool_leases() -> list[dict]:
    """Boot clean-slate: drop all genesis-owned leases on the pool bodies so a
    fresh run starts with an empty pool (prevents cross-run lease leaks)."""
    return reap_orphan_leases(reap_all=True)


# ── Gateway dispatch watchdog ────────────────────────────────────────────────
# The hermes gateway runs the kanban dispatcher as an asyncio task. On a
# worker-crash/auto-block path that task can throw and die SILENTLY while the
# event loop keeps running (verified via py-spy on run gv2-2026-06-15-4: main
# thread healthy in select(), but dispatch/promotion stopped and gateway.log went
# quiet). The process looks alive, so nothing restarts it, and the run stalls
# with ready/todo cards that never dispatch. Until that's fixed upstream, the
# poller watches gateway.log and bounces the gateway when it goes silent while
# work is waiting.
GATEWAY_LOG = Path.home() / ".hermes" / "logs" / "gateway.log"
GATEWAY_STALE_S = 180             # 3 missed 60s dispatch ticks → task suspected dead
GATEWAY_RESTART_COOLDOWN_S = 300  # don't bounce again until a restart has had time to take


def _dispatch_looks_dead(log_age_s: float, pending: int) -> bool:
    """Pure decision: gateway.log silent past the stale threshold AND genesis
    cards are waiting for dispatch/promotion (ready/todo)."""
    return log_age_s >= GATEWAY_STALE_S and pending > 0


def detect_dead_dispatch(*, status_by_id: dict[str, str] | None = None,
                         now: float | None = None) -> bool:
    try:
        age = (now if now is not None else time.time()) - GATEWAY_LOG.stat().st_mtime
    except Exception:
        return False  # no log to judge by — don't act
    status = status_by_id if status_by_id is not None else _board_status_by_id()
    pending = sum(1 for s in status.values() if s in ("ready", "todo"))
    return _dispatch_looks_dead(age, pending)


def restart_gateway() -> bool:
    """Replace the gateway process (clears a dead dispatch task + reloads config).
    Authorised for this localhost, single-project setup."""
    try:
        subprocess.Popen(["hermes", "gateway", "run", "--replace"], cwd=REPO_ROOT,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
        return True
    except Exception:
        return False


def maybe_restart_dead_gateway(run_id: str, *, now: float | None = None) -> bool:
    """Watchdog: bounce the gateway if its dispatch task looks dead, with a
    cooldown (stamped per run) so a slow-to-start gateway can't trigger a restart
    loop. Returns True if a restart was issued."""
    if not detect_dead_dispatch(now=now):
        return False
    now = now if now is not None else time.time()
    stamp = run_dir(run_id) / "gateway-restart.stamp"
    try:
        last = float(stamp.read_text().strip())
    except Exception:
        last = 0.0
    if now - last < GATEWAY_RESTART_COOLDOWN_S:
        return False
    if restart_gateway():
        try:
            stamp.write_text(str(now))
        except Exception:
            pass
        return True
    return False


# ── Gate-gap re-engagement ───────────────────────────────────────────────────
# The colony can mark every worker card done yet leave a phase gate unmet — e.g.
# BUILD completes having placed 1 of 2 required chests (run gv2-2026-06-15-4).
# With the phase epic prematurely completed and zero active cards, nothing
# recovers: the stuck-worker detector only fires on running/blocked workers, not
# on "gate unmet + idle". This re-engages the planner to close the specific gap.
MAX_GATE_GAP_PER_PHASE = 3  # cap re-engagement cards per phase (else operator problem)


def _active_card_count() -> int:
    """Cards the gateway/workers are actively moving (ready/todo/running). Excludes
    parked epics (blocked) and done/archived. Returns -1 if the board is unreadable
    (caller treats that as 'don't act')."""
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        tasks = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        return -1
    return sum(1 for t in tasks
               if (t.get("status") or "").lower() in ("ready", "todo", "running"))


def detect_gate_gap(run_id: str, *, gates: dict | None = None,
                    active: int | None = None) -> tuple[str, list[str]] | None:
    """Returns (frontier_phase, failures) when the lowest failing phase gate is
    unmet AND there are no active cards (work has run dry without satisfying the
    gate), else None."""
    active = active if active is not None else _active_card_count()
    if active != 0:
        return None  # work still in flight (or board unreadable) — let it run
    gates = gates if gates is not None else check_phases()
    for phase in sorted(gates):  # P1..P5
        g = gates[phase]
        if not g.get("pass"):
            return (phase, list(g.get("failures", [])))
    return None


def file_gate_gap_card(run_id: str, phase: str, failures: list[str]) -> str | None:
    """Re-engage the PLANNER when a phase gate is unmet but no work is in flight.
    Dedup (skip if an open GATE-GAP card for this phase exists) + cap. The planner
    acts via the board only. Returns the new card id, or None."""
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        tasks = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        tasks = []
    tag = f"GATE-GAP {phase}"
    prior = 0
    for t in tasks:
        if tag in (t.get("title", "") or ""):
            prior += 1
            if (t.get("status") or "").lower() not in ("done", "archived"):
                return None  # already open for this phase
    if prior >= MAX_GATE_GAP_PER_PHASE:
        return None  # budget spent — leave parked for the operator
    fails = "; ".join(failures) or "gate unmet"
    title = f"[GENESIS2:GATE-GAP] {tag}"
    body = (
        f"Phase {phase} is INCOMPLETE but every worker card is done and nothing is in "
        f"flight — the colony ran dry without satisfying the gate.\n\n"
        f"Unmet {phase} gate conditions: {fails}\n\n"
        f"You are the PLANNER. Act via the BOARD only — never touch a body:\n"
        f"  1. Read the shared map + board: what exists vs what the gate needs above.\n"
        f"  2. File the SMALLEST worker card(s) that close the gap, with the lease ritual "
        f"(`mc bot checkout --near <coords> --cap <role>` -> work -> `mc bot release`) and "
        f"literal `mc` verb lines. (E.g. a missing chest: place a chest on cleared ground "
        f"beside base_anchor and `mc mark chest_storage_<n> --at <x> <y> <z>`.)\n"
        f"  3. Then `kanban_complete` THIS card. Do NOT `kanban_complete` a phase epic, "
        f"and do NOT duplicate work already done."
    )
    r = _hermes(["create", title, "--body", body, "--assignee", "colony-planner", "--json"])
    if r.returncode == 0:
        try:
            return str(json.loads(r.stdout).get("id"))
        except Exception:
            return None
    return None


# ── Overseer review (primary phase-boundary verifier) ────────────────────────
# At a phase transition the OVERSEER (read-only agent) verifies the gate and
# either confirms the phase or files the missing worker card(s) — agent judgment
# where file_gate_gap_card was a mechanical stand-in (now a latent deeper
# backstop). Dedup + cap like the others.
MAX_OVERSEER_PER_PHASE = 3


def file_overseer_card(run_id: str, phase: str, gate: dict) -> str | None:
    """File a colony-overseer review card carrying the phase's gate state. Skips
    if an open OVERSEE card for this phase exists, or once the per-phase budget is
    spent (operator problem then). Returns the new card id, or None."""
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        tasks = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        tasks = []
    tag = f"OVERSEE {phase}"
    prior = 0
    for t in tasks:
        if tag in (t.get("title", "") or ""):
            prior += 1
            if (t.get("status") or "").lower() not in ("done", "archived"):
                return None  # already open for this phase
    if prior >= MAX_OVERSEER_PER_PHASE:
        return None
    fails = gate.get("failures", [])
    status_line = "ALL CONDITIONS PASS" if gate.get("pass") else ("FAILING -> " + ("; ".join(fails) or "gate unmet"))
    title = f"[GENESIS2:OVERSEE] {tag}"
    body = (
        f"Phase {phase} reached a transition: its worker cards are done but the "
        f"phase has not closed. Verify it.\n\n"
        f"CURRENT {phase} GATE STATE (ground truth — you have no body, do not "
        f"re-measure the world): {status_line}\n\n"
        f"You are the OVERSEER (read-only). If every condition passes, comment "
        f"`verified: {phase} complete` and `kanban_complete` THIS card (the poller "
        f"closes the phase). If any condition fails, file the SMALLEST worker "
        f"card(s) that close each failure — correct expertise assignee, lease "
        f"ritual + literal `mc <verb>` lines — checking the board first to avoid "
        f"duplicates, then `kanban_complete` THIS card. NEVER `kanban_complete` a "
        f"phase epic."
    )
    r = _hermes(["create", title, "--body", body, "--assignee", "colony-overseer", "--json"])
    if r.returncode == 0:
        try:
            return str(json.loads(r.stdout).get("id"))
        except Exception:
            return None
    return None


# ── Continuous supply ────────────────────────────────────────────────────────
# Resource supply is a continuous colony need, not a one-off. Each tick, read the
# genesis-aware base inventory; when a resource is below target_min (and the base
# is measurable — something stocked), file a [GENESIS2:SUPPLY] card to the
# expertise that restocks it. Dedup + cap so a persistent deficit doesn't spam.
MAX_SUPPLY_PER_RESOURCE = 2


def detect_supply_deficits(pool: str = "genesis-v2") -> list[dict]:
    """Resources below target_min in base storage (genesis-aware, structured).
    Empty when capture isn't live / nothing stocked yet (fail-safe — don't spam
    SUPPLY cards before any chest is filled) or all resources are at target."""
    inv = _inventory(pool)
    if not inv.get("ok"):
        return []
    totals = inv.get("totals") or {}
    if sum(int(v) for v in totals.values()) <= 0:
        return []  # unmeasured/empty base — let the phase work stock the first chest
    return inv.get("deficits", [])


def file_supply_card(run_id: str, deficit: dict) -> str | None:
    """File a [GENESIS2:SUPPLY] worker card for a below-target resource, routed to
    the genesis expertise that restocks it (deficit['assignee']). Dedup (skip an
    open SUPPLY card for this resource) + cap. Returns the new card id, or None."""
    res = deficit.get("resource")
    assignee = deficit.get("assignee") or "colony-gatherer"
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        tasks = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        tasks = []
    tag = f"SUPPLY {res}"
    prior = 0
    for t in tasks:
        if tag in (t.get("title", "") or ""):
            prior += 1
            if (t.get("status") or "").lower() not in ("done", "archived"):
                return None  # already an open supply card for this resource
    if prior >= MAX_SUPPLY_PER_RESOURCE:
        return None
    cur, tmin = deficit.get("current"), deficit.get("target_min")
    items = ", ".join((deficit.get("items") or [])[:4])
    title = f"[GENESIS2:SUPPLY] {tag}"
    body = (
        f"Base {res} is low: {cur} < target_min {tmin}. Restock it and deposit to a "
        f"base chest, then `kanban_complete`.\n\n"
        f"Lease ritual + literal mc verbs: `mc bot checkout --near <base_anchor coords> "
        f"--cap <your role> --mark base_anchor` -> gather/mine {res} ({items}) -> deposit "
        f"to the `chest_{res}` (or a labeled base chest) -> `mc bot release`. Verify the "
        f"chest count rose before completing — base-inventory is the authoritative check."
    )
    r = _hermes(["create", title, "--body", body, "--assignee", assignee, "--json"])
    if r.returncode == 0:
        try:
            return str(json.loads(r.stdout).get("id"))
        except Exception:
            return None
    return None


def _latest_block_reason(tid: str) -> str:
    """Most recent block reason for a task (empty if currently effectively unblocked)."""
    try:
        d = json.loads(_hermes(["show", str(tid), "--json"]).stdout or "{}")
    except Exception:
        return ""
    reason = ""
    for ev in d.get("events", []):
        kind = ev.get("kind")
        if kind == "blocked":
            reason = (ev.get("payload") or {}).get("reason", "") or ""
        elif kind == "unblocked":
            reason = ""
    return reason


def requeue_deferred(run_id: str) -> list[str]:
    """Unblock worker cards that deferred with `no_free_body` once the pool frees up.
    A deferred card is sticky-blocked and never retries on its own, so anything
    depending on it (e.g. BASE-SELECT waiting on ALL scouts) stalls forever behind a
    scout that merely lost the lease race. Requeue at most `free` of them per tick.
    NEVER touches phase EPICS — those are parked intentionally and only
    advance_phases opens them on a gate-pass. Returns the requeued ids."""
    free = _free_body_count()
    if free <= 0:
        return []
    cfg = load_config(run_id)
    epic_ids = {str(e) for e in cfg.get("epic_ids", [])}
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        tasks = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        return []
    requeued: list[str] = []
    for t in tasks:
        tid = str(t.get("id"))
        if (t.get("status") or "").lower() != "blocked" or tid in epic_ids:
            continue
        if "no_free_body" not in _latest_block_reason(tid):
            continue
        r = _hermes(["unblock", tid, "--reason", "body free — requeue deferred (no_free_body)"], timeout=20)
        if r.returncode == 0:
            requeued.append(tid)
            free -= 1
            if free <= 0:
                break
    return requeued


STALL_AGE_S = 600  # a running worker older than this is very likely stuck (a
                   # healthy worker finishes in a few minutes). Run-age — not
                   # position — is the signal, so a worker that's progressing (and
                   # will finish under the cap) is NEVER flagged; in-place work
                   # (building, crafting) isn't false-flagged either.


def detect_stalled_workers(max_age_s: int = STALL_AGE_S) -> list[dict]:
    """Running, non-epic worker cards whose current run has exceeded max_age_s.
    These are alive-but-likely-stuck (looping on a failing action, unreachable
    target, etc). Skips epics and existing SUPERVISE cards."""
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        tasks = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        return []
    now = time.time()
    out = []
    for t in tasks:
        if (t.get("status") or "").lower() != "running":
            continue
        title = t.get("title", "") or ""
        if title.startswith("[EPIC]") or "SUPERVISE" in title:
            continue
        started = t.get("started_at")
        if not started:
            continue
        try:
            age = now - float(started)
        except (TypeError, ValueError):
            continue
        if age > max_age_s:
            out.append({"id": str(t.get("id")), "title": title, "age_s": int(age)})
    return out


def detect_blocked_workers(gates: dict | None = None) -> list[dict]:
    """Blocked, non-epic worker cards that the planner should resolve: a worker that
    blocked itself for a substantive reason (no_water, help_needed, region, out of
    materials, etc) stalls the colony with nothing running. EXCLUDES `no_free_body`
    (requeue_deferred handles that) and workers whose phase gate already passed
    (those are moot — e.g. a P1 worker after P1 is done). Returns {id,title,summary}."""
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        tasks = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        return []
    gates = gates if gates is not None else check_phases()
    out = []
    for t in tasks:
        if (t.get("status") or "").lower() != "blocked":
            continue
        title = t.get("title", "") or ""
        if title.startswith("[EPIC]") or "SUPERVISE" in title:
            continue
        # Skip workers whose phase gate already passed (moot/superseded).
        m = re.search(r"\[GENESIS2:(P\d)\]", title)
        if m and gates.get(m.group(1), {}).get("pass"):
            continue
        reason = _latest_block_reason(str(t.get("id")))
        if not reason or "no_free_body" in reason or AWAITING_FREE_BODY in reason:
            continue  # pool gates handle these; ignore reasonless
        out.append({"id": str(t.get("id")), "title": title, "summary": f"blocked: {reason}"})
    return out


MAX_SUPERVISE_PER_WORKER = 3  # cap escalations — past this the worker is parked
                              # for the operator, not re-escalated (a structural /
                              # admin-needed block can't be fixed by the planner, and
                              # churning supervise cards is pure waste; one run hit 31).


def file_supervise_card(run_id: str, worker_id: str, worker_title: str, summary: str) -> str | None:
    """Re-engage the PLANNER: file a [SUPERVISE] card (assignee colony-planner) for a
    stuck worker (running too long OR blocked). Skips if one is already OPEN, OR if the
    worker has already been escalated MAX_SUPERVISE_PER_WORKER times (open+resolved) —
    a persistently-stuck worker is an operator problem (structural/admin), so stop the
    churn rather than file an endless stream of supervise cards. The planner acts via
    the board only — it never touches a body. Returns the new card id, or None."""
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        tasks = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        tasks = []
    tag = f"SUPERVISE {worker_id}"
    prior = 0
    for t in tasks:
        if tag in (t.get("title", "") or ""):
            prior += 1
            if (t.get("status") or "").lower() not in ("done", "archived"):
                return None  # already escalated (open card) for this worker
    if prior >= MAX_SUPERVISE_PER_WORKER:
        return None  # escalation budget spent — leave it parked for the operator
    title = f"[GENESIS2:SUPERVISE] {tag}"
    body = (
        f"Worker {worker_id} (\"{worker_title[:60]}\") is stuck — {summary}\n\n"
        f"You are the PLANNER. Investigate and act via the BOARD only — never touch a body:\n"
        f"  1. `kanban show {worker_id}` — read its latest comments/events: what failed?\n"
        f"  2. Read the shared map + board for context (resources, marks, what exists).\n"
        f"  3. Decide ONE:\n"
        f"     a. It's actually fine / nearly done or already superseded -> comment why and "
        f"`kanban_complete` THIS supervise card.\n"
        f"     b. It needs a PREREQUISITE (e.g. no water → file a card to source/place water; "
        f"out of materials → file a gather card) -> file that worker card (lease ritual + "
        f"literal `mc` verbs), keep the blocked worker for later or re-file a fresh one, then "
        f"complete this card.\n"
        f"     c. It's mis-scoped/unreachable -> `kanban_block` it with a precise reason and file "
        f"a smaller/alternative worker card.\n"
        f"  Do NOT duplicate work already in flight, and do NOT `kanban_complete` a phase epic."
    )
    r = _hermes(["create", title, "--body", body, "--assignee", "colony-planner", "--json"])
    if r.returncode == 0:
        try:
            return str(json.loads(r.stdout).get("id"))
        except Exception:
            return None
    return None


def advance_phases(run_id: str, *, status_by_id: dict[str, str] | None = None,
                   gates: dict | None = None) -> list[str]:
    """Poller-authoritative phase advancement. Walk phases in order; for each whose
    world-gate (check_phases) passes, ensure its epic is `done` and `unblock` the
    NEXT phase epic (parked `blocked` at seed time) so the gateway dispatches it.
    Stop at the first phase whose gate does NOT pass — never skip ahead.

    This is the ONLY promoter. Because P2..P5 are seeded `blocked`, a Steward worker
    that finishes (completing its epic) instead of parking cannot promote the next
    phase — only a real gate-pass here unblocks it. Returns phase keys advanced.

    `status_by_id`/`gates` are injectable for the no-agent transition test.

    Args of note: completing an epic accepts `blocked` (parked) state too — see
    hermes complete_task `status IN (running, ready, blocked)`."""
    cfg = load_config(run_id)
    epic_ids = cfg.get("epic_ids", [])           # ordered P1..P5
    gates = gates if gates is not None else check_phases()
    phases = [f"P{i}" for i in range(1, len(epic_ids) + 1)]
    status = status_by_id if status_by_id is not None else _board_status_by_id()
    advanced: list[str] = []
    for i, (phase, eid) in enumerate(zip(phases, epic_ids)):
        g = gates.get(phase, {})
        if not g.get("pass"):
            break  # frontier reached — do not promote past an unmet gate
        # 1) ensure this phase's epic is closed (idempotent).
        if status.get(str(eid)) not in ("done", "archived"):
            r = _hermes(["complete", str(eid), "--result", f"gate {phase} passed"], timeout=20)
            if r.returncode == 0:
                status[str(eid)] = "done"
                advanced.append(phase)
        # 2) open the next phase epic if it's still parked.
        if i + 1 < len(epic_ids):
            nxt = str(epic_ids[i + 1])
            if status.get(nxt) == "blocked":
                r = _hermes(["unblock", nxt, "--reason", f"{phase} gate passed"], timeout=20)
                if r.returncode == 0:
                    status[nxt] = "ready"
    return advanced


# --------------------------------------------------------------------------- #
# snapshot (lightweight, file/board-driven)
# --------------------------------------------------------------------------- #
def snapshot(label: str, run_id: str) -> Path:
    marks = sorted(_shared_marks())
    by_prefix: dict[str, int] = {}
    for n in marks:
        for pref in ("base_", "chest_", "lt_wood_", "lt_stone_", "lt_water_",
                     "candidate_", "mine_", "farm_"):
            if n.startswith(pref):
                by_prefix[pref] = by_prefix.get(pref, 0) + 1
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        tasks = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        tasks = []
    status_counts: dict[str, int] = {}
    for t in tasks:
        s = (t.get("status") or "").lower()
        status_counts[s] = status_counts.get(s, 0) + 1
    snap = {
        "ts": gl._iso_utc(),
        "run_id": run_id,
        "label": label,
        "phase_checks": check_phases(),
        "marks": {"total": len(marks), "by_prefix": by_prefix, "names": marks},
        "board": {"status_counts": status_counts, "card_total": len(tasks)},
    }
    out = run_dir(run_id) / f"snapshot-{label}.json"
    out.write_text(json.dumps(snap, indent=2) + "\n")
    return out

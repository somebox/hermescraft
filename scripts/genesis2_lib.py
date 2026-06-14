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
        env = {**os.environ, "API_PORT": str(api), "VIEWER_PORT": str(api + 1000),
               "BOT_MOVEMENT_PROFILE": "slow", "MC_HOST": host, "MC_PORT": str(port_mc),
               "MC_USERNAME": user}
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


def probe_natural_spawn(world: str, *, probe_user: str = "Mox",
                        probe_port: int = 3007) -> dict[str, int]:
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
    x, y, z = int(round(last["x"])), int(round(last["y"])), int(round(last["z"]))
    rcon_in(world, [f"forceload add {x >> 4} {z >> 4}"])
    # Land check: feet must not be in water, and there must be solid ground just
    # below. Sea level is ~63 — a settled Y at/below that over water means ocean.
    # NB: read the condition via `execute if`'s "Test passed"/"Test failed" result
    # — `run say MARKER` does NOT round-trip through rcon (the broadcast never
    # appears in the command response), so the old say-based checks always read
    # false (e.g. never detected water, and false-rejected every biome).
    feet_water = "Test passed" in rcon_in(
        world, [f"execute positioned {x} {y} {z} if block ~ ~ ~ minecraft:water"])
    below_water = "Test passed" in rcon_in(
        world, [f"execute positioned {x} {y} {z} if block ~ ~-1 ~ minecraft:water"])
    if feet_water or below_water:
        raise RuntimeError(
            f"natural spawn ({x},{y},{z}) is water/ocean in {world}; re-roll the "
            f"seed (--seed) for a land spawn")
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

    def _surface_y(px: int, pz: int) -> int | None:
        for yy in range(y + 12, y - 12, -1):
            solid = "Test passed" in rcon_in(
                world,
                [f"execute positioned {px} {yy} {pz} unless block ~ ~ ~ minecraft:air "
                 f"unless block ~ ~ ~ minecraft:water"])
            if solid:
                return yy
        return None

    samples = [(x + dx, z + dz) for dx, dz in
               ((0, 0), (6, 0), (-6, 0), (0, 6), (0, -6), (6, 6), (-6, -6))]
    ys = [s for s in (_surface_y(px, pz) for px, pz in samples) if s is not None]
    if len(ys) >= 4:
        spread = max(ys) - min(ys)
        if spread > 5:
            raise RuntimeError(
                f"natural spawn ({x},{y},{z}) terrain too steep (surface-Y spread "
                f"{spread} over ~12 blocks) — mountainous, not buildable; re-roll the seed")
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


def _inventory() -> dict:
    """Base-storage inventory as {resource: {current, target_min}} via
    base-inventory.py. Empty on any failure (gate then reports the shortfall)."""
    try:
        p = subprocess.run([sys.executable, str(REPO_ROOT / "scripts" / "base-inventory.py"), "--json"],
                           cwd=REPO_ROOT, capture_output=True, text=True, timeout=30)
        if p.returncode == 0:
            return json.loads(p.stdout or "{}")
    except Exception:
        pass
    return {}


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
    mines = gl._load_json(DATA_DIR / f"mines-{_safe_world}.json", default={})
    mine_entries = mines.get("mines", mines) if isinstance(mines, dict) else mines
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
            for res in inv_rule["resources"]:
                r = inv.get(res) or {}
                cur = r.get("current", 0)
                need = r.get("target_min", 9999)
                if cur < need:
                    fails.append(f"{res} {cur} < {need}")
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
        if not reason or "no_free_body" in reason:
            continue  # requeue handles no_free_body; ignore reasonless
        out.append({"id": str(t.get("id")), "title": title, "summary": f"blocked: {reason}"})
    return out


MAX_SUPERVISE_PER_WORKER = 3  # cap escalations — past this the worker is parked
                              # for the operator, not re-escalated (a structural /
                              # admin-needed block can't be fixed by the planner, and
                              # churning supervise cards is pure waste; one run hit 31).


def file_supervise_card(run_id: str, worker_id: str, worker_title: str, summary: str) -> str | None:
    """Re-engage the PLANNER: file a [SUPERVISE] card (assignee colony-steward) for a
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
    r = _hermes(["create", title, "--body", body, "--assignee", "colony-steward", "--json"])
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

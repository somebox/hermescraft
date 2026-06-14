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

# Specialist -> body. Steward is read-only (no body). Mirrors the .env routing
# baked by genesis-v2-mint-profiles.sh.
BODIES = {
    "colony-scout": {"user": "Mox", "port": 3007},
    "colony-gatherer": {"user": "Pip", "port": 3005},
    "colony-builder": {"user": "Zee", "port": 3006},
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
    bots = ",".join(b["user"] for b in BODIES.values())
    if not _world_exists(world):
        # Evacuate any body that happens to be there, then create fresh.
        for b in BODIES.values():
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
    feet_water = "WATER" in rcon_in(
        world, [f"execute positioned {x} {y} {z} if block ~ ~ ~ minecraft:water run say WATER"])
    below_water = "WATER" in rcon_in(
        world, [f"execute positioned {x} {y} {z} if block ~ ~-1 ~ minecraft:water run say WATER"])
    if feet_water or below_water:
        raise RuntimeError(
            f"natural spawn ({x},{y},{z}) is water/ocean in {world}; re-roll the "
            f"seed (--seed) for a land spawn")
    return {"x": x, "y": y, "z": z}


def wipe_marks() -> None:
    """Clear the shared + per-bot mark stores so the colony starts on a clean
    map. Without this the run inherits stale waypoints (e.g. wp_road* from a
    prior proc-nav roadplan run) and the phase gates read garbage."""
    targets = [DATA_DIR / "locations-base.json"]
    targets += list(DATA_DIR.glob("locations-*.json"))
    targets += list(DATA_DIR.glob("personal-pois-*.json"))
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
    for b in BODIES.values():
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
    for b in BODIES.values():
        _rcon([f"mvtp {b['user']} {world}"])
    time.sleep(3)
    for b in BODIES.values():
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
    """Create the epic chain (P1->P5 via --parent depends_on) and the P1 scout
    cards (assignee colony-scout). Returns {epic_ids, scout_ids}."""
    epics = gl.parse_yaml_simple(TEMPLATES_DIR / "phase-epics.yaml")["epics"]
    cards = gl.parse_yaml_simple(TEMPLATES_DIR / "phase1-cards.yaml")["cards"]
    epic_ids, prev = [], None
    for e in epics:
        eid = _create_card(title=e["title"], body=gl.substitute(e.get("body", ""), ctx),
                           assignee=e["assignee"], parent=prev)
        epic_ids.append(eid)
        prev = eid
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


def check_phases() -> dict[str, dict]:
    rules = gl.parse_yaml_simple(TEMPLATES_DIR / "phase-checklists.yaml").get("phases", {})
    marks = _shared_marks()
    regions = {r.get("id"): r for r in _regions()}
    mines = gl._load_json(DATA_DIR / "mines-world.json", default={})
    mine_entries = mines.get("mines", mines) if isinstance(mines, dict) else mines
    out: dict[str, dict] = {}
    for phase, rule in rules.items():
        fails: list[str] = []
        mk = rule.get("marks", {})
        if mk.get("base_anchor_required") and not any("base_anchor" in n for n in marks):
            fails.append("missing base_anchor mark")
        for pref, key in (("chest_", "chest_prefix_min"), ("lt_", "lt_prefix_min"),
                          ("mine_", "mine_prefix_min")):
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
def complete_passed_epics(run_id: str) -> list[str]:
    """Complete any phase epic whose gate (check_phases) actually passes and is
    still open. This is the ONLY path that advances a phase — the Steward never
    completes its own epics, so phases can't race ahead on hallucinated work.
    Returns the phase keys completed this call."""
    cfg = load_config(run_id)
    epic_ids = cfg.get("epic_ids", [])           # ordered P1..P5
    gates = check_phases()
    phases = [f"P{i}" for i in range(1, len(epic_ids) + 1)]
    try:
        lst = json.loads(_hermes(["list", "--json"]).stdout or "[]")
        tasks = lst if isinstance(lst, list) else lst.get("tasks", [])
    except Exception:
        tasks = []
    status_by_id = {str(t.get("id")): (t.get("status") or "").lower() for t in tasks}
    done: list[str] = []
    for phase, eid in zip(phases, epic_ids):
        g = gates.get(phase, {})
        if g.get("pass") and status_by_id.get(str(eid)) not in ("done", "archived"):
            r = _hermes(["complete", str(eid), "--result", f"gate {phase} passed"], timeout=20)
            if r.returncode == 0:
                done.append(phase)
    return done


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

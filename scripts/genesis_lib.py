#!/usr/bin/env python3
"""Genesis boot library — world reset, templates, kanban seeding, phase checks."""

from __future__ import annotations

import atexit
import json
import os
import re
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
TEMPLATES_DIR = REPO_ROOT / "data" / "genesis" / "templates"
RUNS_ROOT = Path(os.environ.get("GENESIS_RUNS_ROOT", str(REPO_ROOT / "data" / "genesis-runs")))
DATA_DIR = REPO_ROOT / "data"
BOARD = os.environ.get("HERMES_KANBAN_BOARD", "landfolk-ops")
# Default to the canonical per-board path under ~/.hermes/kanban/boards/<slug>/.
# The previous fallback to `<repo>/kanban.db` made archive_run_state silently
# copy a non-existent file, so the real board was never archived OR replaced.
KANBAN_DB = Path(
    os.environ.get("HERMES_KANBAN_DB")
    or str(Path.home() / ".hermes" / "kanban" / "boards" / BOARD / "kanban.db")
)

MC_HOST_SSH = os.environ.get("MC_HOST_SSH", "ubuntu-host")
MC_DOCKER_NAME = os.environ.get("MC_DOCKER_NAME", "minecraft")
GENESIS_COMPOSE_FILE = os.environ.get(
    "GENESIS_COMPOSE_FILE", "/opt/stacks/minecraft/docker-compose.yml"
)
GENESIS_WORLD_DATA = os.environ.get("GENESIS_WORLD_DATA", "/data/world")
GENESIS_DRY_RUN = os.environ.get("GENESIS_DRY_RUN", "").lower() in ("1", "true", "yes")

PLACEHOLDER_RE = re.compile(r"\{([a-z0-9_]+)\}")
BANNED_COMPOSITE = frozenset({"anchor", "system_chest_at"})
ALLOWED_PLACEHOLDERS = frozenset(
    {
        "seed",
        "run_id",
        "anchor_x",
        "anchor_y",
        "anchor_z",
        "system_chest_x",
        "system_chest_y",
        "system_chest_z",
        "tower_x",
        "tower_y",
        "tower_z",
        "started_at",
    }
)
DIFFICULTY_LEVELS = frozenset({"peaceful", "easy", "normal", "hard"})
LABEL_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _iso_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _run(cmd: list[str], *, timeout: int = 120, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, **(env or {})},
    )


def rcon(command: str, *, quiet: bool = False) -> str:
    """Run one rcon command via ssh → docker exec → rcon-cli."""
    if GENESIS_DRY_RUN:
        return f"[dry-run] {command}"
    safe = command.replace("'", "'\"'\"'")
    ssh_cmd = f"sudo docker exec {MC_DOCKER_NAME} rcon-cli '{safe}'"
    proc = _run(["ssh", "-n", MC_HOST_SSH, ssh_cmd], timeout=60)
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0 and not quiet:
        raise RuntimeError(f"rcon failed ({proc.returncode}): {command}\n{out[:500]}")
    return out.strip()


def git_short_sha() -> str:
    proc = _run(["git", "rev-parse", "--short", "HEAD"], timeout=10)
    if proc.returncode == 0:
        return (proc.stdout or "").strip() or "unknown"
    return "unknown"


def runs_root() -> Path:
    RUNS_ROOT.mkdir(parents=True, exist_ok=True)
    return RUNS_ROOT


def run_dir(run_id: str) -> Path:
    d = runs_root() / run_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure_run_layout(run_id: str) -> Path:
    d = run_dir(run_id)
    for sub in ("observations", "findings", "rescues", "archived", "rendered"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    return d


def next_run_id() -> str:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    prefix = f"g-{today}-"
    n = 1
    for p in runs_root().iterdir():
        if p.is_dir() and p.name.startswith(prefix):
            try:
                n = max(n, int(p.name.split("-")[-1]) + 1)
            except ValueError:
                pass
    return f"{prefix}{n}"


_DATED_RUN_RE = re.compile(r"^g-\d{4}-\d{2}-\d{2}-\d+$")


def last_completed_run_id_before(run_id: str) -> str | None:
    """Return the most-recent prior DATED run (g-YYYY-MM-DD-N) that has a
    config.json. Used by `--keep-world` to inherit anchor + seed. Excludes
    g-dryrun-*, g-test-*, and any other non-dated run-id formats that may
    sort lexicographically after real runs."""
    candidates = sorted(
        p for p in runs_root().iterdir()
        if p.is_dir() and _DATED_RUN_RE.match(p.name) and p.name < run_id
    )
    for p in reversed(candidates):
        if (p / "config.json").exists():
            return p.name
    return None


def active_run_id() -> str | None:
    p = runs_root() / ".active"
    if not p.exists():
        return None
    line = p.read_text().strip().splitlines()
    return line[0].strip() if line else None


def write_active_run(run_id: str) -> None:
    (runs_root() / ".active").write_text(f"{run_id}\n")


def clear_active_run() -> None:
    p = runs_root() / ".active"
    if p.exists():
        p.unlink()


def load_config(run_id: str | None = None) -> dict:
    rid = run_id or active_run_id()
    if not rid:
        raise FileNotFoundError("no active genesis run")
    path = run_dir(rid) / "config.json"
    return json.loads(path.read_text())


def save_config(cfg: dict) -> None:
    rid = cfg["run_id"]
    path = run_dir(rid) / "config.json"
    path.write_text(json.dumps(cfg, indent=2) + "\n")


_lock_held = False


def acquire_run_lock(run_id: str) -> None:
    global _lock_held
    lock = runs_root() / ".lock"
    if lock.exists():
        raise RuntimeError(f"genesis lock held: {lock.read_text().strip()}")
    lock.write_text(f"{os.getpid()} {run_id} {_iso_utc()}\n")
    _lock_held = True

    def _cleanup() -> None:
        release_run_lock()

    atexit.register(_cleanup)


def release_run_lock() -> None:
    global _lock_held
    lock = runs_root() / ".lock"
    if lock.exists():
        try:
            pid = int(lock.read_text().split()[0])
            if pid == os.getpid():
                lock.unlink()
        except (ValueError, IndexError):
            lock.unlink()
    _lock_held = False


@contextmanager
def log_step(run_id: str, step: str):
    t0 = time.monotonic()
    log_path = run_dir(run_id) / "run.log"
    outcome = "ok"
    notes = ""
    try:
        yield
    except Exception as e:
        outcome = "fail"
        notes = str(e)[:500]
        raise
    finally:
        rec = {
            "ts": _iso_utc(),
            "step": step,
            "outcome": outcome,
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "notes": notes,
        }
        with log_path.open("a") as f:
            f.write(json.dumps(rec) + "\n")


def parse_yaml_simple(path: Path) -> dict:
    """Load genesis template YAML/JSON."""
    if path.suffix == ".json":
        return json.loads(path.read_text())
    try:
        import yaml  # type: ignore

        return yaml.safe_load(path.read_text()) or {}
    except ImportError:
        proc = _run(
            [
                sys.executable,
                "-c",
                "import yaml,sys,json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))",
                str(path),
            ],
            timeout=10,
        )
        if proc.returncode == 0:
            return json.loads(proc.stdout)
        raise RuntimeError(f"cannot parse {path}: pip install pyyaml") from None


def validate_templates() -> None:
    required = [
        "phase-epics.yaml",
        "phase1-cards.yaml",
        "phase-checklists.yaml",
        "base-goals.template.yaml",
        "regions-world.template.json",
        "hut1-guard-tower-plan.template.json",
        "system-chest-offsets.json",
    ]
    for name in required:
        p = TEMPLATES_DIR / name
        if not p.exists():
            raise FileNotFoundError(f"missing template: {p}")

    for p in TEMPLATES_DIR.iterdir():
        if p.is_file() and p.suffix in (".yaml", ".yml", ".json"):
            raw = p.read_text()
            for m in PLACEHOLDER_RE.findall(raw):
                if m in BANNED_COMPOSITE:
                    raise ValueError(f"banned composite placeholder {{{m}}} in {p.name}")
                if m not in ALLOWED_PLACEHOLDERS and "{" + m + "}" in raw:
                    # offsets json has no placeholders
                    if p.name != "system-chest-offsets.json":
                        pass  # allow only listed; strict for template bodies
            if p.name != "system-chest-offsets.json":
                for bad in BANNED_COMPOSITE:
                    if "{" + bad + "}" in raw:
                        raise ValueError(f"banned placeholder in {p.name}")

    epics = parse_yaml_simple(TEMPLATES_DIR / "phase-epics.yaml")
    if len(epics.get("epics", [])) != 4:
        raise ValueError("phase-epics.yaml must have 4 epics")
    cards = parse_yaml_simple(TEMPLATES_DIR / "phase1-cards.yaml")
    if len(cards.get("cards", [])) != 5:
        raise ValueError("phase1-cards.yaml must have 5 cards")


def load_offsets() -> dict:
    return json.loads((TEMPLATES_DIR / "system-chest-offsets.json").read_text())


def build_context(
    *,
    run_id: str,
    seed: int,
    anchor: dict[str, int],
    started_at: str | None = None,
) -> dict[str, str]:
    offsets = load_offsets()
    ax, ay, az = anchor["x"], anchor["y"], anchor["z"]
    tp = offsets["tower_pad"]
    pr = offsets["primary"]
    ctx = {
        "run_id": run_id,
        "seed": str(seed),
        "anchor_x": str(ax),
        "anchor_y": str(ay),
        "anchor_z": str(az),
        "system_chest_x": str(ax + pr["dx"]),
        "system_chest_y": str(ay + pr["dy"]),
        "system_chest_z": str(az + pr["dz"]),
        "tower_x": str(ax + tp["dx"]),
        "tower_y": str(ay + tp["dy"]),
        "tower_z": str(az + tp["dz"]),
        "started_at": started_at or _iso_utc(),
    }
    return ctx


def substitute(text: str, ctx: dict[str, str]) -> str:
    def repl(m: re.Match) -> str:
        key = m.group(1)
        if key not in ctx:
            raise KeyError(f"unknown placeholder {{{key}}}")
        return ctx[key]

    return PLACEHOLDER_RE.sub(repl, text)


def parse_anchor(s: str) -> dict[str, int]:
    parts = s.split(",")
    if len(parts) != 3:
        raise ValueError("anchor must be X,Y,Z")
    return {"x": int(parts[0]), "y": int(parts[1]), "z": int(parts[2])}


def render_templates(
    *,
    run_id: str,
    seed: int,
    anchor: dict[str, int],
    difficulty: str | None,
) -> dict:
    validate_templates()
    ensure_run_layout(run_id)
    ctx = build_context(run_id=run_id, seed=seed, anchor=anchor)
    rendered_dir = run_dir(run_id) / "rendered"

    # base-goals
    src = (TEMPLATES_DIR / "base-goals.template.yaml").read_text()
    out = substitute(src, ctx)
    (rendered_dir / "base-goals.yaml").write_text(out)
    _archive_if_exists(DATA_DIR / "base-goals.yaml", run_id)
    shutil.copy(rendered_dir / "base-goals.yaml", DATA_DIR / "base-goals.yaml")

    # regions-world
    src = (TEMPLATES_DIR / "regions-world.template.json").read_text()
    out = substitute(src, ctx)
    (rendered_dir / "regions-world.json").write_text(out)
    _archive_if_exists(DATA_DIR / "regions-world.json", run_id)
    (DATA_DIR / "regions-world.json").write_text(out)

    # hut1 plan patch
    patch = json.loads(substitute((TEMPLATES_DIR / "hut1-guard-tower-plan.template.json").read_text(), ctx))
    source = REPO_ROOT / patch["source_plan"]
    plan = json.loads(source.read_text())
    plan["anchor"]["coords"] = [int(ctx["tower_x"]), int(ctx["tower_y"]), int(ctx["tower_z"])]
    plan["anchor"]["marker"]["coords"] = [int(ctx["anchor_x"]), int(ctx["anchor_y"]), int(ctx["anchor_z"])]
    plan_path = DATA_DIR / "ops" / "plans" / "hut1-guard-tower-plan.json"
    _archive_if_exists(plan_path, run_id)
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    plan_path.write_text(json.dumps(plan, indent=2))
    (rendered_dir / "hut1-guard-tower-plan.json").write_text(json.dumps(plan, indent=2))

    offsets = load_offsets()
    pr, ot, sg = offsets["primary"], offsets["other"], offsets["sign"]
    ax, ay, az = anchor["x"], anchor["y"], anchor["z"]
    cfg = {
        "run_id": run_id,
        "seed": seed,
        "world": "world",
        "difficulty": difficulty,
        "base_anchor": anchor,
        "system_chest_at": {
            "x": ax + pr["dx"],
            "y": ay + pr["dy"],
            "z": az + pr["dz"],
        },
        "system_chest_other": {
            "x": ax + ot["dx"],
            "y": ay + ot["dy"],
            "z": az + ot["dz"],
        },
        "system_chest_sign": {
            "x": ax + sg["dx"],
            "y": ay + sg["dy"],
            "z": az + sg["dz"],
        },
        "started_at": ctx["started_at"],
        "genesis_version": git_short_sha(),
    }
    save_config(cfg)
    write_active_run(run_id)
    return cfg


def _archive_if_exists(path: Path, run_id: str) -> None:
    if not path.exists():
        return
    dest = run_dir(run_id) / "archived" / path.name
    shutil.copy2(path, dest)


def archive_run_state(run_id: str) -> None:
    """Snapshot + WIPE state so the next render lands on a truly clean slate.

    Previously only copied to archive/, leaving the live kanban DB intact —
    so the genesis cards got mixed with whatever was on the board pre-run.
    Now: copy then remove the live DB (board is recreated empty in
    `reinit_kanban_board`). Locations-*.json get the same treatment because
    bot-side state from the wrecked world is meaningless in a fresh world.
    """
    arch = ensure_run_layout(run_id) / "archived"
    if KANBAN_DB.exists():
        shutil.copy2(KANBAN_DB, arch / "kanban.db")
    for p in DATA_DIR.glob("locations-*.json"):
        shutil.copy2(p, arch / p.name)
    for name in ("base-goals.yaml", "regions-world.json"):
        p = DATA_DIR / name
        if p.exists():
            shutil.copy2(p, arch / name)
    plan = DATA_DIR / "ops" / "plans" / "hut1-guard-tower-plan.json"
    if plan.exists():
        shutil.copy2(plan, arch / plan.name)

    # Now wipe live state. Each removal is per-run; the archive above is the
    # only recovery path.
    if KANBAN_DB.exists():
        KANBAN_DB.unlink()
    for p in DATA_DIR.glob("locations-*.json"):
        # Keep the template (data/locations.json without per-bot suffix) but
        # remove all per-bot + shared (locations-base.json) so the fresh
        # world starts with zero marks.
        p.unlink()


def reinit_kanban_board() -> None:
    """Recreate the board after archive_run_state wiped the DB.

    `hermes kanban boards create <slug>` is idempotent for the slug but
    requires the parent directory to NOT contain a half-state. We unlinked
    the .db in archive_run_state; the slug dir itself still exists with
    workspaces and notify state — that's fine, board create will rebuild
    only the missing schema.
    """
    if GENESIS_DRY_RUN:
        return
    proc = _run(
        ["hermes", "kanban", "boards", "create", BOARD],
        timeout=30,
    )
    if proc.returncode != 0:
        # If the board record survived (only the DB was removed), `create`
        # may complain "already exists" — that's the desired end state, so
        # treat as success when the DB file now exists.
        if KANBAN_DB.exists():
            return
        raise RuntimeError(
            f"kanban board create failed: {proc.stderr[:400]}"
        )


def reset_world(seed: int, *, world: str = "world") -> None:
    if world != "world":
        raise ValueError(f"refusing reset for world {world!r}")
    for bad in ("landfolk-test", "testflat", "nether", "the_end", "world_nether", "world_the_end"):
        if bad in world:
            raise ValueError(f"refusing reset for world {world!r}")

    if GENESIS_DRY_RUN:
        return

    ssh = MC_HOST_SSH
    compose = GENESIS_COMPOSE_FILE
    # The compose mounts ./data (relative to the compose file dir) into /data
    # inside the container. The actual host path is therefore
    # /opt/stacks/minecraft/data, and server.properties lives at
    # /opt/stacks/minecraft/data/server.properties — NOT next to compose.
    # GENESIS_WORLD_DATA defaults to /data/world which is the container path;
    # derive the host data dir from the compose file location.
    host_data_dir = f"$(dirname {compose})/data"
    host_world_dir = f"{host_data_dir}/world"
    host_props = f"{host_data_dir}/server.properties"

    # Previous version used `docker run -v minecraft_minecraft_data:/data alpine`
    # to wipe — that named volume doesn't exist (compose is a bind mount), so
    # docker silently created an empty one and rm -rf ran against nothing.
    # The real world was untouched. Now wipe via host filesystem directly,
    # which is legitimate because the bind mount makes the host path
    # authoritative.
    # The SSH script BLOCKS until the container reports `healthy` — itzg
    # images ship a healthcheck that succeeds only after the MC server's
    # full init (level prep + plugin enable). Previous awk-on-docker-logs
    # variant hit shell-quoting issues; healthcheck polling is simpler and
    # observable from outside.
    script = (
        f"set -e; "
        f"sudo docker compose -f {compose} stop minecraft; "
        f"sudo rm -rf {host_world_dir} {host_world_dir}_nether {host_world_dir}_the_end; "
        f"sudo touch {host_props}; "
        f"if sudo grep -q '^level-seed=' {host_props}; then "
        f"  sudo sed -i 's/^level-seed=.*/level-seed={seed}/' {host_props}; "
        f"else "
        f"  echo 'level-seed={seed}' | sudo tee -a {host_props} >/dev/null; "
        f"fi; "
        # spawn-radius=0 forces players (and bots) to spawn AT exactly the
        # worldspawn coord set by `setworldspawn` in the probe, rather than
        # at a random offset 0-32 blocks away under Paper's safe-spawn algo.
        # Combined with the probe placing worldspawn at the base anchor,
        # this means bot reconnects land right at the base.
        f"if sudo grep -q '^spawn-radius=' {host_props}; then "
        f"  sudo sed -i 's/^spawn-radius=.*/spawn-radius=0/' {host_props}; "
        f"else "
        f"  echo 'spawn-radius=0' | sudo tee -a {host_props} >/dev/null; "
        f"fi; "
        f"sudo docker compose -f {compose} up -d minecraft; "
        f"echo '[genesis] waiting for healthcheck...'; "
        f"for i in $(seq 1 90); do "
        f"  s=$(sudo docker inspect minecraft --format '{{{{.State.Health.Status}}}}' 2>/dev/null || echo unknown); "
        f"  if [ \"$s\" = healthy ]; then echo '[genesis] healthy'; break; fi; "
        f"  sleep 2; "
        f"done; "
        f"final=$(sudo docker inspect minecraft --format '{{{{.State.Health.Status}}}}' 2>/dev/null || echo unknown); "
        f"if [ \"$final\" != healthy ]; then echo \"ERROR: status=$final after 180s\" >&2; exit 1; fi"
    )
    proc = _run(["ssh", "-n", ssh, script], timeout=360)
    if proc.returncode != 0:
        raise RuntimeError(f"world reset failed: {proc.stderr[:800]}\n{proc.stdout[:400]}")

    # PaperMCP plugin loads AFTER the "Done" line — give it a brief poll to
    # finish its init + start its WebSocket listener. The TCP socket alone
    # isn't sufficient (docker-proxy accepts before the plugin binds), so
    # we attempt a real WebSocket open + auth handshake against the bot
    # configured host.
    _wait_for_papermcp_ready(timeout_sec=60)


def _wait_for_papermcp_ready(*, timeout_sec: int = 60) -> None:
    """Open + close a WebSocket to PaperMCP until the handshake succeeds.

    The TCP socket on 25577 starts accepting as soon as the container's
    docker-proxy binds the port — before PaperMCP itself is listening
    internally. A successful WS upgrade is the canonical readiness signal.
    """
    import socket

    host = MC_HOST_SSH if "." in MC_HOST_SSH else f"{MC_HOST_SSH}.local"
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout_sec:
        try:
            with socket.create_connection((host, 25577), timeout=2) as s:
                # Minimal HTTP upgrade probe — if PaperMCP is up, the server
                # responds with a 101 or 400. If only docker-proxy is bound,
                # the read times out / connection closes.
                s.send(
                    b"GET / HTTP/1.1\r\n"
                    b"Host: " + host.encode() + b"\r\n"
                    b"Upgrade: websocket\r\n"
                    b"Connection: Upgrade\r\n"
                    b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                    b"Sec-WebSocket-Version: 13\r\n\r\n"
                )
                s.settimeout(2)
                data = s.recv(64)
                if b"HTTP/" in data:
                    return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError(f"PaperMCP not WS-ready within {timeout_sec}s")


def probe_base_anchor(*, timeout_sec: int = 90) -> dict[str, int]:
    """Build B probe — best-effort locate + spiral; falls back to spawn area."""
    t0 = time.monotonic()
    candidates: list[tuple[int, int, int]] = []
    for biome in ("minecraft:plains", "minecraft:forest", "minecraft:savanna"):
        try:
            out = rcon(f"locate biome {biome}", quiet=True)
            m = re.search(r"(-?\d+)[^\d]+(-?\d+)", out)
            if m:
                candidates.append((int(m.group(1)), 64, int(m.group(2))))
        except Exception:
            continue
    if not candidates:
        candidates.append((0, 64, 0))

    for cx, cy, cz in candidates:
        if time.monotonic() - t0 > timeout_sec:
            break
        for r in range(0, 32, 4):
            for dx in range(-r, r + 1, 4):
                for dz in range(-r, r + 1, 4):
                    x, z = cx + dx, cz + dz
                    y = 64
                    if _spot_solid_8x8(x, y, z):
                        _finalize_anchor(x, y, z)
                        return {"x": x, "y": y, "z": z}
    x, y, z = candidates[0]
    _finalize_anchor(x, y, z)
    return {"x": x, "y": y, "z": z}


def _spot_solid_8x8(x: int, y: int, z: int) -> bool:
    try:
        for dx in range(8):
            for dz in range(8):
                out = rcon(
                    f"execute positioned {x+dx} {y} {z+dz} if block ~ ~ ~ minecraft:water run say HIT",
                    quiet=True,
                )
                if "HIT" in out:
                    return False
        return True
    except Exception:
        return False


def _finalize_anchor(x: int, y: int, z: int) -> None:
    # Forceload + sign only — worldspawn is set by apply_worldspawn() so it
    # also runs on --keep-world (which skips this probe path entirely).
    rcon(f"forceload add {x >> 4} {z >> 4}", quiet=True)
    try:
        rcon(
            f'setblock {x} {y+1} {z} oak_sign[rotation=0]{{front_text:{{messages:[\'{{"text":"genesis_anchor"}}\']}}}}',
            quiet=True,
        )
    except Exception:
        pass


def apply_worldspawn(anchor: dict[str, int]) -> None:
    """Set MC worldspawn AND every connected player's per-player spawn to the genesis anchor.

    Runs on every new-run regardless of --keep-world. Two commands:
      1. `setworldspawn` — the world-wide fallback spawn used when a player
         has no per-player spawn set (no bed, no /spawnpoint).
      2. `spawnpoint @a <x> <y> <z>` — pins the per-player spawn for every
         currently-connected player. Paper saves first-connect position as
         a per-player spawn, which then overrides worldspawn on death.
         Without this, mason 2026-05-27 died near a lethal terrain feature
         and respawned at his stale per-player spawn (354,63,-592) — INSIDE
         stone — and re-died on suffocation in a loop until /kill +
         operator tp recovered him.
    """
    if GENESIS_DRY_RUN:
        return
    x, y, z = anchor["x"], anchor["y"], anchor["z"]
    rcon(f"setworldspawn {x} {y} {z}", quiet=True)
    # @a targets all online players. If no players are online yet (apply
    # runs before landfolk_start), the selector matches zero entities and
    # the command is a no-op — that's fine. After landfolk_start, the
    # bots are connected and their spawns get pinned on the next call.
    rcon(f"spawnpoint @a {x} {y} {z}", quiet=True)


def pin_all_player_spawns(anchor: dict[str, int]) -> None:
    """Re-pin every online player's spawn to the anchor.

    Called after landfolk_start so the bots (newly connected) get their
    per-player spawn pinned. apply_worldspawn runs BEFORE bots are up;
    this runs AFTER and only targets the spawnpoint command.
    """
    if GENESIS_DRY_RUN:
        return
    x, y, z = anchor["x"], anchor["y"], anchor["z"]
    rcon(f"spawnpoint @a {x} {y} {z}", quiet=True)


def system_chest_env_from_config(cfg: dict) -> dict[str, str]:
    env = {}
    other = cfg.get("system_chest_other") or cfg["system_chest_at"]
    sign = cfg.get("system_chest_sign") or {
        "x": cfg["system_chest_at"]["x"],
        "y": cfg["system_chest_at"]["y"] + 1,
        "z": cfg["system_chest_at"]["z"],
    }
    for role, coord in (
        ("PRIMARY", cfg["system_chest_at"]),
        ("OTHER", other),
        ("SIGN", sign),
    ):
        for axis, key in (("X", "x"), ("Y", "y"), ("Z", "z")):
            env[f"SYSTEM_CHEST_{role}_{axis}"] = str(int(coord[key]))
    return env


def seed_base_pad(cfg: dict, *, half: int = 4, pad_block: str = "cobblestone") -> None:
    """Lay a flat cobblestone pad centered on the base anchor.

    The pad becomes the floor of the Phase 1 shelter and the platform the
    system_chests sit on. Without it, Phase 1's [CONSTRUCT] cards have to
    grass-dig + level the foundation before placing chests — extra busywork
    on every fresh run and a frequent source of REGION_PROTECTED friction
    during early genesis development.

    Coord convention: `anchor_y` is the bot's FOOT y (the air block the
    bot occupies). The terrain surface block is therefore at `anchor_y-1`,
    and the pad replaces that surface layer. Chests at `anchor_y` (per
    system-chest-offsets dy=0) then sit ON the pad as normal blocks.

    Pad dimensions: (2*half + 1) × (2*half + 1) centered on the anchor.
    Default half=4 → 9×9 pad: 5×5 shelter footprint at the center, plus a
    2-block apron on every side. The 2-block apron is essential so chests
    can sit OUTSIDE the shelter walls (at offsets ±3 from anchor) while
    still resting on the pad surface. Pre-2026-05-27-7 used half=3 (7×7
    pad) which forced chests onto the shelter perimeter line — Mason
    couldn't tell wall from chest and the geometry got muddled.

    Chunk loading: a 7×7 pad straddles up to 4 chunks at typical anchors.
    Without forceload, the first `fill` lands only in chunks already
    resident → partial pads (observed g-2026-05-27-6: 16 of 49 blocks
    placed). We forceload every chunk the pad touches, fill, then verify
    the count matches the expected cell count and retry once on mismatch.
    """
    if GENESIS_DRY_RUN:
        return
    ax = cfg["base_anchor"]["x"]
    ay = cfg["base_anchor"]["y"]
    az = cfg["base_anchor"]["z"]
    x1, z1 = ax - half, az - half
    x2, z2 = ax + half, az + half
    pad_y = ay - 1
    expected_cells = (x2 - x1 + 1) * (z2 - z1 + 1)

    # 1. Force-load every chunk the pad covers (one `forceload add` per chunk;
    # the range form takes block-units in vanilla but command varies — the
    # per-chunk form is unambiguous).
    cx1, cx2 = x1 >> 4, x2 >> 4
    cz1, cz2 = z1 >> 4, z2 >> 4
    for cx in range(cx1, cx2 + 1):
        for cz in range(cz1, cz2 + 1):
            rcon(f"forceload add {cx} {cz}", quiet=True)
    time.sleep(0.5)  # give the server a beat to load chunks

    def _fill_pad() -> int:
        out = rcon(f"fill {x1} {pad_y} {z1} {x2} {pad_y} {z2} minecraft:{pad_block} replace", quiet=False)
        # Paper output: "Successfully filled N block(s)" or "No blocks were filled"
        m = re.search(r"Successfully filled (\d+) block", out)
        return int(m.group(1)) if m else 0

    filled = _fill_pad()
    if filled < expected_cells:
        # One retry — chunks may have needed a moment more.
        time.sleep(1.5)
        filled2 = _fill_pad()
        filled = max(filled, filled2)
    if filled < expected_cells:
        # Don't fail the whole run — the pad is mostly there, workers can
        # patch the remainder. Log the gap.
        out_path = REPO_ROOT / "data" / "genesis-runs" / cfg["run_id"] / "run.log"
        rec = {"ts": _iso_utc(), "step": "seed_base_pad_warn",
               "outcome": "partial", "duration_ms": 0,
               "notes": f"filled {filled}/{expected_cells} cells; chunk load may still be incomplete"}
        with out_path.open("a") as f:
            f.write(json.dumps(rec) + "\n")

    # Clear three Y-blocks above the pad so chests, doors, walls, and the
    # bot's body all have clean placement targets. Without this, tall_grass
    # or oak_leaves overhead break Phase 1 construct cards.
    for dy in (0, 1, 2):
        rcon(f"fill {x1} {ay+dy} {z1} {x2} {ay+dy} {z2} minecraft:air replace", quiet=True)


def seed_system_chest_place(cfg: dict) -> None:
    """Place chest blocks via rcon — runs BEFORE bots start (no bot needed)."""
    _run_system_chest(cfg, "place")


def seed_system_chest_fill(cfg: dict) -> None:
    """Stock chest via Steward — must run AFTER landfolk_start.

    system-chest.mjs fill uses Steward as a service bot (TP to chest, /give,
    mc deposit). Earlier genesis flow ran fill before landfolk_start and
    fetch-failed because Steward wasn't online yet.
    """
    _run_system_chest(cfg, "fill")


def _run_system_chest(cfg: dict, sub: str) -> None:
    env = system_chest_env_from_config(cfg)
    mjs = REPO_ROOT / "scripts" / "system-chest.mjs"
    proc = _run(["node", str(mjs), sub], timeout=180, env=env)
    if proc.returncode != 0:
        raise RuntimeError(f"system-chest.mjs {sub} failed: {proc.stderr[:500]}")


def seed_system_chest(cfg: dict) -> None:
    """Legacy combined call — kept for tests but new flow uses place/fill split."""
    seed_system_chest_place(cfg)
    seed_system_chest_fill(cfg)


def _kanban_create(
    *,
    title: str,
    body: str,
    assignee: str,
    status: str,
    parent_id: str | None = None,
) -> str:
    # hermes kanban create: title is POSITIONAL, no --status flag.
    # Cards default to `ready` on creation. todo/triage status is achieved via:
    #   - todo: parent linking (recompute_ready holds children until parent done)
    #   - triage: --triage flag (spec needs fleshing out before promotion)
    # The genesis template's initial_status: todo is informational — actual
    # gating relies on the epic parent chain (P2←P1, P3←P2, P4←P3).
    cmd = [
        "hermes",
        "kanban",
        "--board",
        BOARD,
        "create",
        title,
        "--body",
        body,
        "--assignee",
        assignee,
        "--json",
    ]
    if parent_id:
        cmd.extend(["--parent", parent_id])
    proc = _run(cmd, timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(f"kanban create failed: {proc.stderr[:400]}")
    data = json.loads(proc.stdout)
    tid = str(data.get("id") or data.get("task_id") or data.get("task", {}).get("id"))
    if not tid or tid == "None":
        # fallback parse
        m = re.search(r'"id"\s*:\s*"?(\d+)"?', proc.stdout)
        if m:
            tid = m.group(1)
        else:
            raise RuntimeError(f"could not parse task id from {proc.stdout[:200]}")
    return tid


def seed_starter_cards(run_id: str, ctx: dict[str, str]) -> dict[str, list[str]]:
    """Returns epic_ids and p1_card_ids."""
    ensure_run_layout(run_id)
    rendered = run_dir(run_id) / "rendered"
    epics_data = parse_yaml_simple(TEMPLATES_DIR / "phase-epics.yaml")
    cards_data = parse_yaml_simple(TEMPLATES_DIR / "phase1-cards.yaml")

    epic_ids: list[str] = []
    parent: str | None = None
    for epic in epics_data["epics"]:
        title = epic["title"]
        body = substitute(epic.get("body", ""), ctx)
        status = epic.get("initial_status", "todo")
        eid = _kanban_create(
            title=title,
            body=body,
            assignee=epic["assignee"],
            status=status,
            parent_id=parent,
        )
        epic_ids.append(eid)
        parent = eid
        (rendered / f"epic-{epic['phase']}.txt").write_text(f"{title}\n\n{body}\n")

    p1_ids: list[str] = []
    for card in cards_data["cards"]:
        title = card["title"]
        body = substitute(card.get("body", ""), ctx)
        status = card.get("initial_status", "ready")
        cid = _kanban_create(
            title=title,
            body=body,
            assignee=card["assignee"],
            status=status,
            parent_id=None,
        )
        p1_ids.append(cid)
        (rendered / f"p1-{title[:20]}.txt").write_text(f"{title}\n\n{body}\n")

    meta = {"epic_ids": epic_ids, "p1_card_ids": p1_ids}
    (run_dir(run_id) / "kanban-seed.json").write_text(json.dumps(meta, indent=2) + "\n")
    return meta


def apply_difficulty(phase: str, cfg: dict) -> None:
    if cfg.get("difficulty"):
        return
    level = None
    if phase == "P3":
        level = "easy"
    elif phase == "P4":
        level = "normal"
    if level:
        rcon(f"difficulty {level}", quiet=True)


def lock_base_region_protect() -> None:
    """Flip `base` region from marker → protect after Phase 3 closes.

    Genesis ships `base` as a marker so workers can dig/place inside it
    during construction (P1 shelter, P2 supply pipelines, P3 tower).
    Once the tower and shelter are built (P3 → done), we want the base
    locked down so ad-hoc dig/place can't damage the structure. This
    function rewrites data/regions-world.json and reloads regions on
    every bot.
    """
    if GENESIS_DRY_RUN:
        return
    path = DATA_DIR / "regions-world.json"
    if not path.exists():
        return
    data = json.loads(path.read_text())
    changed = False
    for r in data.get("regions", []):
        if r.get("id") == "base" and r.get("intent") != "protect":
            r["intent"] = "protect"
            cap = r.setdefault("capabilities", {})
            cap["allow_ad_hoc_dig"] = False
            cap["allow_ad_hoc_place"] = False
            cap["allow_harvest"] = False
            r["updated"] = _iso_utc()
            r["notes"] = (r.get("notes") or "") + " | locked protect after P3 done"
            changed = True
    if not changed:
        return
    path.write_text(json.dumps(data, indent=2) + "\n")
    # Reload each bot's in-memory region cache so the protection takes
    # effect without a full bot restart.
    import urllib.request

    for port in (3001, 3002, 3003, 3004, 3005):
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/regions/reload",
                method="POST",
                data=b"",
                headers={"Content-Type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=3).read()
        except Exception:
            pass  # bot may be offline; next bot reconnect re-reads file


def _kanban_list() -> list[dict]:
    proc = _run(["hermes", "kanban", "--board", BOARD, "list", "--json"], timeout=30)
    if proc.returncode != 0:
        return []
    data = json.loads(proc.stdout)
    if isinstance(data, list):
        return data
    return data.get("tasks", data.get("items", []))


def check_phases(cfg: dict | None = None) -> dict[str, dict]:
    cfg = cfg or load_config()
    rules = parse_yaml_simple(TEMPLATES_DIR / "phase-checklists.yaml")
    results: dict[str, dict] = {}
    anchor = cfg["base_anchor"]

    loc_base = _load_json(DATA_DIR / "locations-base.json", default={})
    marks = loc_base if isinstance(loc_base, dict) else loc_base.get("marks", loc_base)
    mark_names = set()
    if isinstance(marks, dict):
        mark_names = set(marks.keys()) if marks else set()
    elif isinstance(marks, list):
        for m in marks:
            if isinstance(m, dict) and "name" in m:
                mark_names.add(m["name"])

    regions = _load_json(DATA_DIR / "regions-world.json", default={})
    region_list = regions.get("regions", [])

    inv = {}
    try:
        proc = _run([sys.executable, str(REPO_ROOT / "scripts" / "base-inventory.py"), "--json"], timeout=30)
        if proc.returncode == 0:
            inv = json.loads(proc.stdout)
    except Exception:
        pass

    tasks = _kanban_list()
    epic_status = {}
    for t in tasks:
        title = (t.get("title") or "")
        if title.startswith("[GENESIS:P"):
            epic_status[title.split("]")[0].replace("[GENESIS:", "")] = t.get("status")

    for phase_key, rule in rules.get("phases", {}).items():
        failures: list[str] = []
        if phase_key == "P1":
            if "base_anchor" not in mark_names and not any("base_anchor" in n for n in mark_names):
                failures.append("missing base_anchor mark")
            chest_n = sum(1 for n in mark_names if str(n).startswith("chest_"))
            if chest_n < rule.get("marks", {}).get("chest_marks_min", 4):
                failures.append(f"need {rule['marks']['chest_marks_min']} chest_* marks, have {chest_n}")
            shelter = next((r for r in region_list if r.get("id") == "shelter"), None)
            if not shelter:
                failures.append("missing shelter region")
            elif not shelter.get("capabilities", {}).get("allow_ad_hoc_place"):
                failures.append("shelter allow_ad_hoc_place false")
        elif phase_key == "P2":
            for res in rule.get("inventory", {}).get("resources", []):
                cur = (inv.get(res) or {}).get("current", 0)
                need = (inv.get(res) or {}).get("target_min", 9999)
                if cur < need:
                    failures.append(f"{res} {cur} < {need}")
            lt_n = sum(1 for n in mark_names if str(n).startswith("lt_"))
            if lt_n < rule.get("marks", {}).get("lt_prefix_min", 3):
                failures.append(f"lt_* marks {lt_n} < 3")
        elif phase_key == "P3":
            hut = next((r for r in region_list if r.get("id") == "hut1"), None)
            if not hut:
                failures.append("missing hut1 region")
        elif phase_key == "P4":
            lt_marks = [n for n in mark_names if str(n).startswith("lt_")]
            min_d = rule.get("marks", {}).get("min_distance_from_base_anchor", 1000)
            far = 0
            for name in lt_marks:
                coord = _mark_coord(marks, name)
                if coord and _dist(anchor, coord) >= min_d:
                    far += 1
            if far < rule.get("marks", {}).get("lt_poi_min", 3):
                failures.append(f"POI marks >= {min_d} blocks: {far} < 3")

        results[phase_key] = {"pass": len(failures) == 0, "failures": failures, "epic_status": epic_status.get(phase_key.replace("P", "P"))}

    return results


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return default


def _mark_coord(marks: Any, name: str) -> dict | None:
    if isinstance(marks, dict):
        m = marks.get(name)
        if isinstance(m, dict) and "x" in m:
            return m
    return None


def _dist(a: dict, b: dict) -> float:
    return ((a["x"] - b["x"]) ** 2 + (a["z"] - b["z"]) ** 2) ** 0.5


def start_phase_poller(run_id: str) -> None:
    poller = REPO_ROOT / "scripts" / "genesis-phase-poller.py"
    log = run_dir(run_id) / "poller.log"
    pid_file = run_dir(run_id) / "poller.pid"
    proc = subprocess.Popen(
        [sys.executable, str(poller), "--run-id", run_id],
        stdout=open(log, "a"),
        stderr=subprocess.STDOUT,
        cwd=REPO_ROOT,
    )
    pid_file.write_text(str(proc.pid))


def finalize_previous_run() -> None:
    prev = active_run_id()
    if not prev:
        return
    try:
        _run(
            [sys.executable, str(REPO_ROOT / "scripts" / "genesis-snapshot.py"), "--run-id", prev, "--label", "end"],
            timeout=120,
        )
        _write_digest(prev)
    except Exception:
        pass
    clear_active_run()


def _write_digest(run_id: str) -> None:
    d = run_dir(run_id)
    lines = [f"# Genesis run digest — {run_id}", ""]
    cfg = load_config(run_id)
    lines.append(f"- seed: {cfg.get('seed')}")
    lines.append(f"- started: {cfg.get('started_at')}")
    for label in ("start", "phase1", "phase2", "phase3", "phase4", "end"):
        snap = d / f"snapshot-{label}.json"
        if snap.exists():
            lines.append(f"- snapshot: {snap.name}")
    (d / "digest.md").write_text("\n".join(lines) + "\n")


def landfolk_stop() -> None:
    proc = _run([str(REPO_ROOT / "scripts" / "landfolk"), "stop"], timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(f"landfolk stop failed: {proc.stderr[:400]}")


def landfolk_start() -> None:
    proc = _run([str(REPO_ROOT / "scripts" / "landfolk"), "start"], timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(f"landfolk start failed: {proc.stderr[:400]}")


def capture_snapshot(label: str, run_id: str | None = None) -> Path:
    rid = run_id or active_run_id()
    if not rid:
        raise RuntimeError("no active run for snapshot")
    proc = _run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "genesis-snapshot.py"),
            "--run-id",
            rid,
            "--label",
            label,
        ],
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr[:500])
    return run_dir(rid) / f"snapshot-{label}.json"


def validate_difficulty(level: str | None) -> str | None:
    if level is None:
        return None
    if level not in DIFFICULTY_LEVELS:
        raise ValueError(f"--difficulty must be one of {sorted(DIFFICULTY_LEVELS)}")
    return level


def validate_label(label: str) -> str:
    if not LABEL_RE.match(label):
        raise ValueError("label must match [a-zA-Z0-9_-]+")
    return label


def archive_rescue(src: Path) -> Path:
    rid = active_run_id()
    if not rid:
        raise RuntimeError("no active run")
    dest = run_dir(rid) / "rescues" / src.name
    shutil.copy2(src, dest)
    return dest


def append_note(text: str) -> None:
    rid = active_run_id()
    if not rid:
        raise RuntimeError("no active run")
    p = run_dir(rid) / "notes.md"
    with p.open("a") as f:
        f.write(f"\n## {_iso_utc()}\n\n{text}\n")

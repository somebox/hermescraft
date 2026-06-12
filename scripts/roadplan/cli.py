"""`roadplan` CLI (§6).

Subcommands:
  ingest             Append mc JSON envelope(s) to the ledger.
  solve  --start --end
                     Run the K2 solver; write state.json.
  render [--solve --start --end]
                     ASCII overlay (K2's debugging eye, §8).

Ingest loud-failure contract (§8.0.3):
  Success prints exactly one line `ingested <N> cells` and exits 0.
  ALL OTHER cases — empty stdin, error envelope, malformed/partial JSON,
  no recognized cell payload — exit non-zero with diagnostic on stderr
  and NO `ingested` line. The contract is "exit ≠0 and no ingest line ⇒
  failure"; callers must rely on both signals.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .emit import (
    coarse_plan, confirm_blocks, refine_plan, sample_commands,
    allocate_waypoints,
)
from .ledger import (
    append_observation, append_samples, read_sample_cells, read_state,
    samples_for_solver, write_state,
)
from .preflight import cmd_preflight
from .refine import refine
from .solver import Route, render_ascii, solve
from .spec import load_spec


class IngestError(Exception):
    pass


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z")


def _xz(s):
    parts = s.split(",")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError(f"expected X,Z (got {s!r})")
    return (int(parts[0]), int(parts[1]))


def _parse_input(raw):
    """Accept one JSON object, a JSON array of envelopes, or JSONL.
    Raise IngestError on garbage/partial JSON."""
    raw = raw.strip()
    if not raw:
        raise IngestError("no envelope on stdin")
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as e_first:
        envs = []
        for i, line in enumerate(raw.splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                envs.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise IngestError(
                    f"malformed JSON (line {i}: {e.msg}; "
                    f"or single-object parse: {e_first.msg})") from e
        if not envs:
            raise IngestError("no parseable JSON found")
        return envs
    return obj if isinstance(obj, list) else [obj]


def _classify_envelope(env):
    """(kind, bot, payload) from one mc envelope. Raises IngestError on
    malformed / error envelopes (the loud-failure contract — an ok:false
    NO_TORCH_ANCHOR survey is the §11.1 route-quality alarm reaching the
    agent). Kinds:
      corridor_sample -> payload = cells[] [x, z, y, block_tag]
      survey_line     -> payload = data dict (runs/deficits/walkable/from/to)
      waypoint        -> payload = data dict (waypoint/position/torch_at)
    """
    if not isinstance(env, dict):
        raise IngestError("envelope is not a JSON object")
    if env.get("ok") is False:
        # mc emits two error shapes: nested {error:{code,message}} and flat
        # {error:"msg", code, error_type}. Handle both so the §11.1 alarm
        # (NO_TORCH_ANCHOR, INVENTORY_MISSING) reaches the agent loudly
        # rather than crashing ingest.
        err = env.get("error")
        if isinstance(err, dict):
            code = err.get("code") or env.get("code") or "?"
            msg = err.get("message") or "<no message>"
        else:
            code = env.get("code") or env.get("error_type") or "?"
            msg = err if isinstance(err, str) else "<no message>"
        raise IngestError(f"error envelope: {code}: {msg}")
    if env.get("ok") is not True:
        raise IngestError("envelope missing `ok: true`")
    data = env.get("data") or {}
    bot = env.get("bot") or data.get("bot")
    if data.get("envelope_schema") == "roadplan-survey/v1":
        return ("survey_line", bot, data)
    if isinstance(data.get("waypoint"), str) and data.get("torch_at"):
        return ("waypoint", bot, data)
    if isinstance(data.get("samples"), list):
        cells = []
        for s in data["samples"]:
            x, z = s.get("x"), s.get("z")
            y = s.get("surface_y")
            if y is None:
                y = s.get("block_y")
            if x is None or z is None:
                raise IngestError(f"sample missing x/z: {s!r}")
            cells.append([x, z, y, s.get("block_name")])
        return ("corridor_sample", bot, cells)
    raise IngestError(
        "envelope has no recognized cell payload "
        "(need corridor_sample with full=true samples[], a survey_line, "
        "or a waypoint envelope)")


def _ingest_survey(ledger, bot, data):
    """Record a survey_line: observations.jsonl + state.json legs[]."""
    frm, to = data.get("from"), data.get("to")
    walkable = data.get("walkable")
    deficits = data.get("deficits") or []
    append_observation(ledger, {
        "bot": bot, "src": "survey_line",
        "from": frm, "to": to,
        "walkable": walkable, "deficits": deficits,
        "runs": data.get("runs") or [],
    })
    state = read_state(ledger)
    if state is not None and frm is not None and to is not None:
        legs = state.setdefault("legs", [])
        leg = next((L for L in legs
                    if L.get("from") == frm and L.get("to") == to), None)
        if leg is None:
            leg = {"from": frm, "to": to}
            legs.append(leg)
        leg.update({"status": "surveyed", "walkable": walkable,
                    "deficits": deficits, "surveyed_at": _now()})
        write_state(ledger, state)
    pct = "" if walkable is None else (" walkable" if walkable else " NOT walkable")
    return (f"survey ({frm[0]},{frm[1]})->({to[0]},{to[1]}){pct}, "
            f"{len(deficits)} deficit(s)") if frm and to else "survey"


def _ingest_waypoint(ledger, bot, data):
    """Confirm a waypoint: flip its state.json status + record torch_at."""
    name = data.get("waypoint")
    torch_at = data.get("torch_at") or {}
    state = read_state(ledger)
    confirmed_at = None
    if state is not None:
        for w in state.get("waypoints", []):
            if w.get("name") == name:
                w["status"] = "confirmed"
                w["torch_at"] = [torch_at.get("x"), torch_at.get("y"),
                                 torch_at.get("z")]
                confirmed_at = w["torch_at"]
                break
        write_state(ledger, state)
    where = (f" @ ({confirmed_at[0]},{confirmed_at[1]},{confirmed_at[2]})"
             if confirmed_at else "")
    return f"waypoint {name} confirmed{where}"


def cmd_ingest(args):
    if args.rcon:
        return _cmd_ingest_rcon(args)
    raw = (Path(args.file).read_text() if args.file else sys.stdin.read())
    try:
        envs = _parse_input(raw)
    except IngestError as e:
        print(f"ingest: {e}", file=sys.stderr)
        return 2
    sample_cells = 0
    notes = []
    for env in envs:
        try:
            kind, bot, payload = _classify_envelope(env)
        except IngestError as e:
            print(f"ingest: {e}", file=sys.stderr)
            return 2
        if kind == "corridor_sample":
            sample_cells += append_samples(args.ledger, kind, bot, payload)
        elif kind == "survey_line":
            notes.append(_ingest_survey(args.ledger, bot, payload))
        elif kind == "waypoint":
            notes.append(_ingest_waypoint(args.ledger, bot, payload))
    # Keep the corridor_sample line shape exact (existing contract); survey
    # and waypoint envelopes get their own `ingested <note>` line each.
    if sample_cells or not notes:
        print(f"ingested {sample_cells} cells")
    for note in notes:
        print(f"ingested {note}")
    return 0


def _cmd_ingest_rcon(args):
    """Phase 1: dev/test bypass — probe the world directly via RCON.

    Production wire is the corridor_sample pipe (§5.1); this exists so
    K2/K3 can be exercised end-to-end before `mc survey_line` lands.
    """
    if not args.bounds or args.y_hint is None:
        print("ingest --rcon: --bounds X1 Z1 X2 Z2 --y-hint Y required",
              file=sys.stderr)
        return 2
    try:
        from pathlib import Path as _P
        from mapcatalog.rcon_client import make_rcon
        from mapcatalog.server_config import load_server_config
        from .rcon_adapter import ingest_via_rcon
    except ImportError as e:
        print(f"ingest --rcon: mapcatalog not importable ({e})", file=sys.stderr)
        return 2
    server_cfg_path = _P(args.server_config) if args.server_config else \
        _P("server.local.yaml")
    if not server_cfg_path.exists():
        print(f"ingest --rcon: server config not found at {server_cfg_path}",
              file=sys.stderr)
        return 2
    cfg = load_server_config(server_cfg_path)
    world = args.world or getattr(cfg, "world", None) or "world"
    with make_rcon(cfg) as client:
        n, _ = ingest_via_rcon(client, world, tuple(args.bounds),
                               args.y_hint, args.ledger)
    print(f"ingested {n} cells")
    return 0


def _make_route_for_render(state):
    routes = (state or {}).get("routes") or []
    if not routes:
        return None
    r = routes[-1]
    return Route(
        waypoints=[tuple(w) for w in r.get("waypoints", [])],
        cells=[tuple(c) for c in r.get("cells", [])],
        cost=r.get("cost", 0.0),
        est_edits=r.get("est_edits", 0),
        construction=r.get("construction", []),
        natural_path=r.get("natural_path"),
        route_class=r.get("route_class", "natural"),
    )


def cmd_solve(args):
    spec = load_spec()
    samples = samples_for_solver(args.ledger)
    if not samples:
        print("solve: no samples in ledger", file=sys.stderr)
        return 2
    incumbent = None
    state = read_state(args.ledger)
    if state and state.get("routes"):
        incumbent = [tuple(c) for c in state["routes"][-1].get("cells", [])]
    route = solve(samples, args.start, args.end, spec, incumbent=incumbent)
    if route is None:
        print("solve: no route found", file=sys.stderr)
        return 2
    state = state or {"project": args.project or "unnamed", "spec_version": 1}
    state["endpoints"] = {"start": list(args.start), "end": list(args.end)}
    state.setdefault("routes", []).append({
        "solved_at": _now(),
        "waypoints": [list(w) for w in route.waypoints],
        "cells": [list(c) for c in route.cells],
        "cost": route.cost,
        "est_edits": route.est_edits,
        "construction": route.construction,
        "natural_path": route.natural_path,
        "route_class": route.route_class,
    })
    write_state(args.ledger, state)
    natural = "none" if route.natural_path is None \
        else f"{route.natural_path:.1f}"
    print(f"solve: {route.route_class} route, cost {route.cost:.1f}, "
          f"{route.est_edits} edits, natural={natural}, "
          f"{len(route.waypoints)} waypoints")
    return 0


def cmd_promote(args):
    """Promote a wp_* waypoint from a bot's private locations.json into the
    fleet-shared locations-base.json (§5.1). `roadplan` is the SOLE writer
    of the shared file; bots write only their private marks. This is the
    one step that closes the loop on the two-bot mark contract."""
    name = args.name
    if not name.startswith("wp_"):
        print(f"promote: {name!r} — only wp_* names go in locations-base.json",
              file=sys.stderr)
        return 2
    # Default to <repo-root>/data — NOT a CWD-relative "data", because the
    # bin/roadplan wrapper runs from scripts/, where ./data doesn't exist.
    data_dir = Path(args.data_dir) if args.data_dir is not None \
        else Path(__file__).resolve().parents[2] / "data"
    private = data_dir / f"locations-{args.bot.lower()}.json" if args.bot else None
    if private is None or not private.exists():
        # Fallback: scan all per-bot files; the most recent wins.
        candidates = sorted(data_dir.glob("locations-*.json"),
                            key=lambda p: p.stat().st_mtime, reverse=True)
        candidates = [p for p in candidates
                      if p.name != "locations-base.json"
                      and p.name != "locations.json"]
        if not candidates:
            print(f"promote: no per-bot locations files under {data_dir}",
                  file=sys.stderr)
            return 2
        private = candidates[0]
    try:
        priv_data = json.loads(private.read_text())
    except (OSError, json.JSONDecodeError) as e:
        print(f"promote: cannot read {private}: {e}", file=sys.stderr)
        return 2
    entry = priv_data.get(name)
    if not entry:
        print(f"promote: {name!r} not found in {private.name}", file=sys.stderr)
        return 2
    shared_path = data_dir / "locations-base.json"
    try:
        shared = json.loads(shared_path.read_text()) if shared_path.exists() else {}
    except (OSError, json.JSONDecodeError):
        shared = {}
    prev = shared.get(name)
    keep = {k: v for k, v in entry.items()
            if k in {"x", "y", "z", "saved", "updated", "category",
                     "note", "torch_at"}}
    shared[name] = keep
    tmp = shared_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(shared, indent=2, sort_keys=True) + "\n")
    tmp.replace(shared_path)
    if prev and (prev.get("x") != keep.get("x")
                 or prev.get("y") != keep.get("y")
                 or prev.get("z") != keep.get("z")):
        print(f"promoted {name}: ({prev['x']},{prev['y']},{prev['z']}) "
              f"→ ({keep['x']},{keep['y']},{keep['z']})")
    else:
        print(f"promoted {name} from {private.name} to locations-base.json: "
              f"({keep['x']},{keep['y']},{keep['z']})")
    return 0


def cmd_sample(args):
    """Emit the `mc` commands that acquire the sampling still needed for the
    start->end corridor (§6.1). stdout carries ONLY command lines; status
    goes to stderr so the agent loop is `while stdout: run; re-ask`."""
    spec = load_spec()
    ledger = args.ledger
    if args.refine:
        samples = samples_for_solver(ledger)
        if not samples:
            print("sample --refine: no samples yet — run coarse sample first",
                  file=sys.stderr)
            return 2
        route = _make_route_for_render(read_state(ledger))
        reqs = refine(samples, route, args.start, args.end, spec,
                      budget=args.budget)
        if not reqs:
            print("converged: refine empty — route stable", file=sys.stderr)
            return 0
        rects = refine_plan(reqs)
        print(f"refine: {len(reqs)} cells over {len(rects)} segment(s)",
              file=sys.stderr)
    else:
        swath = args.swath if args.swath is not None \
            else spec["path_width"] + 2 * spec["shoulder_width"]
        known = set(read_sample_cells(ledger).keys())
        rects = coarse_plan(known, args.start, args.end, swath)
        if not rects:
            print(f"converged: corridor covered ({len(known)} cells known)",
                  file=sys.stderr)
            return 0
        cells = sum((r["x2"] - r["x1"] + 1) * (r["z2"] - r["z1"] + 1)
                    for r in rects)
        print(f"sample: {len(rects)} segment(s), ~{cells} cells pending",
              file=sys.stderr)
    y = _corridor_y(args.y_hint, ledger)
    for line in sample_commands(rects, ledger, y):
        print(line)
    return 0


def _corridor_y(y_hint, ledger):
    """Approach Y for sampling moves: the explicit hint, else the median of
    known ledger elevations, else a sea-level default. goto_near tolerates
    a wrong Y, so this only needs to be in the right neighbourhood."""
    if y_hint is not None:
        return int(y_hint)
    ys = [y for (_xz), (y, _t) in read_sample_cells(ledger).items()
          if y is not None]
    if ys:
        ys.sort()
        return int(ys[len(ys) // 2])
    return 64


def cmd_confirm(args):
    """Emit per-waypoint confirm command blocks (§6.4): move + waypoint
    torch + leg survey + promote, for every waypoint not yet confirmed.
    Allocates wp_<n> names on first run (single namer, §6.3)."""
    state = read_state(args.ledger)
    if not state or not state.get("routes"):
        print("confirm: no solved route in state.json — run solve first",
              file=sys.stderr)
        return 2
    start = state.get("endpoints", {}).get("start")
    if start is None:
        print("confirm: state.json has no start endpoint", file=sys.stderr)
        return 2
    # A route that needs construction is not yet traversable — the bot can't
    # walk to its waypoints to light them, and a torch on an unbuilt span
    # would hang in mid-air. Confirm-and-light is the LAST step, after the
    # build role has cleared/built the route (§6.4, skill doctrine). Refuse
    # here and hand off, unless --force (rare: lighting a known-walkable
    # route the classifier over-flagged).
    route = state["routes"][-1]
    rclass = route.get("route_class", "natural")
    if rclass != "natural" and not args.force:
        edits = route.get("est_edits", 0)
        print(f"confirm: route needs construction "
              f"({rclass}, {edits} edit(s)) — build/clear it before lighting. "
              f"Hand the route to the build role (minecraft-roadbuilding); "
              f"confirm once it is walkable. (--force to override.)",
              file=sys.stderr)
        return 3
    state = allocate_waypoints(state, start)
    write_state(args.ledger, state)
    blocks, n_confirmed, n_total = confirm_blocks(
        state, start, args.bot, args.ledger)
    if not blocks:
        print(f"converged: {n_confirmed}/{n_total} waypoints confirmed",
              file=sys.stderr)
        return 0
    print(f"confirm: {len(blocks)} waypoint(s) pending "
          f"({n_confirmed}/{n_total} confirmed)", file=sys.stderr)
    for i, block in enumerate(blocks):
        if i:
            print()
        for line in block:
            print(line)
    return 0


def cmd_render(args):
    samples = samples_for_solver(args.ledger)
    if not samples:
        print("render: no samples in ledger", file=sys.stderr)
        return 2
    route = None
    if args.solve:
        if args.start is None or args.end is None:
            print("render: --solve requires --start X,Z and --end X,Z",
                  file=sys.stderr)
            return 2
        route = solve(samples, args.start, args.end, load_spec())
        if route is None:
            print("render: no route found", file=sys.stderr)
            return 2
    else:
        route = _make_route_for_render(read_state(args.ledger))
    sys.stdout.write(render_ascii(samples, route) + "\n")
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog="roadplan")
    p.add_argument("--ledger", default="data/runtime/roadplan",
                   type=Path,
                   help="Directory holding samples.jsonl and state.json")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("ingest",
                        help="Append mc JSON envelopes from stdin (or --file)")
    pi.add_argument("--file", help="Read envelope(s) from FILE instead of stdin")
    pi.add_argument("--rcon", action="store_true",
                    help="Phase-1 dev mode: probe the world via RCON instead "
                         "(needs --bounds and --y-hint).")
    pi.add_argument("--bounds", nargs=4, type=int,
                    metavar=("X1", "Z1", "X2", "Z2"),
                    help="--rcon: rectangle to probe")
    pi.add_argument("--y-hint", type=int,
                    help="--rcon: line elevation (block Y, not stand height)")
    pi.add_argument("--world",
                    help="--rcon: MC world name (default: cfg.world)")
    pi.add_argument("--server-config",
                    help="--rcon: server.local.yaml path (default: ./server.local.yaml)")
    pi.set_defaults(func=cmd_ingest)

    ps = sub.add_parser("solve", help="Run the K2 solver, write state.json")
    ps.add_argument("--start", type=_xz, required=True, help="X,Z")
    ps.add_argument("--end", type=_xz, required=True, help="X,Z")
    ps.add_argument("--project", help="Project name (first solve only)")
    ps.set_defaults(func=cmd_solve)

    psa = sub.add_parser("sample",
                         help="Emit the mc commands that acquire corridor "
                              "samples still needed (§6.1). stdout=commands, "
                              "stderr=status; empty stdout = converged.")
    psa.add_argument("start", type=_xz, help="X,Z")
    psa.add_argument("end", type=_xz, help="X,Z")
    psa.add_argument("--swath", type=int,
                     help="Corridor width (default: path_width + 2*shoulder)")
    psa.add_argument("--y-hint", type=int,
                     help="Approx corridor elevation for approach moves "
                          "(default: ledger median, else 64). goto_near "
                          "tolerates error, so a rough value is fine.")
    psa.add_argument("--budget", type=int, default=32,
                     help="--refine: max cells requested per call (default 32)")
    psa.add_argument("--refine", action="store_true",
                     help="Target low-confidence route cells instead of the "
                          "coarse swath (needs a solved route in state.json)")
    psa.set_defaults(func=cmd_sample)

    pc = sub.add_parser("confirm",
                        help="Emit per-waypoint confirm blocks (move + torch + "
                             "leg survey + promote) for unconfirmed waypoints "
                             "(§6.4). Empty stdout = all confirmed.")
    pc.add_argument("--bot", required=True,
                    help="Bot name driving the confirm (for promote)")
    pc.add_argument("--force", action="store_true",
                    help="Confirm even a construction route (default: refuse "
                         "non-natural routes — build them first)")
    pc.set_defaults(func=cmd_confirm)

    pr = sub.add_parser("render", help="ASCII terrain + route overlay")
    pr.add_argument("--solve", action="store_true",
                    help="Solve fresh from samples (needs --start/--end)")
    pr.add_argument("--start", type=_xz)
    pr.add_argument("--end", type=_xz)
    pr.set_defaults(func=cmd_render)

    pp = sub.add_parser("promote",
                        help="§5.1: copy a wp_* mark from a bot's private "
                             "locations file into the shared locations-base.json")
    pp.add_argument("name", help="Waypoint name (must start with wp_)")
    pp.add_argument("--bot", help="Bot name (lowercase) — picks "
                                  "data/locations-<bot>.json (default: latest)")
    pp.add_argument("--data-dir", default=None, type=Path,
                    help="Directory holding the locations files "
                         "(default: <repo-root>/data)")
    pp.set_defaults(func=cmd_promote)

    pf = sub.add_parser("preflight",
                        help="Toolchain readiness check (S4: bin wrapper, "
                             "Python imports, spec file, ledger writability, "
                             "worker env_passthrough)")
    pf.add_argument("--repo-root", help="Override repo root (default: auto)")
    pf.add_argument("--json", action="store_true",
                    help="Emit structured JSON instead of human lines")
    pf.set_defaults(func=cmd_preflight)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
